export { LocalGitOperations } from "./local";
export { RemoteGitOperations } from "./remote";
export type { GitOperations } from "./types";

import { getActiveConnection } from "lib/trpc/routers/remote-machines/connections";
import { LocalGitOperations } from "./local";
import { RemoteGitOperations } from "./remote";
import type { GitOperations } from "./types";

/**
 * Resolve the correct GitOperations implementation for a project.
 *
 * - Local projects  → LocalGitOperations (uses simple-git)
 * - Remote projects → RemoteGitOperations (uses SSH)
 *
 * Returns `null` if the project is remote but the machine is not connected.
 */
export function resolveGitOps(
	remoteMachineId: string | null | undefined,
): GitOperations | null {
	if (!remoteMachineId) {
		return new LocalGitOperations();
	}

	const ssh = getActiveConnection(remoteMachineId);
	if (!ssh) {
		return null;
	}

	return new RemoteGitOperations(ssh);
}
