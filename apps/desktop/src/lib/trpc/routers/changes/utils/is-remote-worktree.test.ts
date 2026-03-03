import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockWorktreeGet = mock(() => null as { projectId: string } | null);
const mockProjectGet = mock(
	() => null as { remoteMachineId: string | null } | null,
);

// Track which table is being queried
let queryingTable: "worktrees" | "projects" | null = null;

mock.module("@superset/local-db", () => ({
	worktrees: { path: "path", projectId: "projectId" },
	projects: { id: "id", remoteMachineId: "remoteMachineId" },
}));

mock.module("drizzle-orm", () => ({
	eq: (a: unknown, b: unknown) => ({ a, b }),
}));

mock.module("main/lib/local-db", () => ({
	localDb: {
		select: () => ({
			from: (table: { path?: string; id?: string }) => {
				queryingTable = table.path ? "worktrees" : "projects";
				return {
					where: () => ({
						get: () => {
							if (queryingTable === "worktrees") {
								return mockWorktreeGet();
							}
							return mockProjectGet();
						},
					}),
				};
			},
		}),
	},
}));

// ---------------------------------------------------------------------------
// Import under test (AFTER mocking)
// ---------------------------------------------------------------------------
import { isRemoteWorktree } from "./is-remote-worktree";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("isRemoteWorktree", () => {
	beforeEach(() => {
		mockWorktreeGet.mockReset();
		mockProjectGet.mockReset();
		mockWorktreeGet.mockReturnValue(null);
		mockProjectGet.mockReturnValue(null);
	});

	test("returns false when worktree is not found", () => {
		mockWorktreeGet.mockReturnValue(null);
		expect(isRemoteWorktree("/some/unknown/path")).toBe(false);
	});

	test("returns false when project is not found", () => {
		mockWorktreeGet.mockReturnValue({ projectId: "proj-1" });
		mockProjectGet.mockReturnValue(null);
		expect(isRemoteWorktree("/local/worktrees/my-branch")).toBe(false);
	});

	test("returns false for a local project (no remoteMachineId)", () => {
		mockWorktreeGet.mockReturnValue({ projectId: "proj-1" });
		mockProjectGet.mockReturnValue({ remoteMachineId: null });
		expect(isRemoteWorktree("/local/worktrees/my-branch")).toBe(false);
	});

	test("returns true for a remote project (has remoteMachineId)", () => {
		mockWorktreeGet.mockReturnValue({ projectId: "proj-1" });
		mockProjectGet.mockReturnValue({ remoteMachineId: "machine-1" });
		expect(isRemoteWorktree("/remote/worktrees/my-branch")).toBe(true);
	});

	test("returns a boolean value", () => {
		const result = isRemoteWorktree("/some/path");
		expect(typeof result).toBe("boolean");
	});
});
