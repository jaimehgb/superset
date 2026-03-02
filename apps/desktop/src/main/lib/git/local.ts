import simpleGit from "simple-git";

import type { GitOperations } from "./types";

export class LocalGitOperations implements GitOperations {
	async clone(url: string, targetPath: string): Promise<void> {
		await simpleGit().clone(url, targetPath);
	}

	async worktreeAdd(
		repoPath: string,
		branch: string,
		worktreePath: string,
		startPoint: string,
	): Promise<void> {
		await simpleGit(repoPath).raw([
			"worktree",
			"add",
			worktreePath,
			"-b",
			branch,
			`${startPoint}^{commit}`,
		]);
		await simpleGit(worktreePath).raw([
			"config",
			"--local",
			"push.autoSetupRemote",
			"true",
		]);
	}

	async worktreeRemove(repoPath: string, worktreePath: string): Promise<void> {
		await simpleGit(repoPath).raw([
			"worktree",
			"remove",
			"--force",
			worktreePath,
		]);
	}

	async fetch(
		repoPath: string,
		remote = "origin",
		branch?: string,
	): Promise<void> {
		if (branch) {
			await simpleGit(repoPath).fetch(remote, branch);
		} else {
			await simpleGit(repoPath).fetch(remote);
		}
	}

	async getDefaultBranch(repoPath: string): Promise<string> {
		try {
			const ref = await simpleGit(repoPath).raw([
				"symbolic-ref",
				"refs/remotes/origin/HEAD",
			]);
			// ref is like "refs/remotes/origin/main\n"
			const parts = ref.trim().split("/");
			return parts[parts.length - 1] ?? "main";
		} catch {
			return "main";
		}
	}

	async getCurrentBranch(repoPath: string): Promise<string> {
		const branch = await simpleGit(repoPath).revparse(["--abbrev-ref", "HEAD"]);
		return branch.trim();
	}

	async branchExistsOnRemote(
		repoPath: string,
		branchName: string,
	): Promise<boolean> {
		try {
			await simpleGit(repoPath).raw([
				"ls-remote",
				"--exit-code",
				"--heads",
				"origin",
				branchName,
			]);
			return true;
		} catch {
			return false;
		}
	}

	async status(repoPath: string): Promise<string> {
		return simpleGit(repoPath).raw(["status", "--porcelain=v1", "-b", "-z"]);
	}
}
