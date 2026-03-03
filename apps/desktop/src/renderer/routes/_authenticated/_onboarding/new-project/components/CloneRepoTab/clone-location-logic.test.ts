import { describe, expect, it } from "bun:test";
import {
	buildCloneMutationInput,
	type RemoteMachine,
	shouldShowRemoteToggle,
	validateCloneInputs,
} from "./clone-location-helpers";

/**
 * Tests for the clone location toggle logic used by CloneRepoTab.
 *
 * We test the pure functions that drive the UI decisions:
 * 1. Whether to show the remote toggle (based on machine availability)
 * 2. What mutation args to build (local vs remote)
 * 3. Validation behaviour for each mode
 */

// ===========================================================================
// Tests: shouldShowRemoteToggle
// ===========================================================================

describe("shouldShowRemoteToggle", () => {
	it("returns false when machines is undefined (loading)", () => {
		expect(shouldShowRemoteToggle(undefined)).toBe(false);
	});

	it("returns false when machines array is empty", () => {
		expect(shouldShowRemoteToggle([])).toBe(false);
	});

	it("returns true when at least one machine exists", () => {
		const machines: RemoteMachine[] = [
			{
				id: "m1",
				name: "Dev Server",
				projectsDir: "~/projects",
				status: "connected",
			},
		];
		expect(shouldShowRemoteToggle(machines)).toBe(true);
	});

	it("returns true when multiple machines exist", () => {
		const machines: RemoteMachine[] = [
			{
				id: "m1",
				name: "Dev Server",
				projectsDir: "~/projects",
				status: "connected",
			},
			{
				id: "m2",
				name: "Staging",
				projectsDir: "/opt/apps",
				status: "disconnected",
			},
		];
		expect(shouldShowRemoteToggle(machines)).toBe(true);
	});
});

// ===========================================================================
// Tests: buildCloneMutationInput
// ===========================================================================

describe("buildCloneMutationInput", () => {
	const machine: RemoteMachine = {
		id: "machine-123",
		name: "Dev Server",
		projectsDir: "~/projects",
		status: "connected",
	};

	it("builds local clone input with targetDirectory", () => {
		const result = buildCloneMutationInput(
			"https://github.com/user/repo.git",
			"/Users/dev/projects",
			"local",
			machine,
		);
		expect(result).toEqual({
			url: "https://github.com/user/repo.git",
			targetDirectory: "/Users/dev/projects",
		});
		expect(result.remoteMachineId).toBeUndefined();
	});

	it("builds remote clone input with remoteMachineId and no targetDirectory", () => {
		const result = buildCloneMutationInput(
			"https://github.com/user/repo.git",
			"/Users/dev/projects",
			"remote",
			machine,
		);
		expect(result).toEqual({
			url: "https://github.com/user/repo.git",
			remoteMachineId: "machine-123",
		});
		expect(result.targetDirectory).toBeUndefined();
	});

	it("trims whitespace from URL", () => {
		const result = buildCloneMutationInput(
			"  https://github.com/user/repo.git  ",
			"/Users/dev/projects",
			"local",
			undefined,
		);
		expect(result.url).toBe("https://github.com/user/repo.git");
	});

	it("trims whitespace from targetDirectory in local mode", () => {
		const result = buildCloneMutationInput(
			"https://github.com/user/repo.git",
			"  /Users/dev/projects  ",
			"local",
			undefined,
		);
		expect(result.targetDirectory).toBe("/Users/dev/projects");
	});

	it("falls back to local when remote selected but no machine provided", () => {
		const result = buildCloneMutationInput(
			"https://github.com/user/repo.git",
			"/Users/dev/projects",
			"remote",
			undefined,
		);
		// When no machine, falls back to local-style input
		expect(result).toEqual({
			url: "https://github.com/user/repo.git",
			targetDirectory: "/Users/dev/projects",
		});
		expect(result.remoteMachineId).toBeUndefined();
	});
});

// ===========================================================================
// Tests: validateCloneInputs
// ===========================================================================

describe("validateCloneInputs", () => {
	const machine: RemoteMachine = {
		id: "m1",
		name: "Dev Server",
		projectsDir: "~/projects",
		status: "connected",
	};

	it("returns error when URL is empty (local mode)", () => {
		expect(validateCloneInputs("", "/some/path", "local", undefined)).toBe(
			"Please enter a repository URL",
		);
	});

	it("returns error when URL is whitespace only (local mode)", () => {
		expect(validateCloneInputs("   ", "/some/path", "local", undefined)).toBe(
			"Please enter a repository URL",
		);
	});

	it("returns error when URL is empty (remote mode)", () => {
		expect(validateCloneInputs("", "", "remote", machine)).toBe(
			"Please enter a repository URL",
		);
	});

	it("returns error when parentDir is empty in local mode", () => {
		expect(
			validateCloneInputs(
				"https://github.com/user/repo.git",
				"",
				"local",
				undefined,
			),
		).toBe("Please select a project location");
	});

	it("returns error when parentDir is whitespace in local mode", () => {
		expect(
			validateCloneInputs(
				"https://github.com/user/repo.git",
				"   ",
				"local",
				undefined,
			),
		).toBe("Please select a project location");
	});

	it("does NOT require parentDir in remote mode", () => {
		expect(
			validateCloneInputs(
				"https://github.com/user/repo.git",
				"",
				"remote",
				machine,
			),
		).toBeNull();
	});

	it("returns error when no remote machine in remote mode", () => {
		expect(
			validateCloneInputs(
				"https://github.com/user/repo.git",
				"",
				"remote",
				undefined,
			),
		).toBe("No remote machine configured");
	});

	it("returns null for valid local clone", () => {
		expect(
			validateCloneInputs(
				"https://github.com/user/repo.git",
				"/Users/dev/projects",
				"local",
				undefined,
			),
		).toBeNull();
	});

	it("returns null for valid remote clone", () => {
		expect(
			validateCloneInputs(
				"https://github.com/user/repo.git",
				"",
				"remote",
				machine,
			),
		).toBeNull();
	});
});
