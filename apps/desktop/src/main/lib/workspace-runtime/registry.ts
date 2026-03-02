/**
 * Workspace Runtime Registry
 *
 * Process-scoped registry for workspace runtime providers.
 * The registry is cached for the lifetime of the process.
 *
 * Runtime selection:
 * - By default, all workspaces use the LocalWorkspaceRuntime
 * - When a ProjectMachineLookup is set (via setProjectMachineLookup),
 *   getForWorkspaceId checks the workspace's project for a remoteMachineId
 *   and returns the corresponding remote runtime if registered
 * - getForMachineId provides direct machine-to-runtime lookup
 * - Local + remote workspaces can coexist in the same process
 */

import { RemoteRuntimeNotConnectedError } from "./errors";
import { LocalWorkspaceRuntime } from "./local";
import { RemoteWorkspaceRuntime } from "./remote";
import type {
	ProjectMachineLookup,
	WorkspaceRuntime,
	WorkspaceRuntimeRegistry,
} from "./types";

// =============================================================================
// Registry Implementation
// =============================================================================

/**
 * Default registry implementation.
 *
 * Selects the runtime for a workspace based on its project's remoteMachineId.
 * If a ProjectMachineLookup is set and the project has a registered remote
 * machine, returns the remote runtime. Otherwise returns the local runtime.
 */
class DefaultWorkspaceRuntimeRegistry implements WorkspaceRuntimeRegistry {
	private localRuntime: LocalWorkspaceRuntime | null = null;
	private remoteRuntimes: Map<string, RemoteWorkspaceRuntime> = new Map();
	private projectMachineLookup: ProjectMachineLookup | null = null;

	/**
	 * Get the runtime for a specific workspace.
	 *
	 * If a project machine lookup has been set, checks the workspace's project
	 * for a remoteMachineId and returns the corresponding remote runtime if
	 * registered. Throws RemoteRuntimeNotConnectedError if the workspace has
	 * a remote machine assigned but it is not connected.
	 */
	getForWorkspaceId(workspaceId: string): WorkspaceRuntime {
		if (this.projectMachineLookup) {
			const machineId = this.projectMachineLookup(workspaceId);
			if (machineId) {
				const remote = this.remoteRuntimes.get(machineId);
				if (remote) return remote;
				throw new RemoteRuntimeNotConnectedError(machineId);
			}
		}
		return this.getDefault();
	}

	/**
	 * Get the runtime for a specific machine ID.
	 *
	 * Returns the registered remote runtime if one exists for the given machineId,
	 * otherwise returns the default local runtime. Accepts null for convenience.
	 */
	getForMachineId(machineId: string | null): WorkspaceRuntime {
		if (machineId) {
			const remote = this.remoteRuntimes.get(machineId);
			if (remote) return remote;
		}
		return this.getDefault();
	}

	/**
	 * Set the function used to resolve a workspaceId to its project's remoteMachineId.
	 */
	setProjectMachineLookup(fn: ProjectMachineLookup): void {
		this.projectMachineLookup = fn;
	}

	/**
	 * Get the default runtime (for global/legacy endpoints).
	 *
	 * Returns the local runtime, lazily initialized.
	 * The runtime instance is cached for the lifetime of the process.
	 */
	getDefault(): WorkspaceRuntime {
		if (!this.localRuntime) {
			this.localRuntime = new LocalWorkspaceRuntime();
		}
		return this.localRuntime;
	}

	// ===========================================================================
	// Remote Runtime Management
	// ===========================================================================

	/**
	 * Register a remote runtime for a machine.
	 *
	 * If a runtime for this machineId already exists, returns the existing one.
	 * The forwardedSocketPath is the local path to the SSH-forwarded Unix socket
	 * that connects to the remote terminal host daemon.
	 */
	registerRemoteRuntime(
		machineId: string,
		forwardedSocketPath: string,
	): RemoteWorkspaceRuntime {
		const existing = this.remoteRuntimes.get(machineId);
		if (existing) return existing;
		const runtime = new RemoteWorkspaceRuntime(machineId, forwardedSocketPath);
		this.remoteRuntimes.set(machineId, runtime);
		return runtime;
	}

	/**
	 * Unregister a remote runtime for a machine.
	 *
	 * Cleans up the terminal runtime and removes the entry from the registry.
	 */
	unregisterRemoteRuntime(machineId: string): void {
		const runtime = this.remoteRuntimes.get(machineId);
		if (runtime) {
			runtime.terminal.cleanup();
			this.remoteRuntimes.delete(machineId);
		}
	}

	/**
	 * Get the remote runtime for a machine, if registered.
	 */
	getRemoteRuntime(machineId: string): RemoteWorkspaceRuntime | undefined {
		return this.remoteRuntimes.get(machineId);
	}
}

// =============================================================================
// Singleton Instance
// =============================================================================

let registryInstance: WorkspaceRuntimeRegistry | null = null;

/**
 * Get the workspace runtime registry.
 *
 * The registry is process-scoped and cached. Callers should capture it once
 * (e.g., when creating a tRPC router) and use it for the lifetime of the router.
 *
 * This design allows:
 * 1. Stable runtime instances (no re-creation on each call)
 * 2. Consistent event wiring (same backend for all listeners)
 * 3. Future per-workspace selection (local vs cloud)
 */
export function getWorkspaceRuntimeRegistry(): WorkspaceRuntimeRegistry {
	if (!registryInstance) {
		registryInstance = new DefaultWorkspaceRuntimeRegistry();
	}
	return registryInstance;
}

/**
 * Reset the registry (for testing only).
 * This should not be called in production code.
 */
export function resetWorkspaceRuntimeRegistry(): void {
	registryInstance = null;
}
