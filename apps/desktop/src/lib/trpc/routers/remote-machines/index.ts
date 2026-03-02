import { tmpdir } from "node:os";
import { join } from "node:path";
import { remoteMachines } from "@superset/local-db";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { localDb } from "main/lib/local-db";
import { SshConnectionManager } from "main/lib/ssh/connection-manager";
import { RemoteProvisioner } from "main/lib/ssh/provisioner";
import type { SshMachineConfig } from "main/lib/ssh/types";
import {
	REMOTE_DAEMON_SOCKET_NAME,
	REMOTE_SUPERSET_DIR,
} from "main/lib/ssh/types";
import { getWorkspaceRuntimeRegistry } from "main/lib/workspace-runtime";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import {
	createMachineSchema,
	type MachineStatus,
	machineIdSchema,
	type TestConnectionResult,
	updateMachineSchema,
} from "./schemas";

// =============================================================================
// Module-level State
// =============================================================================

// Connection state is extracted into a separate module so that other code
// (e.g., workspace-init) can import `getActiveConnection` without pulling in
// heavy tRPC / provisioner dependencies.
import { activeConnections } from "./connections";

export { getActiveConnection } from "./connections";

// =============================================================================
// Helpers
// =============================================================================

function getMachineOrThrow(id: string) {
	const machine = localDb
		.select()
		.from(remoteMachines)
		.where(eq(remoteMachines.id, id))
		.get();

	if (!machine) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: `Remote machine ${id} not found`,
		});
	}

	return machine;
}

function toSshConfig(machine: {
	id: string;
	name: string;
	host: string;
	port: number;
	username: string;
	identityFile: string | null;
	projectsDir: string;
}): SshMachineConfig {
	return {
		id: machine.id,
		name: machine.name,
		host: machine.host,
		port: machine.port,
		username: machine.username,
		identityFile: machine.identityFile ?? undefined,
		projectsDir: machine.projectsDir,
	};
}

function updateMachineStatus(
	id: string,
	status: "connected" | "disconnected" | "unknown",
) {
	localDb
		.update(remoteMachines)
		.set({
			status,
			...(status === "connected" ? { lastSeenAt: Date.now() } : {}),
		})
		.where(eq(remoteMachines.id, id))
		.run();
}

// =============================================================================
// Router
// =============================================================================

export const createRemoteMachinesRouter = () => {
	return router({
		// =====================================================================
		// Queries
		// =====================================================================

		/**
		 * List all remote machines.
		 */
		list: publicProcedure.query(() => {
			return localDb.select().from(remoteMachines).all();
		}),

		/**
		 * Get the connection status for a machine.
		 * Returns the DB status and the live SSH state if a connection exists.
		 */
		getStatus: publicProcedure
			.input(machineIdSchema)
			.query(({ input }): MachineStatus => {
				const machine = getMachineOrThrow(input.id);
				const conn = activeConnections.get(input.id);

				return {
					id: machine.id,
					status: machine.status,
					sshState: conn?.getState(),
				};
			}),

		// =====================================================================
		// CRUD Mutations
		// =====================================================================

		/**
		 * Create a new remote machine entry.
		 */
		create: publicProcedure.input(createMachineSchema).mutation(({ input }) => {
			const machine = localDb
				.insert(remoteMachines)
				.values({
					name: input.name,
					host: input.host,
					port: input.port,
					username: input.username,
					identityFile: input.identityFile ?? null,
					projectsDir: input.projectsDir,
				})
				.returning()
				.get();

			return machine;
		}),

		/**
		 * Update an existing remote machine.
		 */
		update: publicProcedure.input(updateMachineSchema).mutation(({ input }) => {
			getMachineOrThrow(input.id);

			// Build the set clause from non-undefined patch fields
			const set: Record<string, unknown> = {};
			if (input.patch.name !== undefined) set.name = input.patch.name;
			if (input.patch.host !== undefined) set.host = input.patch.host;
			if (input.patch.port !== undefined) set.port = input.patch.port;
			if (input.patch.username !== undefined)
				set.username = input.patch.username;
			if (input.patch.identityFile !== undefined)
				set.identityFile = input.patch.identityFile;
			if (input.patch.projectsDir !== undefined)
				set.projectsDir = input.patch.projectsDir;

			if (Object.keys(set).length === 0) {
				return { success: true };
			}

			localDb
				.update(remoteMachines)
				.set(set)
				.where(eq(remoteMachines.id, input.id))
				.run();

			return { success: true };
		}),

		/**
		 * Delete a remote machine.
		 * Disconnects if currently connected.
		 */
		delete: publicProcedure
			.input(machineIdSchema)
			.mutation(async ({ input }) => {
				// Disconnect first if active
				const conn = activeConnections.get(input.id);
				if (conn) {
					const registry = getWorkspaceRuntimeRegistry();
					registry.unregisterRemoteRuntime(input.id);
					await conn.disconnect();
					activeConnections.delete(input.id);
				}

				localDb
					.delete(remoteMachines)
					.where(eq(remoteMachines.id, input.id))
					.run();

				return { success: true };
			}),

		// =====================================================================
		// Connection Mutations
		// =====================================================================

		/**
		 * Test SSH connectivity and Node.js availability on the remote machine.
		 * Creates a temporary connection, checks Node, then disconnects.
		 */
		testConnection: publicProcedure
			.input(machineIdSchema)
			.mutation(async ({ input }): Promise<TestConnectionResult> => {
				const machine = getMachineOrThrow(input.id);
				const ssh = new SshConnectionManager(toSshConfig(machine));

				try {
					await ssh.connect();
					const provisioner = new RemoteProvisioner(ssh);
					const nodeVersion = await provisioner.checkNodeAvailable();
					return { success: true, nodeVersion };
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					return { success: false, error: message };
				} finally {
					await ssh.disconnect();
				}
			}),

		/**
		 * Connect to a remote machine.
		 *
		 * Full flow:
		 * 1. Look up machine config from DB
		 * 2. Create SshConnectionManager and connect via SSH
		 * 3. Check Node.js availability, provision if needed
		 * 4. Ensure the remote terminal-host daemon is running
		 * 5. Forward the remote daemon socket to a local temp path
		 * 6. Set up reverse port forward for hooks
		 * 7. Register the remote runtime in the workspace registry
		 * 8. Update machine status to 'connected'
		 */
		connect: publicProcedure
			.input(
				machineIdSchema.extend({
					hooksPort: z.number().int().min(1).max(65535).optional(),
				}),
			)
			.mutation(async ({ input }) => {
				const machine = getMachineOrThrow(input.id);

				// If already connected, return early
				const existingConn = activeConnections.get(input.id);
				if (existingConn?.getState() === "connected") {
					return { success: true, alreadyConnected: true };
				}

				// Clean up any stale connection
				if (existingConn) {
					await existingConn.disconnect();
					activeConnections.delete(input.id);
				}

				const sshConfig = toSshConfig(machine);
				const ssh = new SshConnectionManager(sshConfig);

				try {
					// Step 1: SSH connect
					await ssh.connect();

					// Step 2: Provision
					const provisioner = new RemoteProvisioner(ssh);
					await provisioner.checkNodeAvailable();
					if (await provisioner.needsProvisioning()) {
						await provisioner.provision();
					}

					// Step 3: Ensure daemon running
					await provisioner.ensureDaemonRunning();

					// Step 4: Forward remote daemon socket to local temp path
					const remoteDaemonSocket = `~/${REMOTE_SUPERSET_DIR}/${REMOTE_DAEMON_SOCKET_NAME}`;
					const localSocketPath = join(
						tmpdir(),
						`superset-remote-${input.id}.sock`,
					);
					await ssh.forwardUnixSocket(remoteDaemonSocket, localSocketPath);

					// Step 5: Set up reverse port forward for hooks
					if (input.hooksPort) {
						await ssh.setupReversePortForward(input.hooksPort);
					}

					// Step 6: Register remote runtime
					const registry = getWorkspaceRuntimeRegistry();
					registry.registerRemoteRuntime(input.id, localSocketPath);

					// Step 7: Store connection and update status
					activeConnections.set(input.id, ssh);
					updateMachineStatus(input.id, "connected");

					return { success: true, alreadyConnected: false };
				} catch (err) {
					// Clean up on failure
					await ssh.disconnect();
					updateMachineStatus(input.id, "disconnected");

					throw new TRPCError({
						code: "INTERNAL_SERVER_ERROR",
						message: `Failed to connect to ${machine.name}: ${
							err instanceof Error ? err.message : String(err)
						}`,
						cause: err,
					});
				}
			}),

		/**
		 * Disconnect from a remote machine.
		 *
		 * Flow:
		 * 1. Unregister remote runtime from workspace registry
		 * 2. Disconnect SSH
		 * 3. Update machine status to 'disconnected'
		 */
		disconnect: publicProcedure
			.input(machineIdSchema)
			.mutation(async ({ input }) => {
				const conn = activeConnections.get(input.id);

				if (conn) {
					const registry = getWorkspaceRuntimeRegistry();
					registry.unregisterRemoteRuntime(input.id);
					await conn.disconnect();
					activeConnections.delete(input.id);
				}

				updateMachineStatus(input.id, "disconnected");

				return { success: true };
			}),
	});
};
