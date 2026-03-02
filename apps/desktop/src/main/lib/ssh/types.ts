export interface SshMachineConfig {
	id: string;
	name: string;
	host: string;
	port: number;
	username: string;
	identityFile?: string;
	projectsDir: string;
}

export interface SshExecResult {
	stdout: string;
	stderr: string;
	code: number;
}

export type SshConnectionState =
	| "disconnected"
	| "connecting"
	| "connected"
	| "reconnecting"
	| "error";

export interface SshConnectionEvents {
	stateChange: (state: SshConnectionState) => void;
	error: (error: Error) => void;
}

export const REMOTE_DAEMON_SOCKET_NAME = "terminal-host.sock";
export const REMOTE_SUPERSET_DIR = ".superset";
export const REMOTE_HOOK_PORT = 18787;
export const REMOTE_VERSION_FILE = ".version";
