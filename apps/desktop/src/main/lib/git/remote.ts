import type { SshConnectionManager } from "../ssh/connection-manager";
import type { GitOperations } from "./types";

export class RemoteGitOperations implements GitOperations {
	constructor(private ssh: SshConnectionManager) {}

	private escapeArg(arg: string): string {
		return `'${arg.replace(/'/g, "'\\''")}'`;
	}

	private async exec(command: string): Promise<string> {
		const result = await this.ssh.exec(command);
		if (result.code !== 0) {
			throw new Error(
				`Git command failed (code ${result.code}): ${result.stderr || result.stdout}`,
			);
		}
		return result.stdout;
	}

	async clone(url: string, targetPath: string): Promise<void> {
		await this.exec(
			`git clone ${this.escapeArg(url)} ${this.escapeArg(targetPath)}`,
		);
	}

	async worktreeAdd(
		repoPath: string,
		branch: string,
		worktreePath: string,
		startPoint: string,
	): Promise<void> {
		await this.exec(
			`git -C ${this.escapeArg(repoPath)} worktree add ${this.escapeArg(worktreePath)} -b ${this.escapeArg(branch)} ${this.escapeArg(`${startPoint}^{commit}`)}`,
		);
		await this.exec(
			`git -C ${this.escapeArg(worktreePath)} config --local push.autoSetupRemote true`,
		);
	}

	async worktreeRemove(repoPath: string, worktreePath: string): Promise<void> {
		await this.exec(
			`git -C ${this.escapeArg(repoPath)} worktree remove --force ${this.escapeArg(worktreePath)}`,
		);
	}

	async fetch(
		repoPath: string,
		remote = "origin",
		branch?: string,
	): Promise<void> {
		const cmd = branch
			? `git -C ${this.escapeArg(repoPath)} fetch ${this.escapeArg(remote)} ${this.escapeArg(branch)}`
			: `git -C ${this.escapeArg(repoPath)} fetch ${this.escapeArg(remote)}`;
		await this.exec(cmd);
	}

	async getDefaultBranch(repoPath: string): Promise<string> {
		try {
			const ref = await this.exec(
				`git -C ${this.escapeArg(repoPath)} symbolic-ref refs/remotes/origin/HEAD`,
			);
			const parts = ref.trim().split("/");
			return parts[parts.length - 1] ?? "main";
		} catch {
			return "main";
		}
	}

	async getCurrentBranch(repoPath: string): Promise<string> {
		const branch = await this.exec(
			`git -C ${this.escapeArg(repoPath)} rev-parse --abbrev-ref HEAD`,
		);
		return branch.trim();
	}

	async branchExistsOnRemote(
		repoPath: string,
		branchName: string,
	): Promise<boolean> {
		const result = await this.ssh.exec(
			`git -C ${this.escapeArg(repoPath)} ls-remote --exit-code --heads origin ${this.escapeArg(branchName)}`,
		);
		return result.code === 0;
	}

	async status(repoPath: string): Promise<string> {
		return this.exec(
			`git --no-optional-locks -C ${this.escapeArg(repoPath)} status --porcelain=v1 -b -z`,
		);
	}
}
