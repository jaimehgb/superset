import { remoteMachines } from "@superset/local-db";
import { eq } from "drizzle-orm";
import { connectMachine } from "lib/trpc/routers/remote-machines/connect-machine";
import { updateMachineStatus } from "lib/trpc/routers/remote-machines/connect-machine";
import { localDb } from "./local-db";

/**
 * Reconnect remote machines that were previously connected.
 *
 * On app restart, in-memory SSH connections are lost but the DB still has
 * `status = 'connected'`. This function attempts to re-establish those
 * connections sequentially (to avoid SSH agent overwhelm).
 *
 * Non-blocking: failures are logged and the machine status is set to
 * 'disconnected'. Does not throw.
 */
export async function reconnectRemoteMachines(): Promise<void> {
	const connectedMachines = localDb
		.select()
		.from(remoteMachines)
		.where(eq(remoteMachines.status, "connected"))
		.all();

	if (connectedMachines.length === 0) return;

	console.log(
		`[remote-reconnect] Found ${connectedMachines.length} machine(s) to reconnect`,
	);

	for (const machine of connectedMachines) {
		try {
			console.log(
				`[remote-reconnect] Reconnecting "${machine.name}" (${machine.id})...`,
			);
			await connectMachine(machine.id);
			console.log(
				`[remote-reconnect] Successfully reconnected "${machine.name}"`,
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(
				`[remote-reconnect] Failed to reconnect "${machine.name}": ${msg}`,
			);
			updateMachineStatus(machine.id, "disconnected");
		}
	}
}
