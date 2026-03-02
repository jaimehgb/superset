/**
 * Pure logic helpers for the "Clone to" (Local / Remote) toggle in CloneRepoTab.
 *
 * Extracted to keep the component thin and enable direct unit testing
 * without React / tRPC dependencies.
 */

export type CloneLocation = "local" | "remote";

export interface RemoteMachine {
	id: string;
	name: string;
	projectsDir: string;
	status: string;
}

/**
 * Determine whether the remote toggle should be visible.
 * Only show if at least one remote machine is configured.
 */
export function shouldShowRemoteToggle(
	machines: RemoteMachine[] | undefined,
): boolean {
	return Array.isArray(machines) && machines.length > 0;
}

/**
 * Build the mutation input for cloneRepo.
 *
 * - "remote" mode: include `remoteMachineId`, omit `targetDirectory`
 *   (the server uses the machine's configured `projectsDir`).
 * - "local" mode: include `targetDirectory`, omit `remoteMachineId`.
 */
export function buildCloneMutationInput(
	url: string,
	parentDir: string,
	cloneLocation: CloneLocation,
	remoteMachine: RemoteMachine | undefined,
): { url: string; targetDirectory?: string; remoteMachineId?: string } {
	if (cloneLocation === "remote" && remoteMachine) {
		return {
			url: url.trim(),
			remoteMachineId: remoteMachine.id,
		};
	}
	return {
		url: url.trim(),
		targetDirectory: parentDir.trim(),
	};
}

/**
 * Validate clone inputs before submitting.
 * Returns an error message string, or `null` if valid.
 */
export function validateCloneInputs(
	url: string,
	parentDir: string,
	cloneLocation: CloneLocation,
	remoteMachine: RemoteMachine | undefined,
): string | null {
	if (!url.trim()) {
		return "Please enter a repository URL";
	}
	if (cloneLocation === "local" && !parentDir.trim()) {
		return "Please select a project location";
	}
	if (cloneLocation === "remote" && !remoteMachine) {
		return "No remote machine configured";
	}
	return null;
}
