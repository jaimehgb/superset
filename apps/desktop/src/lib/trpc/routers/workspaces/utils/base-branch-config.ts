import type { GitOperations } from "main/lib/git";
import { LocalGitOperations } from "main/lib/git";

const defaultGitOps = new LocalGitOperations();

interface BranchConfigParams {
	repoPath: string;
	branch: string;
	gitOps?: GitOperations;
}

interface SetBranchBaseConfigParams extends BranchConfigParams {
	baseBranch: string;
	isExplicit: boolean;
}

interface BranchBaseConfig {
	baseBranch: string | null;
	isExplicit: boolean;
}

function parseBooleanConfig(value: string): boolean {
	const normalized = value.trim().toLowerCase();
	return (
		normalized === "true" ||
		normalized === "yes" ||
		normalized === "on" ||
		normalized === "1"
	);
}

export async function getBranchBaseConfig({
	repoPath,
	branch,
	gitOps = defaultGitOps,
}: BranchConfigParams): Promise<BranchBaseConfig> {
	const [baseOutput, explicitOutput] = await Promise.all([
		gitOps.configGet(repoPath, `branch.${branch}.base`).catch(() => ""),
		gitOps
			.raw(repoPath, ["config", "--bool", `branch.${branch}.base-explicit`])
			.catch(() => ""),
	]);

	return {
		baseBranch: baseOutput.trim() || null,
		isExplicit: parseBooleanConfig(explicitOutput),
	};
}

export async function setBranchBaseConfig({
	repoPath,
	branch,
	baseBranch,
	isExplicit,
	gitOps = defaultGitOps,
}: SetBranchBaseConfigParams): Promise<void> {
	await gitOps
		.configSet(repoPath, `branch.${branch}.base`, baseBranch)
		.catch(() => {});
	if (isExplicit) {
		await gitOps
			.configSet(repoPath, `branch.${branch}.base-explicit`, "true", ["--bool"])
			.catch(() => {});
		return;
	}

	await gitOps
		.configUnset(repoPath, `branch.${branch}.base-explicit`)
		.catch(() => {});
}

export async function unsetBranchBaseConfig({
	repoPath,
	branch,
	gitOps = defaultGitOps,
}: BranchConfigParams): Promise<void> {
	await Promise.all([
		gitOps.configUnset(repoPath, `branch.${branch}.base`).catch(() => {}),
		gitOps
			.configUnset(repoPath, `branch.${branch}.base-explicit`)
			.catch(() => {}),
	]);
}
