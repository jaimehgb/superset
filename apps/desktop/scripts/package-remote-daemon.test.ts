/**
 * Tests for the remote daemon packaging script.
 *
 * Verifies that:
 * 1. The bundle function produces a valid terminal-host.js file
 * 2. node-pty is marked as external (not bundled)
 * 3. electron is excluded from the bundle
 * 4. The output is a single file that can run on plain Node.js
 * 5. A minimal package.json is generated alongside the bundle
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	bundleRemoteDaemon,
	REMOTE_DAEMON_OUTPUT_DIR,
} from "./package-remote-daemon";

const DESKTOP_ROOT = resolve(__dirname, "..");
const OUTPUT_DIR = join(DESKTOP_ROOT, REMOTE_DAEMON_OUTPUT_DIR);

describe("package-remote-daemon", () => {
	beforeAll(async () => {
		// Clean output directory before test
		if (existsSync(OUTPUT_DIR)) {
			rmSync(OUTPUT_DIR, { recursive: true });
		}

		// Run the bundler
		await bundleRemoteDaemon();
	});

	afterAll(() => {
		// Clean up after tests
		if (existsSync(OUTPUT_DIR)) {
			rmSync(OUTPUT_DIR, { recursive: true });
		}
	});

	it("should produce terminal-host.js in the output directory", () => {
		const bundlePath = join(OUTPUT_DIR, "terminal-host.js");
		expect(existsSync(bundlePath)).toBe(true);
	});

	it("should produce pty-subprocess.js in the output directory", () => {
		const bundlePath = join(OUTPUT_DIR, "pty-subprocess.js");
		expect(existsSync(bundlePath)).toBe(true);
	});

	it("should produce package.json in the output directory", () => {
		const pkgPath = join(OUTPUT_DIR, "package.json");
		expect(existsSync(pkgPath)).toBe(true);

		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
		expect(pkg.name).toBe("superset-terminal-host");
		expect(pkg.private).toBe(true);
		expect(pkg.dependencies).toHaveProperty("node-pty");
	});

	it("should not bundle node-pty (marked as external)", () => {
		const bundlePath = join(OUTPUT_DIR, "terminal-host.js");
		const content = readFileSync(bundlePath, "utf-8");
		// The bundle should contain a require("node-pty") call, not inline the module
		// Since node-pty is external, esbuild will emit require("node-pty")
		expect(content).not.toContain("node_pty_binding");
	});

	it("should not reference electron in terminal-host bundle", () => {
		const bundlePath = join(OUTPUT_DIR, "terminal-host.js");
		const content = readFileSync(bundlePath, "utf-8");
		// The terminal-host daemon should not reference electron
		expect(content).not.toContain('require("electron")');
	});

	it("should not reference electron in pty-subprocess bundle", () => {
		const bundlePath = join(OUTPUT_DIR, "pty-subprocess.js");
		const content = readFileSync(bundlePath, "utf-8");
		expect(content).not.toContain('require("electron")');
	});

	it("should produce non-empty bundles", () => {
		const hostBundle = readFileSync(
			join(OUTPUT_DIR, "terminal-host.js"),
			"utf-8",
		);
		const ptyBundle = readFileSync(
			join(OUTPUT_DIR, "pty-subprocess.js"),
			"utf-8",
		);

		// Bundles should be substantial (at least 1KB each)
		expect(hostBundle.length).toBeGreaterThan(1000);
		expect(ptyBundle.length).toBeGreaterThan(1000);
	});

	it("should keep tree-kill as external dependency in package.json", () => {
		const pkgPath = join(OUTPUT_DIR, "package.json");
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
		expect(pkg.dependencies).toHaveProperty("tree-kill");
	});
});
