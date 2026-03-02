import type { StatusResult } from "simple-git";

/**
 * Abstraction over git operations that works for both local (simpleGit)
 * and remote (SSH) repositories. All methods accept an explicit repo path
 * so callers don't need to know whether the path is local or remote.
 */
export interface GitOperations {
	// ─── Clone / worktree lifecycle ───────────────────────────────
	clone(url: string, targetPath: string): Promise<void>;
	worktreeAdd(
		mainRepoPath: string,
		worktreePath: string,
		args: string[],
	): Promise<void>;
	worktreeRemove(mainRepoPath: string, worktreePath: string): Promise<void>;

	// ─── Branch queries ──────────────────────────────────────────
	getCurrentBranch(repoPath: string): Promise<string | null>;
	getDefaultBranch(mainRepoPath: string): Promise<string>;
	branchExistsOnRemote(repoPath: string, branch: string): Promise<boolean>;
	listBranches(
		repoPath: string,
		options?: { fetch?: boolean },
	): Promise<{ local: string[]; remote: string[] }>;
	branchLocal(repoPath: string): Promise<string[]>;
	refExistsLocally(repoPath: string, ref: string): Promise<boolean>;
	checkoutBranch(repoPath: string, branch: string): Promise<void>;

	// ─── Repo info ───────────────────────────────────────────────
	getGitRoot(path: string): Promise<string>;
	getGitAuthorName(repoPath: string): Promise<string | null>;
	hasOriginRemote(repoPath: string): Promise<boolean>;
	status(repoPath: string): Promise<StatusResult>;

	// ─── Fetch / sync ────────────────────────────────────────────
	fetch(repoPath: string, remote?: string, branch?: string): Promise<void>;
	refreshDefaultBranch(repoPath: string): Promise<string | null>;
	fetchDefaultBranch(repoPath: string, defaultBranch: string): Promise<string>;
	getAheadBehindCount(
		repoPath: string,
		defaultBranch: string,
	): Promise<{ ahead: number; behind: number }>;

	// ─── Worktree queries ────────────────────────────────────────
	worktreeList(repoPath: string): Promise<string>;

	// ─── Config ──────────────────────────────────────────────────
	configGet(repoPath: string, key: string): Promise<string>;
	configSet(
		repoPath: string,
		key: string,
		value: string,
		flags?: string[],
	): Promise<void>;
	configUnset(repoPath: string, key: string): Promise<void>;

	// ─── Low-level ───────────────────────────────────────────────
	revList(repoPath: string, args: string[]): Promise<string>;
	raw(repoPath: string, args: string[]): Promise<string>;
}
