import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { remoteMachines } from "@superset/local-db";
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
import { activeConnections } from "./connections";

// =============================================================================
// Helpers
// =============================================================================

export function getMachineOrThrow(id: string) {
	const machine = localDb
		.select()
		.from(remoteMachines)
		.where(eq(remoteMachines.id, id))
		.get();

	if (!machine) {
		throw new Error(`Remote machine ${id} not found`);
	}

	return machine;
}

export function toSshConfig(machine: {
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

export function updateMachineStatus(
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
// connectMachine
// =============================================================================

/**
 * Connect to a remote machine programmatically.
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
 *
 * On failure: disconnects SSH, sets status to 'disconnected', re-throws.
 */
export async function connectMachine(
	machineId: string,
	options?: { hooksPort?: number },
): Promise<{ success: true; alreadyConnected: boolean }> {
	const machine = getMachineOrThrow(machineId);

	// If already connected, return early
	const existingConn = activeConnections.get(machineId);
	if (existingConn?.getState() === "connected") {
		console.log(`[remote] Already connected to ${machine.name}`);
		return { success: true, alreadyConnected: true };
	}

	// Clean up any stale connection
	if (existingConn) {
		await existingConn.disconnect();
		activeConnections.delete(machineId);
	}

	const sshConfig = toSshConfig(machine);
	const ssh = new SshConnectionManager(sshConfig);

	try {
		const t0 = performance.now();
		const elapsed = () => `${(performance.now() - t0).toFixed(0)}ms`;

		// Step 1: SSH connect
		console.log(`[remote] Connecting to ${machine.host}:${machine.port}...`);
		await ssh.connect();
		console.log(`[remote] [${elapsed()}] SSH connected`);

		const provisioner = new RemoteProvisioner(ssh);
		const supersetDir = REMOTE_SUPERSET_DIR;
		const socketName = REMOTE_DAEMON_SOCKET_NAME;

		// Step 2: Single SSH round-trip to gather all remote state at once.
		// Avoids 6 sequential exec() calls that each add network latency.
		const probeResult = await ssh.exec(
			[
				`echo "HOME=$HOME"`,
				`echo "NODE=$(node --version 2>/dev/null || echo missing)"`,
				`echo "PROV=$(cat ~/${supersetDir}/.version 2>/dev/null || echo missing)"`,
				`echo "DAEMON=$(cat ~/${supersetDir}/.daemon-version 2>/dev/null || echo missing)"`,
				`test -S ~/${supersetDir}/${socketName} && echo "SOCK=ready" || echo "SOCK=stopped"`,
				`echo "TOKEN=$(cat ~/${supersetDir}/terminal-host.token 2>/dev/null || echo missing)"`,
			].join(" && "),
		);
		console.log(`[remote] [${elapsed()}] Probe complete`);

		// Parse probe results
		const probeLines = probeResult.stdout.trim().split("\n");
		const probe: Record<string, string> = {};
		for (const line of probeLines) {
			const eqIdx = line.indexOf("=");
			if (eqIdx > 0) {
				probe[line.slice(0, eqIdx)] = line.slice(eqIdx + 1);
			}
		}

		const remoteHome = probe.HOME || "";
		const nodeVersion = probe.NODE || "missing";
		const provVersion = probe.PROV || "missing";
		const daemonVersion = probe.DAEMON || "missing";
		const daemonRunning = probe.SOCK === "ready";
		const remoteToken = probe.TOKEN || "missing";

		console.log(
			`[remote] Probe: node=${nodeVersion} prov=${provVersion} daemon=${daemonVersion} sock=${daemonRunning ? "ready" : "stopped"}`,
		);

		if (nodeVersion === "missing") {
			throw new Error(
				"Node.js is not installed on the remote machine. " +
					"Install Node.js (v18+) and make sure it is on the default PATH.",
			);
		}

		// Step 3: Provision shell dotfiles if needed (rare — only on first connect or version bump)
		if (provisioner.needsProvisioningForVersion(provVersion)) {
			console.log("[remote] Provisioning remote machine...");
			await provisioner.provision();
			console.log(`[remote] [${elapsed()}] Provisioning complete`);
		}

		// Step 4: Upload daemon bundle if hash changed
		const needsDaemon =
			provisioner.needsDaemonProvisioningForHash(daemonVersion);
		if (needsDaemon) {
			console.log("[remote] Uploading daemon bundle...");
			await provisioner.provisionDaemon();
			console.log(`[remote] [${elapsed()}] Daemon bundle uploaded`);
		} else {
			console.log("[remote] Daemon bundle unchanged, skipping upload");
		}

		// Step 5: Ensure daemon running (only restart if bundle changed)
		if (needsDaemon || !daemonRunning) {
			console.log("[remote] Starting daemon...");
			await provisioner.ensureDaemonRunning({ forceRestart: needsDaemon });
			console.log(`[remote] [${elapsed()}] Daemon is running`);
		} else {
			console.log("[remote] Daemon already running");
		}

		// Step 6: Forward socket + copy token + reverse port forward (parallelized)
		const remoteBase = `${remoteHome}/${supersetDir}`;
		const remoteDaemonSocket = `${remoteBase}/${socketName}`;
		const localSocketPath = join(tmpdir(), `spr-${machineId.slice(0, 8)}.sock`);

		console.log("[remote] Setting up forwarding...");
		const forwardPromises: Promise<unknown>[] = [
			ssh.forwardUnixSocket(remoteDaemonSocket, localSocketPath),
		];
		if (options?.hooksPort) {
			forwardPromises.push(ssh.setupReversePortForward(options.hooksPort));
		}
		await Promise.all(forwardPromises);
		console.log(`[remote] [${elapsed()}] Forwarding ready`);

		// Write token locally (already fetched in probe)
		if (remoteToken !== "missing") {
			const localTokenPath = localSocketPath.replace(".sock", ".token");
			writeFileSync(localTokenPath, remoteToken, { mode: 0o600 });
		} else {
			console.warn("[remote] Could not read remote auth token");
		}

		// Step 7: Register remote runtime
		const registry = getWorkspaceRuntimeRegistry();
		const runtime = registry.registerRemoteRuntime(machineId, localSocketPath);

		// Step 7b: Hydrate remote daemon session cache
		// Without this, daemonAliveSessionIds is empty and warm attach fails —
		// the renderer's persisted pane IDs won't match any known sessions.
		try {
			await runtime.terminal.management.listSessions();
			console.log(`[remote] Session cache hydrated for ${machine.name}`);
		} catch (err) {
			console.warn("[remote] Failed to hydrate session cache:", err);
			// Non-fatal: sessions will be created fresh instead of reattached
		}

		// Step 8: Store connection and update status
		activeConnections.set(machineId, ssh);
		updateMachineStatus(machineId, "connected");

		console.log(`[remote] [${elapsed()}] Connected to ${machine.name}`);
		return { success: true, alreadyConnected: false };
	} catch (err) {
		const errMsg = err instanceof Error ? err.message : String(err);
		console.error(`[remote] Connect failed: ${errMsg}`);

		// Clean up on failure
		await ssh.disconnect();
		updateMachineStatus(machineId, "disconnected");

		throw err;
	}
}
