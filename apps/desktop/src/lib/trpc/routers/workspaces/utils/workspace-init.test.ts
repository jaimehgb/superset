import { beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * Tests for remote workspace initialization support.
 *
 * When a project has a `remoteMachineId`, workspace init should use
 * RemoteGitOperations (via SSH) instead of local simple-git calls.
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock the local-db module
// biome-ignore lint/suspicious/noExplicitAny: test mock
const mockLocalDbSelect: any = mock(() => ({
	from: mock(() => ({
		where: mock(() => ({
			get: mock(() => null),
		})),
	})),
}));
const mockLocalDbUpdate = mock(() => ({
	set: mock(() => ({
		where: mock(() => ({
			run: mock(() => {}),
		})),
	})),
}));
const mockLocalDb = {
	select: mockLocalDbSelect,
	from: mock(),
	update: mockLocalDbUpdate,
};

mock.module("main/lib/local-db", () => ({
	localDb: mockLocalDb,
}));

mock.module("@superset/local-db", () => ({
	projects: { id: "id" },
	worktrees: { id: "id" },
	remoteMachines: { id: "id" },
}));

mock.module("drizzle-orm", () => ({
	eq: (a: unknown, b: unknown) => ({ a, b }),
}));

// Mock workspace-init-manager
const mockManager = {
	acquireProjectLock: mock(async () => {}),
	releaseProjectLock: mock(() => {}),
	isCancellationRequested: mock(() => false),
	updateProgress: mock(() => {}),
	markWorktreeCreated: mock(() => {}),
	wasWorktreeCreated: mock(() => false),
	finalizeJob: mock(() => {}),
};

mock.module("main/lib/workspace-init-manager", () => ({
	workspaceInitManager: mockManager,
}));

// Mock analytics
mock.module("main/lib/analytics", () => ({
	track: mock(() => {}),
}));

// Mock base-branch utils
mock.module("./base-branch", () => ({
	resolveWorkspaceBaseBranch: mock(() => "main"),
}));

mock.module("./base-branch-config", () => ({
	getBranchBaseConfig: mock(async () => ({
		baseBranch: null,
		isExplicit: false,
	})),
	setBranchBaseConfig: mock(async () => {}),
}));

// Mock setup
const mockCopySupersetConfigToWorktree = mock(() => {});
mock.module("./setup", () => ({
	copySupersetConfigToWorktree: mockCopySupersetConfigToWorktree,
}));

// Mock local git functions
const mockRefreshDefaultBranch = mock(async () => "main");
const mockHasOriginRemote = mock(async () => true);
const mockBranchExistsOnRemote = mock(
	async () => ({ status: "exists" }) as const,
);
const mockFetchDefaultBranch = mock(async () => "abc123");
const mockRefExistsLocally = mock(async () => true);
const mockCreateWorktree = mock(async () => {});
const mockCreateWorktreeFromExistingBranch = mock(async () => {});
const mockRemoveWorktree = mock(async () => {});
const mockSanitizeGitError = mock((msg: string) => msg);

mock.module("./git", () => ({
	refreshDefaultBranch: mockRefreshDefaultBranch,
	hasOriginRemote: mockHasOriginRemote,
	branchExistsOnRemote: mockBranchExistsOnRemote,
	fetchDefaultBranch: mockFetchDefaultBranch,
	refExistsLocally: mockRefExistsLocally,
	createWorktree: mockCreateWorktree,
	createWorktreeFromExistingBranch: mockCreateWorktreeFromExistingBranch,
	removeWorktree: mockRemoveWorktree,
	sanitizeGitError: mockSanitizeGitError,
}));

// Mock RemoteGitOperations
const mockRemoteGitOps = {
	clone: mock(async () => {}),
	worktreeAdd: mock(async () => {}),
	worktreeRemove: mock(async () => {}),
	fetch: mock(async () => {}),
	getDefaultBranch: mock(async () => "main"),
	getCurrentBranch: mock(async () => "feature-branch"),
	branchExistsOnRemote: mock(async () => true),
	status: mock(async () => ""),
	refExistsLocally: mock(async () => true),
};

const MockRemoteGitOperations = mock(() => mockRemoteGitOps);

mock.module("main/lib/git/remote", () => ({
	RemoteGitOperations: MockRemoteGitOperations,
}));

// Mock SSH connection
const mockSshConnection = {
	exec: mock(async () => ({ code: 0, stdout: "", stderr: "" })),
};

const mockGetActiveConnection = mock(() => mockSshConnection);

// Mock the connections module (lightweight, avoids heavy tRPC transitive deps)
mock.module("../../remote-machines/connections", () => ({
	getActiveConnection: mockGetActiveConnection,
}));

// ---------------------------------------------------------------------------
// Import under test (AFTER mocking)
// ---------------------------------------------------------------------------
import { initializeWorkspaceWorktree } from "./workspace-init";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetMocks() {
	for (const m of [
		mockRefreshDefaultBranch,
		mockHasOriginRemote,
		mockBranchExistsOnRemote,
		mockFetchDefaultBranch,
		mockRefExistsLocally,
		mockCreateWorktree,
		mockCreateWorktreeFromExistingBranch,
		mockRemoveWorktree,
		mockSanitizeGitError,
		mockCopySupersetConfigToWorktree,
		mockManager.acquireProjectLock,
		mockManager.releaseProjectLock,
		mockManager.isCancellationRequested,
		mockManager.updateProgress,
		mockManager.markWorktreeCreated,
		mockManager.wasWorktreeCreated,
		mockManager.finalizeJob,
		mockRemoteGitOps.worktreeAdd,
		mockRemoteGitOps.worktreeRemove,
		mockRemoteGitOps.fetch,
		mockRemoteGitOps.getDefaultBranch,
		mockRemoteGitOps.branchExistsOnRemote,
		mockRemoteGitOps.refExistsLocally,
		mockGetActiveConnection,
		MockRemoteGitOperations,
	]) {
		m.mockClear();
	}

	// Reset defaults
	mockManager.isCancellationRequested.mockReturnValue(false);
	mockHasOriginRemote.mockResolvedValue(true);
	mockBranchExistsOnRemote.mockResolvedValue({ status: "exists" } as const);
	mockFetchDefaultBranch.mockResolvedValue("abc123");
	mockRefExistsLocally.mockResolvedValue(true);
	mockRefreshDefaultBranch.mockResolvedValue("main");
	mockRemoteGitOps.getDefaultBranch.mockResolvedValue("main");
	mockRemoteGitOps.branchExistsOnRemote.mockResolvedValue(true);
	mockRemoteGitOps.refExistsLocally.mockResolvedValue(true);
	mockGetActiveConnection.mockReturnValue(mockSshConnection);
}

const baseParams = {
	workspaceId: "ws-1",
	projectId: "proj-1",
	worktreeId: "wt-1",
	worktreePath: "/local/worktrees/my-branch",
	branch: "my-branch",
	mainRepoPath: "/local/repos/my-project",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("initializeWorkspaceWorktree", () => {
	beforeEach(() => {
		resetMocks();
	});

	describe("local project (no remoteMachineId)", () => {
		beforeEach(() => {
			// Return project without remoteMachineId
			mockLocalDbSelect.mockReturnValue({
				from: () => ({
					where: () => ({
						get: () => ({
							id: "proj-1",
							mainRepoPath: "/local/repos/my-project",
							defaultBranch: "main",
							workspaceBaseBranch: null,
							remoteMachineId: null,
						}),
					}),
				}),
			});
		});

		test("uses local git functions for worktree creation", async () => {
			await initializeWorkspaceWorktree(baseParams);

			// Should use local createWorktree, NOT RemoteGitOperations
			expect(mockCreateWorktree).toHaveBeenCalledTimes(1);
			expect(mockRemoteGitOps.worktreeAdd).not.toHaveBeenCalled();
		});

		test("uses local fetchDefaultBranch", async () => {
			await initializeWorkspaceWorktree(baseParams);

			expect(mockFetchDefaultBranch).toHaveBeenCalledTimes(1);
			expect(mockRemoteGitOps.fetch).not.toHaveBeenCalled();
		});

		test("does not call getActiveConnection", async () => {
			await initializeWorkspaceWorktree(baseParams);

			expect(mockGetActiveConnection).not.toHaveBeenCalled();
		});
	});

	describe("remote project (with remoteMachineId)", () => {
		beforeEach(() => {
			// Return project WITH remoteMachineId
			mockLocalDbSelect.mockReturnValue({
				from: () => ({
					where: () => ({
						get: () => ({
							id: "proj-1",
							mainRepoPath: "/remote/repos/my-project",
							defaultBranch: "main",
							workspaceBaseBranch: null,
							remoteMachineId: "machine-1",
						}),
					}),
				}),
			});
		});

		test("uses RemoteGitOperations for worktree creation", async () => {
			await initializeWorkspaceWorktree(baseParams);

			// Should use remote git ops, NOT local createWorktree
			expect(mockRemoteGitOps.worktreeAdd).toHaveBeenCalledTimes(1);
			expect(mockCreateWorktree).not.toHaveBeenCalled();
		});

		test("calls getActiveConnection with the machine ID", async () => {
			await initializeWorkspaceWorktree(baseParams);

			expect(mockGetActiveConnection).toHaveBeenCalledWith("machine-1");
		});

		test("uses remote fetch instead of local fetchDefaultBranch", async () => {
			await initializeWorkspaceWorktree(baseParams);

			expect(mockRemoteGitOps.fetch).toHaveBeenCalled();
			expect(mockFetchDefaultBranch).not.toHaveBeenCalled();
		});

		test("uses remote branchExistsOnRemote instead of local", async () => {
			await initializeWorkspaceWorktree(baseParams);

			expect(mockRemoteGitOps.branchExistsOnRemote).toHaveBeenCalled();
			expect(mockBranchExistsOnRemote).not.toHaveBeenCalled();
		});

		test("uses remote getDefaultBranch for refreshing default branch", async () => {
			await initializeWorkspaceWorktree(baseParams);

			expect(mockRemoteGitOps.getDefaultBranch).toHaveBeenCalled();
			expect(mockRefreshDefaultBranch).not.toHaveBeenCalled();
		});

		test("passes correct args to worktreeAdd", async () => {
			await initializeWorkspaceWorktree(baseParams);

			const calls = mockRemoteGitOps.worktreeAdd.mock.calls as unknown[][];
			expect(calls.length).toBeGreaterThan(0);
			const callArgs = calls[0]!;
			// First arg is mainRepoPath
			expect(callArgs[0]).toBe("/local/repos/my-project");
			// Second arg is worktree path
			expect(callArgs[1]).toBe("/local/worktrees/my-branch");
			// Third arg is args array for `git worktree add`
			const args = callArgs[2] as string[];
			expect(args).toContain("/local/worktrees/my-branch");
			expect(args).toContain("my-branch");
		});

		test("fails with error when SSH connection is not available", async () => {
			mockGetActiveConnection.mockReturnValue(undefined as never);

			await initializeWorkspaceWorktree(baseParams);

			// Should report failure via progress manager
			const failCalls = mockManager.updateProgress.mock.calls.filter(
				(call: unknown[]) => call[1] === "failed",
			);
			expect(failCalls.length).toBeGreaterThan(0);
		});

		test("uses remote worktreeRemove on cancellation after worktree created", async () => {
			// Simulate cancellation after worktree creation
			let callCount = 0;
			mockManager.isCancellationRequested.mockImplementation(() => {
				callCount++;
				// First few calls return false, then true after worktree is created
				return callCount > 4;
			});
			mockManager.wasWorktreeCreated.mockReturnValue(true);

			await initializeWorkspaceWorktree(baseParams);

			expect(mockRemoteGitOps.worktreeRemove).toHaveBeenCalled();
			expect(mockRemoveWorktree).not.toHaveBeenCalled();
		});

		test("uses existing branch flow with remote operations", async () => {
			await initializeWorkspaceWorktree({
				...baseParams,
				useExistingBranch: true,
			});

			// For existing branch on remote, should still use remote worktreeAdd
			// (or a variant of it)
			expect(mockCreateWorktreeFromExistingBranch).not.toHaveBeenCalled();
		});

		test("skips copySupersetConfigToWorktree for remote projects", async () => {
			await initializeWorkspaceWorktree(baseParams);

			// copySupersetConfigToWorktree is a local filesystem operation -
			// it should be skipped for remote projects
			expect(mockCopySupersetConfigToWorktree).not.toHaveBeenCalled();
		});
	});
});
