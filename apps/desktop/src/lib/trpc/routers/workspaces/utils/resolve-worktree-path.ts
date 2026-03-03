import { homedir } from "node:os";
import { join, posix } from "node:path";
import { type SelectProject, settings } from "@superset/local-db";
import { localDb } from "main/lib/local-db";
import { SUPERSET_DIR_NAME, WORKTREES_DIR_NAME } from "shared/constants";

/** Resolves base dir: project override > global setting > default (~/.superset/worktrees) */
export function resolveWorktreePath(
	project: Pick<
		SelectProject,
		"name" | "worktreeBaseDir" | "mainRepoPath" | "remoteMachineId"
	>,
	branch: string,
): string {
	// Remote projects: place worktrees next to the repo on the remote filesystem
	if (project.remoteMachineId) {
		const parentDir = posix.dirname(project.mainRepoPath);
		return posix.join(parentDir, ".worktrees", project.name, branch);
	}

	if (project.worktreeBaseDir) {
		return join(project.worktreeBaseDir, project.name, branch);
	}

	const row = localDb.select().from(settings).get();
	const baseDir =
		row?.worktreeBaseDir ??
		join(homedir(), SUPERSET_DIR_NAME, WORKTREES_DIR_NAME);

	return join(baseDir, project.name, branch);
}
