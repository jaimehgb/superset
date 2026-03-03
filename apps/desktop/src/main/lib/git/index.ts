import type { SshConnectionManager } from "main/lib/ssh/connection-manager";
import { LocalGitOperations } from "./local";
import { RemoteGitOperations } from "./remote";
import type { GitOperations } from "./types";

export { LocalGitOperations } from "./local";
export { RemoteGitOperations } from "./remote";
export type { GitOperations } from "./types";

const localGitOps = new LocalGitOperations();

/**
 * Returns the appropriate GitOperations implementation.
 *
 * - No SSH connection → local (simpleGit)
 * - SSH connection provided → remote (runs git commands over the connection)
 */
export function resolveGitOps(
	sshConnection?: SshConnectionManager | null,
): GitOperations {
	if (sshConnection) {
		return new RemoteGitOperations(sshConnection);
	}
	return localGitOps;
}
