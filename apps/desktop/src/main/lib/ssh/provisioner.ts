import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SUPERSET_DIR_NAME } from "shared/constants";
import type { SFTPWrapper } from "ssh2";
import type { SshConnectionManager } from "./connection-manager";
import {
	REMOTE_DAEMON_SOCKET_NAME,
	REMOTE_SUPERSET_DIR,
	REMOTE_VERSION_FILE,
} from "./types";

/**
 * Local directory containing the pre-built remote daemon bundle.
 * Produced by `scripts/package-remote-daemon.ts`.
 * Must match REMOTE_DAEMON_OUTPUT_DIR in that script.
 */
const DAEMON_BUNDLE_DIR = join(
	__dirname,
	"..",
	"..",
	"..",
	"..",
	"dist",
	"remote-daemon",
);

/** Bump when the set of provisioned files changes. */
const PROVISION_VERSION = "1";

/**
 * Provisions a remote machine with the Superset terminal-host daemon,
 * agent shims, and shell dotfiles.
 *
 * Uses `SshConnectionManager` for all remote operations:
 * - `exec()` for shell commands
 * - `getSftpClient()` for file uploads
 */
export class RemoteProvisioner {
	private ssh: SshConnectionManager;

	constructor(ssh: SshConnectionManager) {
		this.ssh = ssh;
	}

	// ── Public API ────────────────────────────────────────────────

	/**
	 * Check whether the remote machine needs (re-)provisioning.
	 * Returns `true` if `~/.superset/.version` is missing or does not match
	 * the current `PROVISION_VERSION`.
	 */
	async needsProvisioning(): Promise<boolean> {
		const result = await this.ssh.exec(
			`cat ~/${REMOTE_SUPERSET_DIR}/${REMOTE_VERSION_FILE} 2>/dev/null || echo "missing"`,
		);
		return result.stdout.trim() !== PROVISION_VERSION;
	}

	/**
	 * Verify that Node.js is available on the remote machine.
	 * Throws a descriptive error if it is not installed.
	 * @returns The version string (e.g. `"v20.11.0"`).
	 */
	async checkNodeAvailable(): Promise<string> {
		const result = await this.ssh.exec("node --version 2>/dev/null");
		if (result.code !== 0) {
			throw new Error(
				"Node.js is not installed on the remote machine. " +
					"Install Node.js (v18+) and make sure it is on the default PATH.",
			);
		}
		return result.stdout.trim();
	}

	/**
	 * Upload all Superset infrastructure files to the remote machine.
	 *
	 * 1. Creates the directory skeleton under `~/.superset/`
	 * 2. Uploads `bin/`, `hooks/`, `zsh/`, and `bash/` recursively via SFTP
	 * 3. Marks scripts executable
	 * 4. Writes the version marker so future calls to `needsProvisioning()`
	 *    return `false`.
	 */
	async provision(): Promise<void> {
		const sftp = await this.ssh.getSftpClient();
		const remoteBase = `~/${REMOTE_SUPERSET_DIR}`;

		try {
			// Create full directory structure in one shot
			await this.ssh.exec(
				`mkdir -p ${remoteBase}/{bin,hooks,zsh,bash,hooks/opencode/plugin}`,
			);

			// Mirror local ~/.superset/{bin,hooks,zsh,bash} to remote
			const localBase = join(homedir(), SUPERSET_DIR_NAME);

			await this.uploadDirectory(
				sftp,
				join(localBase, "bin"),
				`${remoteBase}/bin`,
			);
			await this.uploadDirectory(
				sftp,
				join(localBase, "hooks"),
				`${remoteBase}/hooks`,
			);
			await this.uploadDirectory(
				sftp,
				join(localBase, "zsh"),
				`${remoteBase}/zsh`,
			);
			await this.uploadDirectory(
				sftp,
				join(localBase, "bash"),
				`${remoteBase}/bash`,
			);

			// Make bin/* and hooks/*.sh executable
			await this.ssh.exec(
				`chmod +x ${remoteBase}/bin/* ${remoteBase}/hooks/*.sh 2>/dev/null || true`,
			);

			// Stamp version marker
			await this.ssh.exec(
				`echo "${PROVISION_VERSION}" > ${remoteBase}/${REMOTE_VERSION_FILE}`,
			);
		} finally {
			sftp.end();
		}
	}

	/**
	 * Ensure the terminal-host daemon is running on the remote machine.
	 *
	 * If the daemon socket already exists the method returns immediately.
	 * Otherwise it starts the daemon via `nohup` and polls for the socket
	 * for up to 5 seconds before throwing.
	 */
	async ensureDaemonRunning(): Promise<void> {
		const socketPath = `~/${REMOTE_SUPERSET_DIR}/${REMOTE_DAEMON_SOCKET_NAME}`;

		// Fast-path: daemon is already running
		const check = await this.ssh.exec(
			`test -S ${socketPath} && echo "running" || echo "stopped"`,
		);
		if (check.stdout.trim() === "running") {
			return;
		}

		// Start the daemon in the background
		await this.ssh.exec(
			`cd ~/${REMOTE_SUPERSET_DIR} && nohup node terminal-host.js > terminal-host.log 2>&1 &`,
		);

		// Poll for socket (50 x 100 ms = 5 s max)
		const maxAttempts = 50;
		const pollIntervalMs = 100;

		for (let i = 0; i < maxAttempts; i++) {
			const sockCheck = await this.ssh.exec(
				`test -S ${socketPath} && echo "ready"`,
			);
			if (sockCheck.stdout.trim() === "ready") {
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
		}

		throw new Error(
			"Remote terminal-host daemon failed to start within 5 seconds. " +
				`Check ~/${REMOTE_SUPERSET_DIR}/terminal-host.log on the remote machine for details.`,
		);
	}

	/**
	 * Upload the pre-built terminal-host daemon bundle to the remote machine
	 * and install native dependencies (node-pty, tree-kill).
	 *
	 * Files uploaded to `~/.superset/`:
	 * - `terminal-host.js`  -- daemon entry point
	 * - `pty-subprocess.js` -- PTY subprocess (spawned per session)
	 * - `package.json`      -- for `npm install` of native deps
	 *
	 * After uploading, runs `npm install` in `~/.superset/` to compile
	 * native addons for the remote machine's architecture.
	 */
	async provisionDaemon(): Promise<void> {
		const sftp = await this.ssh.getSftpClient();
		const remoteBase = `~/${REMOTE_SUPERSET_DIR}`;

		try {
			// Ensure remote directory exists
			await this.ssh.exec(`mkdir -p ${remoteBase}`);

			// Upload daemon bundle files
			const filesToUpload = [
				"terminal-host.js",
				"pty-subprocess.js",
				"package.json",
			];

			for (const file of filesToUpload) {
				await this.uploadFile(
					sftp,
					join(DAEMON_BUNDLE_DIR, file),
					`${remoteBase}/${file}`,
				);
			}

			// Install native dependencies on the remote machine
			await this.ssh.exec(`cd ${remoteBase} && npm install --production 2>&1`);
		} finally {
			sftp.end();
		}
	}

	// ── Private helpers ───────────────────────────────────────────

	/**
	 * Recursively upload a local directory to the remote machine.
	 * Silently skips if the local directory does not exist yet
	 * (e.g. before `setupAgentHooks` has been run).
	 */
	private async uploadDirectory(
		sftp: SFTPWrapper,
		localDir: string,
		remoteDir: string,
	): Promise<void> {
		let entries: string[];
		try {
			entries = readdirSync(localDir);
		} catch {
			// Directory may not exist locally yet — skip
			return;
		}

		for (const entry of entries) {
			const localPath = join(localDir, entry);
			const remotePath = `${remoteDir}/${entry}`;
			const stat = statSync(localPath);

			if (stat.isDirectory()) {
				await this.ssh.exec(`mkdir -p ${remotePath}`);
				await this.uploadDirectory(sftp, localPath, remotePath);
			} else {
				await this.uploadFile(sftp, localPath, remotePath);
			}
		}
	}

	/**
	 * Upload a single file via SFTP using `fastPut`.
	 */
	private uploadFile(
		sftp: SFTPWrapper,
		localPath: string,
		remotePath: string,
	): Promise<void> {
		return new Promise((resolve, reject) => {
			sftp.fastPut(localPath, remotePath, (err) => {
				if (err) {
					reject(err);
					return;
				}
				resolve();
			});
		});
	}
}
