import { remoteMachines } from "@superset/local-db";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { localDb } from "main/lib/local-db";
import { SshConnectionManager } from "main/lib/ssh/connection-manager";
import { RemoteProvisioner } from "main/lib/ssh/provisioner";
import { getWorkspaceRuntimeRegistry } from "main/lib/workspace-runtime";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import {
	connectMachine,
	getMachineOrThrow,
	toSshConfig,
	updateMachineStatus,
} from "./connect-machine";
import { activeConnections } from "./connections";
import {
	createMachineSchema,
	type MachineStatus,
	machineIdSchema,
	type TestConnectionResult,
	updateMachineSchema,
} from "./schemas";

export { connectMachine } from "./connect-machine";
export { getActiveConnection } from "./connections";

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
					console.log(
						`[remote] Testing connection to ${machine.host}:${machine.port}...`,
					);
					await ssh.connect();
					console.log("[remote] Test SSH connected");
					const provisioner = new RemoteProvisioner(ssh);
					const nodeVersion = await provisioner.checkNodeAvailable();
					console.log(`[remote] Test complete — Node ${nodeVersion}`);
					return { success: true, nodeVersion };
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					console.error(`[remote] Test connection failed: ${message}`);
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
				try {
					return await connectMachine(input.id, {
						hooksPort: input.hooksPort,
					});
				} catch (err) {
					const errMsg = err instanceof Error ? err.message : String(err);
					throw new TRPCError({
						code: "INTERNAL_SERVER_ERROR",
						message: `Failed to connect: ${errMsg}`,
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
					console.log(`[remote] Disconnecting ${input.id}...`);
					const registry = getWorkspaceRuntimeRegistry();
					registry.unregisterRemoteRuntime(input.id);
					await conn.disconnect();
					activeConnections.delete(input.id);
					console.log("[remote] Disconnected");
				}

				updateMachineStatus(input.id, "disconnected");

				return { success: true };
			}),
	});
};
