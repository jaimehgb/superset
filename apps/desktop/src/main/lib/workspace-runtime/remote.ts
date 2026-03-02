/**
 * Remote Workspace Runtime
 *
 * This is the remote implementation of WorkspaceRuntime that wraps a
 * DaemonTerminalManager connected to a remote machine via SSH socket forwarding.
 *
 * The key insight: DaemonTerminalManager speaks NDJSON over a Unix socket.
 * SSH socket forwarding makes the remote socket appear as a local socket.
 * So we create a TerminalHostClient pointed at the forwarded path, inject it
 * into a new DaemonTerminalManager, and everything works with zero protocol changes.
 */

import { DaemonTerminalManager } from "main/lib/terminal/daemon/daemon-manager";
import {
	TerminalHostClient,
	type TerminalHostClientOptions,
} from "main/lib/terminal-host/client";
import type {
	TerminalCapabilities,
	TerminalManagement,
	TerminalRuntime,
	WorkspaceRuntime,
	WorkspaceRuntimeId,
} from "./types";

// =============================================================================
// Terminal Runtime Adapter (Remote)
// =============================================================================

/**
 * Adapts a remote DaemonTerminalManager to the TerminalRuntime interface.
 *
 * This adapter mirrors LocalTerminalRuntime exactly. The only difference is
 * how the backend is created: instead of using the singleton client,
 * RemoteTerminalRuntime creates its own TerminalHostClient with the
 * SSH-forwarded socket path and injects it into a new DaemonTerminalManager.
 */
class RemoteTerminalRuntime implements TerminalRuntime {
	private readonly backend: DaemonTerminalManager;

	readonly management: TerminalManagement;
	readonly capabilities: TerminalCapabilities;

	constructor(forwardedSocketPath: string) {
		const clientOptions: TerminalHostClientOptions = {
			socketPath: forwardedSocketPath,
			tokenPath: forwardedSocketPath.replace(".sock", ".token"),
			pidPath: forwardedSocketPath.replace(".sock", ".pid"),
			skipSpawn: true, // Don't try to spawn daemon locally
		};
		const client = new TerminalHostClient(clientOptions);
		this.backend = new DaemonTerminalManager(client, { remote: true });

		// Remote terminals are persistent and support cold restore.
		// Scrollback is written to local disk by the HistoryManager in the
		// Electron main process, so cold restore works without reading remote
		// files — identical to the local path.
		this.capabilities = {
			persistent: true,
			coldRestore: true,
		};

		this.management = {
			listSessions: () => this.backend.listDaemonSessions(),
			killAllSessions: () => this.backend.forceKillAll(),
			resetHistoryPersistence: () => this.backend.resetHistoryPersistence(),
		};
	}

	// ===========================================================================
	// Session Operations (delegate to backend)
	// ===========================================================================

	createOrAttach: TerminalRuntime["createOrAttach"] = (params) => {
		return this.backend.createOrAttach(params);
	};

	write: TerminalRuntime["write"] = (params) => {
		return this.backend.write(params);
	};

	resize: TerminalRuntime["resize"] = (params) => {
		return this.backend.resize(params);
	};

	signal: TerminalRuntime["signal"] = (params) => {
		return this.backend.signal(params);
	};

	kill: TerminalRuntime["kill"] = (params) => {
		return this.backend.kill(params);
	};

	detach: TerminalRuntime["detach"] = (params) => {
		return this.backend.detach(params);
	};

	clearScrollback: TerminalRuntime["clearScrollback"] = (params) => {
		return this.backend.clearScrollback(params);
	};

	ackColdRestore: TerminalRuntime["ackColdRestore"] = (paneId) => {
		return this.backend.ackColdRestore(paneId);
	};

	getSession: TerminalRuntime["getSession"] = (paneId) => {
		return this.backend.getSession(paneId);
	};

	// ===========================================================================
	// Workspace Operations (delegate to backend)
	// ===========================================================================

	killByWorkspaceId: TerminalRuntime["killByWorkspaceId"] = (workspaceId) => {
		return this.backend.killByWorkspaceId(workspaceId);
	};

	getSessionCountByWorkspaceId: TerminalRuntime["getSessionCountByWorkspaceId"] =
		(workspaceId) => {
			return this.backend.getSessionCountByWorkspaceId(workspaceId);
		};

	refreshPromptsForWorkspace: TerminalRuntime["refreshPromptsForWorkspace"] = (
		workspaceId,
	) => {
		return this.backend.refreshPromptsForWorkspace(workspaceId);
	};

	// ===========================================================================
	// Event Source (delegate to backend EventEmitter)
	// ===========================================================================

	// EventEmitter methods - delegate to backend
	// Use method syntax to preserve `this` return type correctly
	on(event: string | symbol, listener: (...args: unknown[]) => void): this {
		this.backend.on(event, listener);
		return this;
	}

	off(event: string | symbol, listener: (...args: unknown[]) => void): this {
		this.backend.off(event, listener);
		return this;
	}

	once(event: string | symbol, listener: (...args: unknown[]) => void): this {
		this.backend.once(event, listener);
		return this;
	}

	emit(event: string | symbol, ...args: unknown[]): boolean {
		return this.backend.emit(event, ...args);
	}

	addListener(
		event: string | symbol,
		listener: (...args: unknown[]) => void,
	): this {
		this.backend.addListener(event, listener);
		return this;
	}

	removeListener(
		event: string | symbol,
		listener: (...args: unknown[]) => void,
	): this {
		this.backend.removeListener(event, listener);
		return this;
	}

	removeAllListeners(event?: string | symbol): this {
		this.backend.removeAllListeners(event);
		return this;
	}

	setMaxListeners(n: number): this {
		this.backend.setMaxListeners(n);
		return this;
	}

	getMaxListeners(): number {
		return this.backend.getMaxListeners();
	}

	// biome-ignore lint/complexity/noBannedTypes: EventEmitter interface requires Function[]
	listeners(event: string | symbol): Function[] {
		return this.backend.listeners(event);
	}

	// biome-ignore lint/complexity/noBannedTypes: EventEmitter interface requires Function[]
	rawListeners(event: string | symbol): Function[] {
		return this.backend.rawListeners(event);
	}

	listenerCount(
		event: string | symbol,
		listener?: (...args: unknown[]) => void,
	): number {
		return this.backend.listenerCount(event, listener);
	}

	prependListener(
		event: string | symbol,
		listener: (...args: unknown[]) => void,
	): this {
		this.backend.prependListener(event, listener);
		return this;
	}

	prependOnceListener(
		event: string | symbol,
		listener: (...args: unknown[]) => void,
	): this {
		this.backend.prependOnceListener(event, listener);
		return this;
	}

	eventNames(): (string | symbol)[] {
		return this.backend.eventNames();
	}

	detachAllListeners(): void {
		this.backend.detachAllListeners();
	}

	// ===========================================================================
	// Cleanup
	// ===========================================================================

	cleanup: TerminalRuntime["cleanup"] = () => {
		return this.backend.cleanup();
	};
}

// =============================================================================
// Remote Workspace Runtime
// =============================================================================

/**
 * Remote workspace runtime implementation.
 *
 * This provides the WorkspaceRuntime interface for remote workspaces,
 * wrapping a DaemonTerminalManager connected via SSH socket forwarding.
 */
export class RemoteWorkspaceRuntime implements WorkspaceRuntime {
	readonly id: WorkspaceRuntimeId;
	readonly terminal: TerminalRuntime;
	readonly capabilities: WorkspaceRuntime["capabilities"];

	constructor(machineId: string, forwardedSocketPath: string) {
		this.id = `remote:${machineId}`;

		// Create terminal runtime adapter with SSH-forwarded socket
		this.terminal = new RemoteTerminalRuntime(forwardedSocketPath);

		// Aggregate capabilities
		this.capabilities = {
			terminal: this.terminal.capabilities,
		};
	}
}
