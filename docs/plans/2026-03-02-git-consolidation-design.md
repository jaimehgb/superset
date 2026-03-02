# Git Operations Consolidation Design

**Date:** 2026-03-02
**Status:** Approved
**Branch:** feat/remote-compute

## Problem

Git operations are scattered across 8+ files, with direct `simpleGit()` and `execFile("git"...)` calls bypassing the abstraction layer. The remote compute work introduced a proper `GitOperations` interface (`main/lib/git/types.ts`) with local/remote implementations, but the threading is incomplete and many consumers still bypass it.

### Current State

**Already built (remote compute):**
- `main/lib/git/types.ts` — `GitOperations` interface (20+ methods)
- `main/lib/git/local.ts` — `LocalGitOperations` wrapping `simpleGit`
- `main/lib/git/remote.ts` — `RemoteGitOperations` running git over SSH
- `main/lib/git/index.ts` — `resolveGitOps(sshConnection?)` factory
- `workspaces/utils/git.ts` — ~20 functions threaded with `gitOps?: GitOperations` (unstaged)

**Still bypassing:**
- `github/github.ts` — 3 raw `execFile("git"...)` calls, no remote guard
- `changes/git-operations.ts` — commit/push/pull/sync via direct `simpleGit`
- `changes/status.ts` — branch comparison, commit log via direct `simpleGit`
- `changes/staging.ts` — status queries via direct `simpleGit`
- `changes/branches.ts` — branch listing via direct `simpleGit`
- `changes/file-contents.ts` — file content at revision via direct `simpleGit`
- `changes/security/git-commands.ts` — staging/stash ops via direct `simpleGit`
- `projects/projects.ts` — init, clone, branch listing via direct `simpleGit`

**Bugs found:**
- `git-commands.ts`: `gitStageFiles` (line 150) and `gitUnstageFiles` (line 172) bypass `isRemoteWorktree()` guard
- `github/github.ts`: No remote guard at all — will fail silently on remote worktrees

## Decision

**Approach: Domain modules under `git/` + complete `GitOperations` threading**

1. Split the 1814-line `workspaces/utils/git.ts` into domain modules under `git/`
2. Complete the `gitOps?: GitOperations` threading for all functions
3. Extend the `GitOperations` interface with missing methods (staging, file content, commit/push/pull)
4. Migrate all bypass sites to import from the abstraction
5. Bake security (validators) into the abstraction as optional callbacks

## Architecture

### Module Structure

```
workspaces/utils/git/
├── index.ts              # Barrel re-export
├── core.ts               # simpleGit factory, shell env, errors, security types
├── status.ts             # getStatusNoLock, hasUncommittedChanges, getCommitFiles
├── branches.ts           # getCurrentBranch, getDefaultBranch, listBranches, etc.
├── worktrees.ts          # createWorktree, removeWorktree, listExternalWorktrees, etc.
├── remotes.ts            # hasOriginRemote, fetch, push, pull, sync, commit
├── diff.ts               # getAheadBehindCount, getHeadSha, isAncestor, getFileAtRevision
├── repo.ts               # initRepo, cloneRepo, getGitRoot
├── config.ts             # getBranchBaseConfig, setBranchBaseConfig (absorbs base-branch-config.ts)
├── github.ts             # getPrInfo, createWorktreeFromPr, createPR, mergePR
├── identity.ts           # getGitAuthorName, getGitHubUsername, generateBranchName
└── staging.ts            # gitStageFile, gitUnstageFile, gitStash, etc.
```

Every function in every module accepts `gitOps?: GitOperations` as its last parameter and delegates to it when provided. When omitted, falls back to local `simpleGit`.

### `GitOperations` Interface Extensions

The existing interface in `main/lib/git/types.ts` needs new methods:

```typescript
// Missing from current interface — needed for bypass site migration
interface GitOperations {
  // ... existing 20+ methods ...

  // Staging (from git-commands.ts)
  stageFile(repoPath: string, filePath: string): Promise<void>;
  stageFiles(repoPath: string, filePaths: string[]): Promise<void>;
  unstageFile(repoPath: string, filePath: string): Promise<void>;
  unstageFiles(repoPath: string, filePaths: string[]): Promise<void>;
  stageAll(repoPath: string): Promise<void>;
  unstageAll(repoPath: string): Promise<void>;
  discardAllUnstaged(repoPath: string): Promise<void>;
  discardAllStaged(repoPath: string): Promise<void>;
  checkoutFile(repoPath: string, filePath: string): Promise<void>;
  stash(repoPath: string): Promise<void>;
  stashIncludeUntracked(repoPath: string): Promise<void>;
  stashPop(repoPath: string): Promise<void>;

  // Remote operations (from git-operations.ts)
  commit(repoPath: string, message: string): Promise<{ hash: string }>;
  push(repoPath: string, options?: { setUpstream?: boolean }): Promise<void>;
  pull(repoPath: string): Promise<void>;

  // Diff/content (from file-contents.ts, status.ts)
  getHeadSha(repoPath: string): Promise<string>;
  isAncestor(repoPath: string, ancestor: string, descendant: string): Promise<boolean>;
  showFile(repoPath: string, spec: string): Promise<string>;
  getCommitFiles(repoPath: string, hash: string): Promise<{ path: string; status: string }[]>;

  // Branch queries (from branches.ts)
  getLocalBranchesWithDates(repoPath: string): Promise<Array<{ branch: string; lastCommitDate: number }>>;
  getRemoteBranchesWithDates(repoPath: string): Promise<Array<{ branch: string; lastCommitDate: number }>>;
  getUpstreamBranch(repoPath: string): Promise<string | null>;
  getTrackingDivergence(repoPath: string): Promise<{ pushCount: number; pullCount: number }>;
}
```

Both `LocalGitOperations` and `RemoteGitOperations` must implement these.

### Security: Validator Callbacks

Functions that need security validation accept optional validators:

```typescript
interface GitValidators {
  assertWorktree?: (worktreePath: string) => void;
  assertPath?: (filePath: string) => void;
}
```

This avoids coupling the git abstraction to the local database (where registered worktrees are tracked).

## Migration Plan

### Phase 1: Split monolith + barrel export (no consumer changes)
### Phase 2: Extend `GitOperations` interface + implementations
### Phase 3: Add new functions to modules
### Phase 4: Migrate consumers (file by file)
### Phase 5: Delete absorbed files
### Phase 6: Add CI lint rule

## Files Deleted After Migration

- `changes/security/git-commands.ts` → absorbed into `git/staging.ts`
- `changes/git-utils.ts` → `isUpstreamMissingError` absorbed into `git/remotes.ts`
- `workspaces/utils/base-branch-config.ts` → absorbed into `git/config.ts`

## Files That Become Thin tRPC Wrappers

- `changes/git-operations.ts`
- `changes/status.ts`
- `changes/staging.ts`
- `changes/branches.ts`
- `changes/file-contents.ts`
