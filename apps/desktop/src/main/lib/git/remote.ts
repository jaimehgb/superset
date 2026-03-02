import type { SshConnectionManager } from "main/lib/ssh/connection-manager";
import type { StatusResult } from "simple-git";
import type { GitOperations } from "./types";

/**
 * Remote git operations executed over a persistent SSH connection.
 * Each method runs `git -C <path> ...` via the SshConnectionManager.
 */
export class RemoteGitOperations implements GitOperations {
	constructor(private ssh: SshConnectionManager) {}

	private async exec(command: string): Promise<string> {
		const result = await this.ssh.exec(command);
		if (result.code !== 0) {
			throw new Error(
				`Remote command failed (exit ${result.code}): ${result.stderr || result.stdout}`,
			);
		}
		return result.stdout;
	}

	private async git(repoPath: string, args: string[]): Promise<string> {
		const escaped = args.map((a) => this.shellEscape(a)).join(" ");
		return this.exec(
			`git -C ${this.shellEscape(repoPath)} ${escaped}`,
		);
	}

	private shellEscape(s: string): string {
		return `'${s.replace(/'/g, "'\\''")}'`;
	}

	// ─── Clone / worktree lifecycle ──────────────────────────────

	async clone(url: string, targetPath: string): Promise<void> {
		await this.exec(
			`git clone ${this.shellEscape(url)} ${this.shellEscape(targetPath)}`,
		);
	}

	async worktreeAdd(
		mainRepoPath: string,
		_worktreePath: string,
		args: string[],
	): Promise<void> {
		await this.git(mainRepoPath, ["worktree", "add", ...args]);
	}

	async worktreeRemove(
		mainRepoPath: string,
		worktreePath: string,
	): Promise<void> {
		await this.git(mainRepoPath, [
			"worktree",
			"remove",
			"--force",
			worktreePath,
		]);
	}

	// ─── Branch queries ──────────────────────────────────────────

	async getCurrentBranch(repoPath: string): Promise<string | null> {
		try {
			const branch = await this.git(repoPath, [
				"rev-parse",
				"--abbrev-ref",
				"HEAD",
			]);
			const trimmed = branch.trim();
			if (trimmed && trimmed !== "HEAD") return trimmed;
		} catch {}
		try {
			const branch = await this.git(repoPath, [
				"symbolic-ref",
				"--short",
				"HEAD",
			]);
			return branch.trim() || null;
		} catch {
			return null;
		}
	}

	async getDefaultBranch(mainRepoPath: string): Promise<string> {
		const hasRemote = await this.hasOriginRemote(mainRepoPath);

		if (hasRemote) {
			try {
				const headRef = await this.git(mainRepoPath, [
					"symbolic-ref",
					"refs/remotes/origin/HEAD",
				]);
				const match = headRef.trim().match(/refs\/remotes\/origin\/(.+)/);
				if (match) return match[1];
			} catch {}

			try {
				const output = await this.git(mainRepoPath, ["branch", "-r"]);
				const remoteBranches = output
					.trim()
					.split("\n")
					.map((b) => b.trim().replace("origin/", ""))
					.filter((b) => b && !b.includes("->"));
				for (const candidate of ["main", "master", "develop", "trunk"]) {
					if (remoteBranches.includes(candidate)) return candidate;
				}
			} catch {}

			try {
				const result = await this.git(mainRepoPath, [
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
				const output = await this.git(mainRepoPath, ["branch"]);
				const branches = output
					.trim()
					.split("\n")
					.map((b) => b.trim().replace(/^\* /, ""))
					.filter(Boolean);
				for (const candidate of ["main", "master", "develop", "trunk"]) {
					if (branches.includes(candidate)) return candidate;
				}
				if (branches.length > 0) return branches[0];
			} catch {}
		}

		return "main";
	}

	async branchExistsOnRemote(
		repoPath: string,
		branch: string,
	): Promise<boolean> {
		try {
			const result = await this.git(repoPath, [
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
		if (options?.fetch) {
			try {
				await this.git(repoPath, ["fetch", "--prune"]);
			} catch {}
		}

		const localOutput = await this.git(repoPath, ["branch"]);
		const local = localOutput
			.trim()
			.split("\n")
			.map((b) => b.trim().replace(/^\* /, ""))
			.filter(Boolean);

		const remoteOutput = await this.git(repoPath, ["branch", "-r"]);
		const remote = remoteOutput
			.trim()
			.split("\n")
			.map((b) => b.trim())
			.filter((b) => b.startsWith("origin/") && !b.includes("->"))
			.map((b) => b.replace("origin/", ""));

		return { local, remote };
	}

	async branchLocal(repoPath: string): Promise<string[]> {
		const output = await this.git(repoPath, ["branch"]);
		return output
			.trim()
			.split("\n")
			.map((b) => b.trim().replace(/^\* /, ""))
			.filter(Boolean);
	}

	async refExistsLocally(repoPath: string, ref: string): Promise<boolean> {
		try {
			await this.git(repoPath, [
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
		await this.git(repoPath, ["checkout", branch]);
	}

	// ─── Repo info ───────────────────────────────────────────────

	async getGitRoot(path: string): Promise<string> {
		const root = await this.git(path, ["rev-parse", "--show-toplevel"]);
		return root.trim();
	}

	async getGitAuthorName(repoPath: string): Promise<string | null> {
		try {
			const name = await this.git(repoPath, ["config", "user.name"]);
			return name.trim() || null;
		} catch {
			return null;
		}
	}

	async hasOriginRemote(repoPath: string): Promise<boolean> {
		try {
			const output = await this.git(repoPath, ["remote"]);
			return output
				.trim()
				.split("\n")
				.some((r) => r.trim() === "origin");
		} catch {
			return false;
		}
	}

	async status(repoPath: string): Promise<StatusResult> {
		// Return a minimal StatusResult from porcelain output.
		// For remote, we parse the raw status ourselves.
		const output = await this.git(repoPath, [
			"status",
			"--porcelain=v1",
			"-b",
		]);

		const files: StatusResult["files"] = [];
		let current: string | null = null;
		let tracking: string | null = null;

		for (const line of output.split("\n")) {
			if (!line) continue;
			if (line.startsWith("## ")) {
				const branchInfo = line.slice(3);
				const trackingMatch = branchInfo.match(
					/^(.+?)\.\.\.(.+?)(?:\s|$)/,
				);
				if (trackingMatch) {
					current = trackingMatch[1];
					tracking = trackingMatch[2].split(" ")[0] || null;
				} else {
					current = branchInfo.split(" ")[0] || null;
				}
				continue;
			}
			if (line.length >= 3) {
				files.push({
					path: line.slice(3),
					from: line.slice(3),
					index: line[0],
					working_dir: line[1],
				});
			}
		}

		return {
			not_added: [],
			conflicted: [],
			created: [],
			deleted: [],
			ignored: undefined,
			modified: [],
			renamed: [],
			files,
			staged: [],
			ahead: 0,
			behind: 0,
			current,
			tracking,
			detached: false,
			isClean: () => files.length === 0,
		};
	}

	// ─── Fetch / sync ────────────────────────────────────────────

	async fetch(
		repoPath: string,
		remote?: string,
		branch?: string,
	): Promise<void> {
		const args = ["fetch"];
		if (remote) args.push(remote);
		if (branch) args.push(branch);
		await this.git(repoPath, args);
	}

	async refreshDefaultBranch(repoPath: string): Promise<string | null> {
		const hasRemote = await this.hasOriginRemote(repoPath);
		if (!hasRemote) return null;

		try {
			await this.git(repoPath, ["remote", "set-head", "origin", "--auto"]);
			const headRef = await this.git(repoPath, [
				"symbolic-ref",
				"refs/remotes/origin/HEAD",
			]);
			const match = headRef.trim().match(/refs\/remotes\/origin\/(.+)/);
			if (match) return match[1];
		} catch {
			try {
				const result = await this.git(repoPath, [
					"ls-remote",
					"--symref",
					"origin",
					"HEAD",
				]);
				const symrefMatch = result.match(
					/ref:\s+refs\/heads\/(.+?)\tHEAD/,
				);
				if (symrefMatch) return symrefMatch[1];
			} catch {}
		}

		return null;
	}

	async fetchDefaultBranch(
		repoPath: string,
		defaultBranch: string,
	): Promise<string> {
		await this.git(repoPath, ["fetch", "origin", defaultBranch]);
		const commit = await this.git(repoPath, [
			"rev-parse",
			`origin/${defaultBranch}`,
		]);
		return commit.trim();
	}

	async getAheadBehindCount(
		repoPath: string,
		defaultBranch: string,
	): Promise<{ ahead: number; behind: number }> {
		try {
			const output = await this.git(repoPath, [
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
		return this.git(repoPath, ["worktree", "list", "--porcelain"]);
	}

	// ─── Config ──────────────────────────────────────────────────

	async configGet(repoPath: string, key: string): Promise<string> {
		return this.git(repoPath, ["config", key]);
	}

	async configSet(
		repoPath: string,
		key: string,
		value: string,
		flags?: string[],
	): Promise<void> {
		await this.git(repoPath, ["config", ...(flags ?? []), key, value]);
	}

	async configUnset(repoPath: string, key: string): Promise<void> {
		await this.git(repoPath, ["config", "--unset", key]);
	}

	// ─── Low-level ───────────────────────────────────────────────

	async revList(repoPath: string, args: string[]): Promise<string> {
		return this.git(repoPath, ["rev-list", ...args]);
	}

	async raw(repoPath: string, args: string[]): Promise<string> {
		return this.git(repoPath, args);
	}
}
