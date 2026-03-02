import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import net from "node:net";
import type { SFTPWrapper } from "ssh2";
import { Client } from "ssh2";
import type {
	SshConnectionState,
	SshExecResult,
	SshMachineConfig,
} from "./types";
import { REMOTE_HOOK_PORT } from "./types";

const MAX_RECONNECT_DELAY_MS = 30_000;
const INITIAL_RECONNECT_DELAY_MS = 1_000;

export class SshConnectionManager extends EventEmitter {
	private client: Client;
	private config: SshMachineConfig;
	private state: SshConnectionState = "disconnected";
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectAttempt = 0;
	private localSocketPath: string | null = null;
	private reverseForwardPort: number | null = null;
	private socketServer: net.Server | null = null;

	constructor(config: SshMachineConfig) {
		super();
		this.config = config;
		this.client = new Client();
	}

	// ── Public API ────────────────────────────────────────────────

	async connect(): Promise<void> {
		if (this.state === "connected" || this.state === "connecting") {
			return;
		}

		this.setState("connecting");

		return new Promise<void>((resolve, reject) => {
			const onReady = () => {
				cleanup();
				this.reconnectAttempt = 0;
				this.setState("connected");
				this.attachCloseHandler();
				resolve();
			};

			const onError = (err: Error) => {
				cleanup();
				this.setState("error");
				this.emit("error", err);
				reject(err);
			};

			const cleanup = () => {
				this.client.removeListener("ready", onReady);
				this.client.removeListener("error", onError);
			};

			this.client.once("ready", onReady);
			this.client.once("error", onError);

			this.client.connect({
				host: this.config.host,
				port: this.config.port,
				username: this.config.username,
				privateKey: this.config.identityFile
					? readFileSync(this.config.identityFile)
					: undefined,
				agent: process.env.SSH_AUTH_SOCK,
				agentForward: true,
				keepaliveInterval: 15_000,
				keepaliveCountMax: 3,
			});
		});
	}

	async disconnect(): Promise<void> {
		this.clearReconnectTimer();
		this.closeSocketServer();

		this.localSocketPath = null;
		this.reverseForwardPort = null;

		if (this.state === "disconnected" || this.state === "error") {
			return;
		}

		return new Promise<void>((resolve) => {
			this.client.once("close", () => {
				this.setState("disconnected");
				resolve();
			});
			this.client.end();
		});
	}

	async exec(command: string): Promise<SshExecResult> {
		this.assertConnected();

		return new Promise<SshExecResult>((resolve, reject) => {
			this.client.exec(command, (err, stream) => {
				if (err) {
					reject(err);
					return;
				}

				let stdout = "";
				let stderr = "";

				stream.on("data", (data: Buffer) => {
					stdout += data.toString();
				});

				stream.stderr.on("data", (data: Buffer) => {
					stderr += data.toString();
				});

				stream.on("close", (code: number) => {
					resolve({ stdout, stderr, code: code ?? 0 });
				});

				stream.on("error", (streamErr: Error) => {
					reject(streamErr);
				});
			});
		});
	}

	async forwardUnixSocket(
		remotePath: string,
		localPath: string,
	): Promise<void> {
		this.assertConnected();

		// Clean up any existing socket server
		this.closeSocketServer();

		this.localSocketPath = localPath;

		return new Promise<void>((resolve, reject) => {
			const server = net.createServer((localConn) => {
				this.client.openssh_forwardOutStreamLocal(
					remotePath,
					(err, remoteStream) => {
						if (err) {
							localConn.destroy();
							return;
						}
						localConn.pipe(remoteStream).pipe(localConn);

						localConn.on("error", () => remoteStream.destroy());
						remoteStream.on("error", () => localConn.destroy());
						localConn.on("close", () => remoteStream.destroy());
						remoteStream.on("close", () => localConn.destroy());
					},
				);
			});

			server.on("error", (err) => {
				this.localSocketPath = null;
				reject(err);
			});

			server.listen(localPath, () => {
				this.socketServer = server;
				resolve();
			});
		});
	}

	async setupReversePortForward(localPort: number): Promise<number> {
		this.assertConnected();

		// Try fixed port first, then fall back to dynamic
		try {
			const port = await this.tryReverseForward(localPort, REMOTE_HOOK_PORT);
			this.reverseForwardPort = port;
			return port;
		} catch {
			// Fixed port unavailable — try dynamic allocation (port 0)
			const port = await this.tryReverseForward(localPort, 0);
			this.reverseForwardPort = port;
			return port;
		}
	}

	async getSftpClient(): Promise<SFTPWrapper> {
		this.assertConnected();

		return new Promise<SFTPWrapper>((resolve, reject) => {
			this.client.sftp((err, sftp) => {
				if (err) {
					reject(err);
					return;
				}
				resolve(sftp);
			});
		});
	}

	getState(): SshConnectionState {
		return this.state;
	}

	getLocalSocketPath(): string | null {
		return this.localSocketPath;
	}

	getReverseForwardPort(): number | null {
		return this.reverseForwardPort;
	}

	// ── Private helpers ───────────────────────────────────────────

	private setState(newState: SshConnectionState): void {
		if (this.state === newState) return;
		this.state = newState;
		this.emit("stateChange", newState);
	}

	private assertConnected(): void {
		if (this.state !== "connected") {
			throw new Error(`SSH not connected (current state: "${this.state}")`);
		}
	}

	private attachCloseHandler(): void {
		this.client.on("close", () => {
			if (this.state === "connected") {
				this.handleUnexpectedDisconnect();
			}
		});

		this.client.on("error", (err: Error) => {
			this.emit("error", err);
		});
	}

	private handleUnexpectedDisconnect(): void {
		this.setState("reconnecting");
		this.scheduleReconnect();
	}

	private scheduleReconnect(): void {
		this.clearReconnectTimer();

		const delay = Math.min(
			INITIAL_RECONNECT_DELAY_MS * 2 ** this.reconnectAttempt,
			MAX_RECONNECT_DELAY_MS,
		);
		this.reconnectAttempt++;

		this.reconnectTimer = setTimeout(() => {
			this.attemptReconnect();
		}, delay);
	}

	private async attemptReconnect(): Promise<void> {
		// Create a fresh client for the reconnection attempt
		this.client = new Client();

		try {
			await this.connect();
		} catch {
			// connect() already set state to "error" and emitted the error.
			// If we're still supposed to reconnect, schedule the next attempt.
			if (this.state !== "disconnected") {
				this.setState("reconnecting");
				this.scheduleReconnect();
			}
		}
	}

	private clearReconnectTimer(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}

	private closeSocketServer(): void {
		if (this.socketServer) {
			this.socketServer.close();
			this.socketServer = null;
		}
	}

	private tryReverseForward(
		localPort: number,
		remotePort: number,
	): Promise<number> {
		return new Promise<number>((resolve, reject) => {
			this.client.forwardIn("127.0.0.1", remotePort, (err, assignedPort) => {
				if (err) {
					reject(err);
					return;
				}

				// When remote port is 0, the server assigns a dynamic port
				const actualRemotePort = remotePort === 0 ? assignedPort : remotePort;

				// Handle incoming connections on the forwarded port
				this.client.on("tcp connection", (_info, accept, _reject) => {
					const channel = accept();
					const localConn = net.createConnection(
						{ port: localPort, host: "127.0.0.1" },
						() => {
							channel.pipe(localConn).pipe(channel);
						},
					);

					localConn.on("error", () => channel.close());
					channel.on("close", () => localConn.destroy());
					localConn.on("close", () => channel.close());
				});

				resolve(actualRemotePort);
			});
		});
	}
}
