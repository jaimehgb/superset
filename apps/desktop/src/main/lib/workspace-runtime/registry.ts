/**
 * Workspace Runtime Registry
 *
 * Process-scoped registry for workspace runtime providers.
 * The registry is cached for the lifetime of the process.
 *
 * Current behavior:
 * - All workspaces use the LocalWorkspaceRuntime
 * - The runtime is selected once based on settings (requires restart to change)
 *
 * Future behavior (cloud readiness):
 * - Per-workspace selection based on workspace metadata (cloudWorkspaceId, etc.)
 * - Local + cloud workspaces can coexist
 */

import { LocalWorkspaceRuntime } from "./local";
import { RemoteWorkspaceRuntime } from "./remote";
import type { WorkspaceRuntime, WorkspaceRuntimeRegistry } from "./types";

// =============================================================================
// Registry Implementation
// =============================================================================

/**
 * Default registry implementation.
 *
 * Currently returns the same LocalWorkspaceRuntime for all workspaces.
 * The interface supports per-workspace selection for future cloud work.
 */
class DefaultWorkspaceRuntimeRegistry implements WorkspaceRuntimeRegistry {
	private localRuntime: LocalWorkspaceRuntime | null = null;
	private remoteRuntimes: Map<string, RemoteWorkspaceRuntime> = new Map();

	/**
	 * Get the runtime for a specific workspace.
	 *
	 * Currently always returns the local runtime.
	 * Future: will check workspace metadata to select local vs cloud.
	 */
	getForWorkspaceId(_workspaceId: string): WorkspaceRuntime {
		// Currently all workspaces use the local runtime
		// Future: check workspace metadata for cloudWorkspaceId to select cloud runtime
		return this.getDefault();
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
