import simpleGit, { type StatusResult } from "simple-git";
import type { GitOperations } from "./types";

/**
 * Local git operations using simpleGit.
 * Every method creates a fresh simpleGit instance scoped to the given path.
 */
export class LocalGitOperations implements GitOperations {
	// ─── Clone / worktree lifecycle ──────────────────────────────

	async clone(url: string, targetPath: string): Promise<void> {
		await simpleGit().clone(url, targetPath);
	}

	async worktreeAdd(
		mainRepoPath: string,
		_worktreePath: string,
		args: string[],
	): Promise<void> {
		await simpleGit(mainRepoPath).raw(["worktree", "add", ...args]);
	}

	async worktreeRemove(
		mainRepoPath: string,
		worktreePath: string,
	): Promise<void> {
		await simpleGit(mainRepoPath).raw([
			"worktree",
			"remove",
			"--force",
			worktreePath,
		]);
	}

	// ─── Branch queries ──────────────────────────────────────────

	async getCurrentBranch(repoPath: string): Promise<string | null> {
		const git = simpleGit(repoPath);
		try {
			const branch = await git.revparse(["--abbrev-ref", "HEAD"]);
			const trimmed = branch.trim();
			if (trimmed && trimmed !== "HEAD") return trimmed;
		} catch {
			// Fall back to symbolic-ref for unborn HEAD repos
		}
		try {
			const branch = await git.raw(["symbolic-ref", "--short", "HEAD"]);
			return branch.trim() || null;
		} catch {
			return null;
		}
	}

	async getDefaultBranch(mainRepoPath: string): Promise<string> {
		const git = simpleGit(mainRepoPath);
		const hasRemote = await this.hasOriginRemote(mainRepoPath);

		if (hasRemote) {
			try {
				const headRef = await git.raw([
					"symbolic-ref",
					"refs/remotes/origin/HEAD",
				]);
				const match = headRef.trim().match(/refs\/remotes\/origin\/(.+)/);
				if (match) return match[1];
			} catch {}

			try {
				const branches = await git.branch(["-r"]);
				const remoteBranches = branches.all.map((b) =>
					b.replace("origin/", ""),
				);
				for (const candidate of ["main", "master", "develop", "trunk"]) {
					if (remoteBranches.includes(candidate)) return candidate;
				}
			} catch {}

			try {
				const result = await git.raw([
					"ls-remote",
					"--symref",
					"origin",
					"HEAD",
				]);
				const symrefMatch = result.match(/ref:\s+refs\/heads\/(.+?)\tHEAD/);
				if (symrefMatch) return symrefMatch[1];
			} catch {}
		} else {
			try {
				const currentBranch = await this.getCurrentBranch(mainRepoPath);
				if (currentBranch) return currentBranch;
			} catch {}

			try {
				const localBranches = await git.branchLocal();
				for (const candidate of ["main", "master", "develop", "trunk"]) {
					if (localBranches.all.includes(candidate)) return candidate;
				}
				if (localBranches.all.length > 0) return localBranches.all[0];
			} catch {}
		}

		return "main";
	}

	async branchExistsOnRemote(
		repoPath: string,
		branch: string,
	): Promise<boolean> {
		const git = simpleGit(repoPath);
		try {
			const result = await git.raw([
				"ls-remote",
				"--heads",
				"origin",
				branch,
			]);
			return result.trim().length > 0;
		} catch {
			return false;
		}
	}

	async listBranches(
		repoPath: string,
		options?: { fetch?: boolean },
	): Promise<{ local: string[]; remote: string[] }> {
		const git = simpleGit(repoPath);

		if (options?.fetch) {
			try {
				await git.fetch(["--prune"]);
			} catch {}
		}

		const localResult = await git.branchLocal();
		const local = localResult.all;

		const remoteResult = await git.branch(["-r"]);
		const remote = remoteResult.all
			.filter((b) => b.startsWith("origin/") && !b.includes("->"))
			.map((b) => b.replace("origin/", ""));

		return { local, remote };
	}

	async branchLocal(repoPath: string): Promise<string[]> {
		const git = simpleGit(repoPath);
		const result = await git.branchLocal();
		return result.all;
	}

	async refExistsLocally(repoPath: string, ref: string): Promise<boolean> {
		const git = simpleGit(repoPath);
		try {
			await git.raw([
				"rev-parse",
				"--verify",
				"--quiet",
				`${ref}^{commit}`,
			]);
			return true;
		} catch {
			return false;
		}
	}

	async checkoutBranch(repoPath: string, branch: string): Promise<void> {
		const git = simpleGit(repoPath);
		await git.checkout(branch);
	}

	// ─── Repo info ───────────────────────────────────────────────

	async getGitRoot(path: string): Promise<string> {
		const git = simpleGit(path);
		const root = await git.revparse(["--show-toplevel"]);
		return root.trim();
	}

	async getGitAuthorName(repoPath: string): Promise<string | null> {
		try {
			const git = repoPath ? simpleGit(repoPath) : simpleGit();
			const name = await git.getConfig("user.name");
			return name.value?.trim() || null;
		} catch {
			return null;
		}
	}

	async hasOriginRemote(repoPath: string): Promise<boolean> {
		try {
			const git = simpleGit(repoPath);
			const remotes = await git.getRemotes();
			return remotes.some((r) => r.name === "origin");
		} catch {
			return false;
		}
	}

	async status(repoPath: string): Promise<StatusResult> {
		const git = simpleGit(repoPath);
		return git.status();
	}

	// ─── Fetch / sync ────────────────────────────────────────────

	async fetch(
		repoPath: string,
		remote?: string,
		branch?: string,
	): Promise<void> {
		const git = simpleGit(repoPath);
		if (remote && branch) {
			await git.fetch(remote, branch);
		} else if (remote) {
			await git.fetch(remote);
		} else {
			await git.fetch();
		}
	}

	async refreshDefaultBranch(repoPath: string): Promise<string | null> {
		const git = simpleGit(repoPath);

		const hasRemote = await this.hasOriginRemote(repoPath);
		if (!hasRemote) return null;

		try {
			await git.remote(["set-head", "origin", "--auto"]);
			const headRef = await git.raw([
				"symbolic-ref",
				"refs/remotes/origin/HEAD",
			]);
			const match = headRef.trim().match(/refs\/remotes\/origin\/(.+)/);
			if (match) return match[1];
		} catch {
			try {
				const result = await git.raw([
					"ls-remote",
					"--symref",
					"origin",
					"HEAD",
				]);
				const symrefMatch = result.match(/ref:\s+refs\/heads\/(.+?)\tHEAD/);
				if (symrefMatch) return symrefMatch[1];
			} catch {}
		}

		return null;
	}

	async fetchDefaultBranch(
		repoPath: string,
		defaultBranch: string,
	): Promise<string> {
		const git = simpleGit(repoPath);
		await git.fetch("origin", defaultBranch);
		const commit = await git.revparse(`origin/${defaultBranch}`);
		return commit.trim();
	}

	async getAheadBehindCount(
		repoPath: string,
		defaultBranch: string,
	): Promise<{ ahead: number; behind: number }> {
		const git = simpleGit(repoPath);
		try {
			const output = await git.raw([
				"rev-list",
				"--left-right",
				"--count",
				`origin/${defaultBranch}...HEAD`,
			]);
			const [behindStr, aheadStr] = output.trim().split(/\s+/);
			return {
				ahead: Number.parseInt(aheadStr || "0", 10),
				behind: Number.parseInt(behindStr || "0", 10),
			};
		} catch {
			return { ahead: 0, behind: 0 };
		}
	}

	// ─── Worktree queries ────────────────────────────────────────

	async worktreeList(repoPath: string): Promise<string> {
		const git = simpleGit(repoPath);
		return git.raw(["worktree", "list", "--porcelain"]);
	}

	// ─── Config ──────────────────────────────────────────────────

	async configGet(repoPath: string, key: string): Promise<string> {
		const git = simpleGit(repoPath);
		return git.raw(["config", key]);
	}

	async configSet(
		repoPath: string,
		key: string,
		value: string,
		flags?: string[],
	): Promise<void> {
		const git = simpleGit(repoPath);
		const args = ["config", ...(flags ?? []), key, value];
		await git.raw(args);
	}

	async configUnset(repoPath: string, key: string): Promise<void> {
		const git = simpleGit(repoPath);
		await git.raw(["config", "--unset", key]);
	}

	// ─── Low-level ───────────────────────────────────────────────

	async revList(repoPath: string, args: string[]): Promise<string> {
		const git = simpleGit(repoPath);
		return git.raw(["rev-list", ...args]);
	}

	async raw(repoPath: string, args: string[]): Promise<string> {
		const git = simpleGit(repoPath);
		return git.raw(args);
	}
}
