/**
 * Package the terminal-host daemon for remote deployment.
 *
 * Bundles `terminal-host/index.ts` and `terminal-host/pty-subprocess.ts`
 * into standalone JS files that can run on a remote Linux machine with
 * plain Node.js (no Electron required).
 *
 * Native dependencies (node-pty, tree-kill) are marked external and must
 * be installed on the remote machine via the companion package.json.
 *
 * Usage:
 *   bun run apps/desktop/scripts/package-remote-daemon.ts
 *
 * Output:
 *   apps/desktop/dist/remote-daemon/
 *     terminal-host.js    -- daemon entry point
 *     pty-subprocess.js   -- PTY subprocess (spawned per session)
 *     package.json        -- for `npm install` of native deps on remote
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Relative path from desktop root to the output directory. */
export const REMOTE_DAEMON_OUTPUT_DIR = "dist/remote-daemon";

const DESKTOP_ROOT = resolve(__dirname, "..");
const OUTPUT_DIR = join(DESKTOP_ROOT, REMOTE_DAEMON_OUTPUT_DIR);

const ENTRY_TERMINAL_HOST = resolve(
	DESKTOP_ROOT,
	"src/main/terminal-host/index.ts",
);
const ENTRY_PTY_SUBPROCESS = resolve(
	DESKTOP_ROOT,
	"src/main/terminal-host/pty-subprocess.ts",
);

/**
 * Native/binary dependencies that cannot be bundled.
 * These are installed on the remote machine via npm install.
 */
const EXTERNAL_DEPS = [
	"node-pty",
	"tree-kill",
	"electron",
	"better-sqlite3",
	"@ast-grep/napi",
	"libsql",
];

/**
 * Minimal package.json for the remote daemon.
 * Only includes native dependencies that must be compiled on the target machine.
 */
const REMOTE_PACKAGE_JSON = {
	name: "superset-terminal-host",
	private: true,
	dependencies: {
		"node-pty": "1.1.0",
		"tree-kill": "^1.2.2",
	},
};

/**
 * Bundle a single entry point using Bun's native bundler.
 * Returns the bundled source code as a string.
 */
async function bundleEntry(entrypoint: string, outfile: string): Promise<void> {
	const result = await Bun.build({
		entrypoints: [entrypoint],
		target: "node",
		format: "cjs",
		external: EXTERNAL_DEPS,
		minify: false,
	});

	if (!result.success) {
		const messages = result.logs.map((log) => log.message).join("\n");
		throw new Error(`Bundle failed for ${entrypoint}:\n${messages}`);
	}

	if (result.outputs.length === 0) {
		throw new Error(`No output produced for ${entrypoint}`);
	}

	const output = result.outputs[0];
	const text = await output.text();
	writeFileSync(outfile, text);
}

/**
 * Bundle the terminal-host daemon and pty-subprocess for remote deployment.
 * Exports for testing; also runs as a CLI script when executed directly.
 */
export async function bundleRemoteDaemon(): Promise<void> {
	// Clean and recreate output directory
	if (existsSync(OUTPUT_DIR)) {
		rmSync(OUTPUT_DIR, { recursive: true });
	}
	mkdirSync(OUTPUT_DIR, { recursive: true });

	// Bundle terminal-host daemon
	await bundleEntry(ENTRY_TERMINAL_HOST, join(OUTPUT_DIR, "terminal-host.js"));

	// Bundle pty-subprocess
	await bundleEntry(
		ENTRY_PTY_SUBPROCESS,
		join(OUTPUT_DIR, "pty-subprocess.js"),
	);

	// Write package.json for remote npm install
	writeFileSync(
		join(OUTPUT_DIR, "package.json"),
		`${JSON.stringify(REMOTE_PACKAGE_JSON, null, 2)}\n`,
	);

	console.log(`[package-remote-daemon] Output written to ${OUTPUT_DIR}`);
	console.log(
		"[package-remote-daemon] Files: terminal-host.js, pty-subprocess.js, package.json",
	);
}

// Run as CLI script when executed directly
const isDirectRun =
	import.meta.url === `file://${process.argv[1]}` ||
	process.argv[1]?.endsWith("package-remote-daemon.ts");

if (isDirectRun) {
	bundleRemoteDaemon().catch((err) => {
		console.error("[package-remote-daemon] Build failed:", err);
		process.exit(1);
	});
}
