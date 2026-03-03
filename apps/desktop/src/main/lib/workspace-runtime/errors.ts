/**
 * Thrown when a workspace's project has a remoteMachineId but the
 * corresponding remote runtime is not registered (machine not connected).
 */
export class RemoteRuntimeNotConnectedError extends Error {
	readonly machineId: string;

	constructor(machineId: string) {
		super(
			`Remote machine ${machineId} is not connected. The remote runtime is not registered.`,
		);
		this.name = "RemoteRuntimeNotConnectedError";
		this.machineId = machineId;
	}
}
