import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
 * Locate the pre-built remote daemon bundle directory.
 * Produced by `scripts/package-remote-daemon.ts`.
 *
 * After Vite bundles the main process, __dirname might point to `dist/main/`
 * or `dist/main/chunks/` depending on code splitting. We check multiple
 * candidate paths and pick the first one that exists.
 */
function findDaemonBundleDir(): string {
	const candidates = [
		join(__dirname, "..", "remote-daemon"), // dist/main/ → dist/remote-daemon/
		join(__dirname, "..", "..", "remote-daemon"), // dist/main/chunks/ → dist/remote-daemon/
		join(__dirname, "remote-daemon"), // if __dirname IS dist/
	];

	for (const candidate of candidates) {
		if (existsSync(join(candidate, "terminal-host.js"))) {
			return candidate;
		}
	}

	// Fallback: log all attempted paths for debugging
	console.error("[provisioner] Cannot find daemon bundle. Tried:", candidates);
	console.error("[provisioner] __dirname =", __dirname);
	return candidates[0]!;
}

const DAEMON_BUNDLE_DIR = findDaemonBundleDir();

/** Files that make up the daemon bundle. */
const DAEMON_BUNDLE_FILES = [
	"terminal-host.js",
	"pty-subprocess.js",
	"package.json",
];

/**
 * Compute a short hash of the local daemon bundle files.
 * Used to skip re-uploading + npm install when nothing changed.
 */
function computeDaemonBundleHash(): string {
	const hash = createHash("sha256");
	for (const file of DAEMON_BUNDLE_FILES) {
		const filePath = join(DAEMON_BUNDLE_DIR, file);
		if (existsSync(filePath)) {
			hash.update(readFileSync(filePath));
		}
	}
	return hash.digest("hex").slice(0, 16);
}

const REMOTE_DAEMON_VERSION_FILE = ".daemon-version";

/** Bump when the set of provisioned files changes. */
const PROVISION_VERSION = "2";

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
	 * Check whether provisioning is needed given a pre-fetched version string.
	 * Used with the batched probe to avoid an extra SSH round-trip.
	 */
	needsProvisioningForVersion(remoteVersion: string): boolean {
		return remoteVersion !== PROVISION_VERSION;
	}

	/**
	 * Check whether daemon provisioning is needed given a pre-fetched hash.
	 * Used with the batched probe to avoid an extra SSH round-trip.
	 */
	needsDaemonProvisioningForHash(remoteHash: string): boolean {
		return remoteHash !== computeDaemonBundleHash();
	}

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
	 * When `forceRestart` is true, kills the existing daemon so it picks up
	 * the freshly uploaded bundle. When false, reuses the running daemon if
	 * the socket already exists.
	 */
	async ensureDaemonRunning(opts?: { forceRestart?: boolean }): Promise<void> {
		const socketPath = `~/${REMOTE_SUPERSET_DIR}/${REMOTE_DAEMON_SOCKET_NAME}`;

		if (opts?.forceRestart) {
			// Kill existing daemon so it picks up the freshly uploaded bundle.
			await this.ssh.exec(
				`pkill -f "node terminal-host.js" 2>/dev/null; rm -f ${socketPath}`,
			);
			// Brief pause for process cleanup
			await new Promise((resolve) => setTimeout(resolve, 200));
		} else {
			// If daemon is already running, return immediately
			const sockCheck = await this.ssh.exec(
				`test -S ${socketPath} && echo "ready"`,
			);
			if (sockCheck.stdout.trim() === "ready") {
				console.log("[provisioner] Daemon already running, reusing");
				return;
			}
		}

		// Start the daemon in the background.
		// SUPERSET_DAEMON_DIR tells session.ts where to find pty-subprocess.js
		// (Bun's bundler inlines __dirname as the build machine's path).
		await this.ssh.exec(
			`cd ~/${REMOTE_SUPERSET_DIR} && SUPERSET_DAEMON_DIR=$HOME/${REMOTE_SUPERSET_DIR} nohup node terminal-host.js > terminal-host.log 2>&1 &`,
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
	 * Check whether the remote daemon bundle needs re-uploading.
	 * Compares a hash of local bundle files against the remote marker.
	 */
	async needsDaemonProvisioning(): Promise<boolean> {
		const localHash = computeDaemonBundleHash();
		const result = await this.ssh.exec(
			`cat ~/${REMOTE_SUPERSET_DIR}/${REMOTE_DAEMON_VERSION_FILE} 2>/dev/null || echo "missing"`,
		);
		return result.stdout.trim() !== localHash;
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
		console.log("[provisioner] DAEMON_BUNDLE_DIR =", DAEMON_BUNDLE_DIR);

		// Verify local bundle exists
		for (const file of DAEMON_BUNDLE_FILES) {
			const localPath = join(DAEMON_BUNDLE_DIR, file);
			if (!existsSync(localPath)) {
				throw new Error(
					`Daemon bundle file not found: ${localPath}. ` +
						"Run 'bun run apps/desktop/scripts/package-remote-daemon.ts' first.",
				);
			}
		}

		// Resolve the remote home directory (SFTP doesn't expand ~)
		const homeResult = await this.ssh.exec("echo $HOME");
		const remoteHome = homeResult.stdout.trim();
		const remoteBase = `${remoteHome}/${REMOTE_SUPERSET_DIR}`;
		console.log("[provisioner] Remote base:", remoteBase);

		const sftp = await this.ssh.getSftpClient();

		try {
			// Ensure remote directory exists
			await this.ssh.exec(`mkdir -p ${remoteBase}`);

			// Upload daemon bundle files
			for (const file of DAEMON_BUNDLE_FILES) {
				const localPath = join(DAEMON_BUNDLE_DIR, file);
				const remotePath = `${remoteBase}/${file}`;
				console.log(`[provisioner] Uploading ${file}...`);
				await this.uploadFile(sftp, localPath, remotePath);
			}
			console.log("[provisioner] All files uploaded");

			// Install native dependencies on the remote machine
			console.log("[provisioner] Running npm install on remote...");
			const npmResult = await this.ssh.exec(
				`cd ${remoteBase} && npm install --production 2>&1`,
			);
			console.log(
				"[provisioner] npm install:",
				npmResult.stdout.trim().split("\n").pop(),
			);

			// Stamp daemon version so future connects can skip upload+install
			const localHash = computeDaemonBundleHash();
			await this.ssh.exec(
				`echo "${localHash}" > ${remoteBase}/${REMOTE_DAEMON_VERSION_FILE}`,
			);
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
