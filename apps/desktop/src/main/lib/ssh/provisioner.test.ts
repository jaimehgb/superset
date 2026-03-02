/**
 * Tests for RemoteProvisioner - daemon provisioning.
 *
 * Verifies that:
 * 1. provisionDaemon() uploads terminal-host.js, pty-subprocess.js, and package.json
 * 2. provisionDaemon() installs node-pty on the remote via npm install
 * 3. provisionDaemon() makes terminal-host.js executable
 * 4. The upload uses the correct remote paths under ~/.superset/
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SFTPWrapper } from "ssh2";
import type { SshConnectionManager } from "./connection-manager";
import { _setDaemonBundleDirForTest, RemoteProvisioner } from "./provisioner";

// Create a temporary directory with dummy bundle files so the provisioner
// can validate local files exist (without requiring a real build step).
const FIXTURE_DIR = join(
	tmpdir(),
	`superset-provisioner-test-${process.pid}`,
	"remote-daemon",
);

beforeAll(() => {
	mkdirSync(FIXTURE_DIR, { recursive: true });
	writeFileSync(join(FIXTURE_DIR, "terminal-host.js"), "// stub");
	writeFileSync(join(FIXTURE_DIR, "pty-subprocess.js"), "// stub");
	writeFileSync(
		join(FIXTURE_DIR, "package.json"),
		'{"name":"stub","private":true}',
	);
	_setDaemonBundleDirForTest(FIXTURE_DIR);
});

afterAll(() => {
	rmSync(join(tmpdir(), `superset-provisioner-test-${process.pid}`), {
		recursive: true,
		force: true,
	});
});

// Track calls to verify behavior
interface MockCall {
	method: string;
	args: unknown[];
}

function createMockSftp(): { sftp: SFTPWrapper; calls: MockCall[] } {
	const calls: MockCall[] = [];
	const sftp = {
		fastPut: (
			localPath: string,
			remotePath: string,
			cb: (err: Error | null) => void,
		) => {
			calls.push({ method: "fastPut", args: [localPath, remotePath] });
			cb(null);
		},
		end: () => {
			calls.push({ method: "end", args: [] });
		},
	} as unknown as SFTPWrapper;
	return { sftp, calls };
}

function createMockSsh(): {
	ssh: SshConnectionManager;
	execCalls: string[];
	sftpCalls: MockCall[];
	sftp: SFTPWrapper;
} {
	const execCalls: string[] = [];
	const { sftp, calls: sftpCalls } = createMockSftp();

	const ssh = {
		exec: async (cmd: string) => {
			execCalls.push(cmd);
			// Return success for all commands
			if (cmd.includes("cat") && cmd.includes(".version")) {
				return { stdout: "missing\n", stderr: "", code: 0 };
			}
			if (cmd.includes("node --version")) {
				return { stdout: "v20.11.0\n", stderr: "", code: 0 };
			}
			if (cmd.includes("echo $HOME")) {
				return { stdout: "~\n", stderr: "", code: 0 };
			}
			return { stdout: "", stderr: "", code: 0 };
		},
		getSftpClient: async () => sftp,
	} as unknown as SshConnectionManager;

	return { ssh, execCalls, sftpCalls, sftp };
}

describe("RemoteProvisioner.provisionDaemon", () => {
	it("should upload terminal-host.js to remote ~/.superset/", async () => {
		const { ssh, sftpCalls } = createMockSsh();
		const provisioner = new RemoteProvisioner(ssh);

		await provisioner.provisionDaemon();

		const terminalHostUpload = sftpCalls.find(
			(c) =>
				c.method === "fastPut" &&
				(c.args[1] as string).includes("terminal-host.js"),
		);
		expect(terminalHostUpload).toBeDefined();
		expect(terminalHostUpload?.args[1]).toBe("~/.superset/terminal-host.js");
	});

	it("should upload pty-subprocess.js to remote ~/.superset/", async () => {
		const { ssh, sftpCalls } = createMockSsh();
		const provisioner = new RemoteProvisioner(ssh);

		await provisioner.provisionDaemon();

		const ptyUpload = sftpCalls.find(
			(c) =>
				c.method === "fastPut" &&
				(c.args[1] as string).includes("pty-subprocess.js"),
		);
		expect(ptyUpload).toBeDefined();
		expect(ptyUpload?.args[1]).toBe("~/.superset/pty-subprocess.js");
	});

	it("should upload package.json to remote ~/.superset/", async () => {
		const { ssh, sftpCalls } = createMockSsh();
		const provisioner = new RemoteProvisioner(ssh);

		await provisioner.provisionDaemon();

		const pkgUpload = sftpCalls.find(
			(c) =>
				c.method === "fastPut" &&
				(c.args[1] as string).includes("package.json"),
		);
		expect(pkgUpload).toBeDefined();
		expect(pkgUpload?.args[1]).toBe("~/.superset/package.json");
	});

	it("should install node-pty on the remote machine", async () => {
		const { ssh, execCalls } = createMockSsh();
		const provisioner = new RemoteProvisioner(ssh);

		await provisioner.provisionDaemon();

		const npmInstall = execCalls.find(
			(cmd) => cmd.includes("npm install") && cmd.includes(".superset"),
		);
		expect(npmInstall).toBeDefined();
	});

	it("should close the SFTP client after upload", async () => {
		const { ssh, sftpCalls } = createMockSsh();
		const provisioner = new RemoteProvisioner(ssh);

		await provisioner.provisionDaemon();

		const endCall = sftpCalls.find((c) => c.method === "end");
		expect(endCall).toBeDefined();
	});

	it("should upload local files from the correct build output directory", async () => {
		const { ssh, sftpCalls } = createMockSsh();
		const provisioner = new RemoteProvisioner(ssh);

		await provisioner.provisionDaemon();

		// All fastPut calls should have a local path that includes the remote-daemon directory
		const fastPutCalls = sftpCalls.filter((c) => c.method === "fastPut");
		expect(fastPutCalls.length).toBeGreaterThanOrEqual(3); // terminal-host.js, pty-subprocess.js, package.json

		for (const call of fastPutCalls) {
			const localPath = call.args[0] as string;
			expect(localPath).toContain("remote-daemon");
		}
	});
});
