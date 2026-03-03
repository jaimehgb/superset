import { existsSync } from "node:fs";
import type { SelectWorktree } from "@superset/local-db";
import { track } from "main/lib/analytics";
import { resolveGitOps } from "main/lib/git";
import { workspaceInitManager } from "main/lib/workspace-init-manager";
import {
	getWorkspaceRuntimeRegistry,
	RemoteRuntimeNotConnectedError,
} from "main/lib/workspace-runtime";
import { z } from "zod";
import { publicProcedure, router } from "../../..";
import { getActiveConnection } from "../../remote-machines";
import {
	clearWorkspaceDeletingStatus,
	deleteWorkspace,
	deleteWorktreeRecord,
	getProject,
	getWorkspace,
	getWorktree,
	hideProjectIfNoWorkspaces,
	markWorkspaceAsDeleting,
	updateActiveWorkspaceIfRemoved,
} from "../utils/db-helpers";
import {
	deleteLocalBranch,
	hasUncommittedChanges,
	hasUnpushedCommits,
	worktreeExists,
} from "../utils/git";
import { removeWorktreeFromDisk, runTeardown } from "../utils/teardown";

/** Resolve gitOps for a project (local or remote). Returns null if remote but disconnected. */
function getProjectGitOps(project: { remoteMachineId?: string | null }) {
	if (!project.remoteMachineId) {
		return resolveGitOps();
	}
	const sshConn = getActiveConnection(project.remoteMachineId);
	if (!sshConn) {
		return null;
	}
	return resolveGitOps(sshConn);
}

export const createDeleteProcedures = () => {
	return router({
		canDelete: publicProcedure
			.input(
				z.object({
					id: z.string(),
					skipGitChecks: z.boolean().optional(),
				}),
			)
			.query(async ({ input }) => {
				const workspace = getWorkspace(input.id);

				if (!workspace) {
					return {
						canDelete: false,
						reason: "Workspace not found",
						workspace: null,
						activeTerminalCount: 0,
						hasChanges: false,
						hasUnpushedCommits: false,
					};
				}

				if (workspace.deletingAt) {
					return {
						canDelete: false,
						reason: "Deletion already in progress",
						workspace: null,
						activeTerminalCount: 0,
						hasChanges: false,
						hasUnpushedCommits: false,
					};
				}

				let activeTerminalCount = 0;
				try {
					activeTerminalCount = await getWorkspaceRuntimeRegistry()
						.getForWorkspaceId(input.id)
						.terminal.getSessionCountByWorkspaceId(input.id);
				} catch (err) {
					if (!(err instanceof RemoteRuntimeNotConnectedError)) throw err;
				}

				if (workspace.type === "branch") {
					return {
						canDelete: true,
						reason: null,
						workspace,
						warning: null,
						activeTerminalCount,
						hasChanges: false,
						hasUnpushedCommits: false,
					};
				}

				if (input.skipGitChecks) {
					return {
						canDelete: true,
						reason: null,
						workspace,
						warning: null,
						activeTerminalCount,
						hasChanges: false,
						hasUnpushedCommits: false,
					};
				}

				const worktree = workspace.worktreeId
					? getWorktree(workspace.worktreeId)
					: null;
				const project = getProject(workspace.projectId);

				if (worktree && project) {
					const gitOps = getProjectGitOps(project);
					const isRemote = Boolean(project.remoteMachineId);

					// Remote but disconnected — allow deletion without git checks
					if (isRemote && !gitOps) {
						return {
							canDelete: true,
							reason: null,
							workspace,
							warning:
								"Remote machine not connected — git status could not be checked",
							activeTerminalCount,
							hasChanges: false,
							hasUnpushedCommits: false,
						};
					}

					if (gitOps) {
						try {
							const exists = await worktreeExists(
								project.mainRepoPath,
								worktree.path,
								gitOps,
							);

							if (!exists) {
								return {
									canDelete: true,
									reason: null,
									workspace,
									warning:
										"Worktree not found in git (may have been manually removed)",
									activeTerminalCount,
									hasChanges: false,
									hasUnpushedCommits: false,
								};
							}

							// Skip uncommitted/unpushed checks for remote — those use local filesystem
							let hasChanges = false;
							let unpushedCommits = false;
							if (!isRemote) {
								[hasChanges, unpushedCommits] = await Promise.all([
									hasUncommittedChanges(worktree.path),
									hasUnpushedCommits(worktree.path),
								]);
							}

							return {
								canDelete: true,
								reason: null,
								workspace,
								warning: null,
								activeTerminalCount,
								hasChanges,
								hasUnpushedCommits: unpushedCommits,
							};
						} catch (error) {
							return {
								canDelete: false,
								reason: `Failed to check worktree status: ${error instanceof Error ? error.message : String(error)}`,
								workspace,
								activeTerminalCount,
								hasChanges: false,
								hasUnpushedCommits: false,
							};
						}
					}
				}

				return {
					canDelete: true,
					reason: null,
					workspace,
					warning: "No associated worktree found",
					activeTerminalCount,
					hasChanges: false,
					hasUnpushedCommits: false,
				};
			}),

		delete: publicProcedure
			.input(
				z.object({
					id: z.string(),
					deleteLocalBranch: z.boolean().optional(),
					force: z.boolean().optional(),
				}),
			)
			.mutation(async ({ input }) => {
				const workspace = getWorkspace(input.id);

				if (!workspace) {
					return { success: false, error: "Workspace not found" };
				}

				console.log(
					`[workspace/delete] Starting deletion of "${workspace.name}" (${input.id})`,
				);

				markWorkspaceAsDeleting(input.id);
				updateActiveWorkspaceIfRemoved(input.id);

				if (workspaceInitManager.isInitializing(input.id)) {
					console.log(
						`[workspace/delete] Cancelling init for ${input.id}, waiting for completion...`,
					);
					workspaceInitManager.cancel(input.id);
					try {
						await workspaceInitManager.waitForInit(input.id, 30000);
					} catch (error) {
						console.error(
							`[workspace/delete] Failed to wait for init cancellation:`,
							error,
						);
						clearWorkspaceDeletingStatus(input.id);
						return {
							success: false,
							error:
								"Failed to cancel workspace initialization. Please try again.",
						};
					}
				}

				const project = getProject(workspace.projectId);
				const isRemote = Boolean(project?.remoteMachineId);

				let worktree: SelectWorktree | undefined;

				let terminalPromise: Promise<{ killed: number; failed: number }>;
				try {
					terminalPromise = getWorkspaceRuntimeRegistry()
						.getForWorkspaceId(input.id)
						.terminal.killByWorkspaceId(input.id);
				} catch (err) {
					if (!(err instanceof RemoteRuntimeNotConnectedError)) throw err;
					terminalPromise = Promise.resolve({ killed: 0, failed: 0 });
				}

				let teardownPromise:
					| Promise<{ success: boolean; error?: string; output?: string }>
					| undefined;
				if (workspace.type === "worktree" && workspace.worktreeId) {
					worktree = getWorktree(workspace.worktreeId);

					// Skip teardown for remote projects (local scripts don't apply)
					if (worktree && project && !isRemote && existsSync(worktree.path)) {
						teardownPromise = runTeardown({
							mainRepoPath: project.mainRepoPath,
							worktreePath: worktree.path,
							workspaceName: workspace.name,
							projectId: project.id,
						});
					} else {
						console.warn(
							`[workspace/delete] Skipping teardown: worktree=${!!worktree}, project=${!!project}, remote=${isRemote}, pathExists=${worktree && !isRemote ? existsSync(worktree.path) : "N/A"}`,
						);
					}
				} else {
					console.log(
						`[workspace/delete] No teardown needed: type=${workspace.type}, worktreeId=${workspace.worktreeId ?? "null"}`,
					);
				}

				const [terminalResult, teardownResult] = await Promise.all([
					terminalPromise,
					teardownPromise ?? Promise.resolve({ success: true as const }),
				]);

				if (teardownResult && !teardownResult.success) {
					if (input.force) {
						console.warn(
							`[workspace/delete] Teardown failed but force=true, continuing deletion:`,
							teardownResult.error,
						);
					} else {
						console.error(
							`[workspace/delete] Teardown failed:`,
							teardownResult.error,
						);
						clearWorkspaceDeletingStatus(input.id);
						return {
							success: false,
							error: `Teardown failed: ${teardownResult.error}`,
							output: teardownResult.output,
						};
					}
				}

				if (worktree && project) {
					const gitOps = getProjectGitOps(project);

					if (isRemote && !gitOps) {
						// Remote but disconnected — skip worktree removal on remote,
						// just clean up DB records below
						console.warn(
							`[workspace/delete] Remote machine not connected, skipping remote worktree removal for ${worktree.path}`,
						);
					} else if (isRemote && gitOps) {
						await workspaceInitManager.acquireProjectLock(project.id);
						try {
							try {
								await gitOps.worktreeRemove(
									project.mainRepoPath,
									worktree.path,
								);
							} catch (error) {
								const msg =
									error instanceof Error ? error.message : String(error);
								if (
									!msg.includes("is not a working tree") &&
									!msg.includes("No such file or directory")
								) {
									clearWorkspaceDeletingStatus(input.id);
									return {
										success: false,
										error: `Failed to remove worktree: ${msg}`,
									};
								}
								console.warn(
									`[workspace/delete] Remote worktree not found, continuing: ${msg}`,
								);
							}
						} finally {
							workspaceInitManager.releaseProjectLock(project.id);
						}
					} else if (gitOps) {
						// Local project
						await workspaceInitManager.acquireProjectLock(project.id);
						try {
							const removeResult = await removeWorktreeFromDisk({
								mainRepoPath: project.mainRepoPath,
								worktreePath: worktree.path,
							});
							if (!removeResult.success) {
								clearWorkspaceDeletingStatus(input.id);
								return removeResult;
							}
						} finally {
							workspaceInitManager.releaseProjectLock(project.id);
						}
					}

					if (input.deleteLocalBranch && workspace.branch && gitOps) {
						try {
							if (isRemote) {
								await gitOps.raw(project.mainRepoPath, [
									"branch",
									"-D",
									workspace.branch,
								]);
							} else {
								await deleteLocalBranch({
									mainRepoPath: project.mainRepoPath,
									branch: workspace.branch,
								});
							}
						} catch (error) {
							console.error(
								`[workspace/delete] Branch cleanup failed (non-blocking):`,
								error instanceof Error ? error.message : String(error),
							);
						}
					}
				}

				deleteWorkspace(input.id);

				if (worktree) {
					deleteWorktreeRecord(worktree.id);
				}

				if (project) {
					hideProjectIfNoWorkspaces(workspace.projectId);
				}

				const terminalWarning =
					terminalResult.failed > 0
						? `${terminalResult.failed} terminal process(es) may still be running`
						: undefined;

				track("workspace_deleted", { workspace_id: input.id });

				workspaceInitManager.clearJob(input.id);

				return { success: true, terminalWarning };
			}),

		close: publicProcedure
			.input(z.object({ id: z.string() }))
			.mutation(async ({ input }) => {
				const workspace = getWorkspace(input.id);

				if (!workspace) {
					throw new Error("Workspace not found");
				}

				let terminalResult: { killed: number; failed: number };
				try {
					terminalResult = await getWorkspaceRuntimeRegistry()
						.getForWorkspaceId(input.id)
						.terminal.killByWorkspaceId(input.id);
				} catch (err) {
					if (!(err instanceof RemoteRuntimeNotConnectedError)) throw err;
					terminalResult = { killed: 0, failed: 0 };
				}

				deleteWorkspace(input.id);
				hideProjectIfNoWorkspaces(workspace.projectId);
				updateActiveWorkspaceIfRemoved(input.id);

				const terminalWarning =
					terminalResult.failed > 0
						? `${terminalResult.failed} terminal process(es) may still be running`
						: undefined;

				track("workspace_closed", { workspace_id: input.id });

				return { success: true, terminalWarning };
			}),

		canDeleteWorktree: publicProcedure
			.input(
				z.object({
					worktreeId: z.string(),
					skipGitChecks: z.boolean().optional(),
				}),
			)
			.query(async ({ input }) => {
				const worktree = getWorktree(input.worktreeId);

				if (!worktree) {
					return {
						canDelete: false,
						reason: "Worktree not found",
						worktree: null,
						hasChanges: false,
						hasUnpushedCommits: false,
					};
				}

				const project = getProject(worktree.projectId);

				if (!project) {
					return {
						canDelete: false,
						reason: "Project not found",
						worktree,
						hasChanges: false,
						hasUnpushedCommits: false,
					};
				}

				if (input.skipGitChecks) {
					return {
						canDelete: true,
						reason: null,
						worktree,
						warning: null,
						hasChanges: false,
						hasUnpushedCommits: false,
					};
				}

				const gitOps = getProjectGitOps(project);
				const isRemote = Boolean(project.remoteMachineId);

				// Remote but disconnected — allow deletion without git checks
				if (isRemote && !gitOps) {
					return {
						canDelete: true,
						reason: null,
						worktree,
						warning:
							"Remote machine not connected — git status could not be checked",
						hasChanges: false,
						hasUnpushedCommits: false,
					};
				}

				if (gitOps) {
					try {
						const exists = await worktreeExists(
							project.mainRepoPath,
							worktree.path,
							gitOps,
						);

						if (!exists) {
							return {
								canDelete: true,
								reason: null,
								worktree,
								warning:
									"Worktree not found in git (may have been manually removed)",
								hasChanges: false,
								hasUnpushedCommits: false,
							};
						}

						let hasChanges = false;
						let unpushedCommits = false;
						if (!isRemote) {
							[hasChanges, unpushedCommits] = await Promise.all([
								hasUncommittedChanges(worktree.path),
								hasUnpushedCommits(worktree.path),
							]);
						}

						return {
							canDelete: true,
							reason: null,
							worktree,
							warning: null,
							hasChanges,
							hasUnpushedCommits: unpushedCommits,
						};
					} catch (error) {
						return {
							canDelete: false,
							reason: `Failed to check worktree status: ${error instanceof Error ? error.message : String(error)}`,
							worktree,
							hasChanges: false,
							hasUnpushedCommits: false,
						};
					}
				}

				return {
					canDelete: true,
					reason: null,
					worktree,
					warning: null,
					hasChanges: false,
					hasUnpushedCommits: false,
				};
			}),

		deleteWorktree: publicProcedure
			.input(
				z.object({
					worktreeId: z.string(),
					force: z.boolean().optional(),
				}),
			)
			.mutation(async ({ input }) => {
				const worktree = getWorktree(input.worktreeId);

				if (!worktree) {
					return { success: false, error: "Worktree not found" };
				}

				const project = getProject(worktree.projectId);

				if (!project) {
					return { success: false, error: "Project not found" };
				}

				const isRemote = Boolean(project.remoteMachineId);
				const gitOps = getProjectGitOps(project);

				if (isRemote && !gitOps) {
					// Remote but disconnected — just clean up DB records
					console.warn(
						`[worktree/delete] Remote machine not connected, skipping remote worktree removal for ${worktree.path}`,
					);
				} else if (gitOps) {
					await workspaceInitManager.acquireProjectLock(project.id);

					try {
						const exists = await worktreeExists(
							project.mainRepoPath,
							worktree.path,
							gitOps,
						);

						if (exists) {
							// Skip teardown for remote projects
							if (!isRemote) {
								const teardownResult = await runTeardown({
									mainRepoPath: project.mainRepoPath,
									worktreePath: worktree.path,
									workspaceName: worktree.branch,
									projectId: project.id,
								});
								if (!teardownResult.success) {
									if (input.force) {
										console.warn(
											`[worktree/delete] Teardown failed but force=true, continuing deletion:`,
											teardownResult.error,
										);
									} else {
										return {
											success: false,
											error: `Teardown failed: ${teardownResult.error}`,
											output: teardownResult.output,
										};
									}
								}
							}
						}

						if (exists) {
							if (isRemote) {
								try {
									await gitOps.worktreeRemove(
										project.mainRepoPath,
										worktree.path,
									);
								} catch (error) {
									const msg =
										error instanceof Error ? error.message : String(error);
									if (
										!msg.includes("is not a working tree") &&
										!msg.includes("No such file or directory")
									) {
										return {
											success: false,
											error: `Failed to remove worktree: ${msg}`,
										};
									}
								}
							} else {
								const removeResult = await removeWorktreeFromDisk({
									mainRepoPath: project.mainRepoPath,
									worktreePath: worktree.path,
								});
								if (!removeResult.success) {
									return removeResult;
								}
							}
						} else {
							console.warn(
								`Worktree ${worktree.path} not found in git, skipping removal`,
							);
						}
					} finally {
						workspaceInitManager.releaseProjectLock(project.id);
					}
				}

				deleteWorktreeRecord(input.worktreeId);
				hideProjectIfNoWorkspaces(worktree.projectId);

				track("worktree_deleted", { worktree_id: input.worktreeId });

				return { success: true };
			}),
	});
};
