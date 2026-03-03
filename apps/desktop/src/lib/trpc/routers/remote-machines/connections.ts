import type { SshConnectionManager } from "main/lib/ssh/connection-manager";

/**
 * Active SSH connections keyed by machine ID.
 * These persist for the lifetime of the main process.
 */
export const activeConnections = new Map<string, SshConnectionManager>();

/**
 * Retrieve the active SSH connection for a given machine ID.
 * Returns undefined if the machine is not currently connected.
 */
export function getActiveConnection(
	machineId: string,
): SshConnectionManager | undefined {
	return activeConnections.get(machineId);
}
