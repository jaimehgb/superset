export interface GitOperations {
	clone(url: string, targetPath: string): Promise<void>;
	worktreeAdd(
		repoPath: string,
		branch: string,
		worktreePath: string,
		startPoint: string,
	): Promise<void>;
	worktreeRemove(repoPath: string, worktreePath: string): Promise<void>;
	fetch(repoPath: string, remote?: string, branch?: string): Promise<void>;
	getDefaultBranch(repoPath: string): Promise<string>;
	getCurrentBranch(repoPath: string): Promise<string>;
	branchExistsOnRemote(repoPath: string, branchName: string): Promise<boolean>;
	status(repoPath: string): Promise<string>;
}
