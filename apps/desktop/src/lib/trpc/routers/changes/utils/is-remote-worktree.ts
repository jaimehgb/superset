import { projects, worktrees } from "@superset/local-db";
import { eq } from "drizzle-orm";
import { localDb } from "main/lib/local-db";

/**
 * Checks if a worktree path belongs to a remote project.
 * Looks up the worktree by path, then checks whether its project
 * has a remoteMachineId set.
 */
export function isRemoteWorktree(worktreePath: string): boolean {
	const worktree = localDb
		.select({ projectId: worktrees.projectId })
		.from(worktrees)
		.where(eq(worktrees.path, worktreePath))
		.get();

	if (!worktree) {
		return false;
	}

	const project = localDb
		.select({ remoteMachineId: projects.remoteMachineId })
		.from(projects)
		.where(eq(projects.id, worktree.projectId))
		.get();

	return project?.remoteMachineId != null;
}
