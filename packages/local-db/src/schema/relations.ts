import { relations } from "drizzle-orm";
import { projects, remoteMachines, workspaces, worktrees } from "./schema";

export const projectsRelations = relations(projects, ({ one, many }) => ({
	worktrees: many(worktrees),
	workspaces: many(workspaces),
	remoteMachine: one(remoteMachines, {
		fields: [projects.remoteMachineId],
		references: [remoteMachines.id],
	}),
}));

export const worktreesRelations = relations(worktrees, ({ one, many }) => ({
	project: one(projects, {
		fields: [worktrees.projectId],
		references: [projects.id],
	}),
	workspaces: many(workspaces),
}));

export const workspacesRelations = relations(workspaces, ({ one }) => ({
	project: one(projects, {
		fields: [workspaces.projectId],
		references: [projects.id],
	}),
	worktree: one(worktrees, {
		fields: [workspaces.worktreeId],
		references: [worktrees.id],
	}),
}));

export const remoteMachinesRelations = relations(
	remoteMachines,
	({ many }) => ({
		projects: many(projects),
	}),
);
