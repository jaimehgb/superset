# Git Operations Consolidation — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Consolidate all direct `simpleGit`/`execFile("git"...)` calls behind the `GitOperations` interface and domain-organized `git/` modules, so every git operation works identically for local and remote worktrees.

**Architecture:** Split the 1814-line `workspaces/utils/git.ts` monolith into domain modules under `workspaces/utils/git/`. Extend the `GitOperations` interface (`main/lib/git/types.ts`) with missing methods. Thread `gitOps?: GitOperations` through all functions. Migrate all bypass sites.

**Tech Stack:** TypeScript, simple-git, Node child_process, tRPC, Biome

**Design Doc:** `docs/plans/2026-03-02-git-consolidation-design.md`

**Existing Abstraction:** `apps/desktop/src/main/lib/git/` — `GitOperations` interface + `LocalGitOperations` + `RemoteGitOperations` + `resolveGitOps()` factory

---

## Key File Paths

```
BASE     = apps/desktop/src/lib/trpc/routers
GIT_UTIL = $BASE/workspaces/utils/git        # currently git.ts → becomes git/ directory
GIT_CORE = apps/desktop/src/main/lib/git     # GitOperations interface + implementations
SEC      = $BASE/changes/security
CHG      = $BASE/changes
PRJ      = $BASE/projects
```

## Existing Tests

- `$GIT_UTIL.test.ts` — tests `getDefaultBranch`, `createWorktree` hook tolerance, `getCurrentBranch`, `parsePrUrl`, shell env
- `$CHG/git-operations.test.ts` — tests `isUpstreamMissingError` and error patterns

---

## Phase 1: Extend `GitOperations` Interface

Before splitting the monolith, add the methods that bypass sites need.

### Task 1: Add staging methods to `GitOperations`

**Files:**
- Modify: `$GIT_CORE/types.ts`
- Modify: `$GIT_CORE/local.ts`
- Modify: `$GIT_CORE/remote.ts`

**Step 1: Extend the interface in `types.ts`**

Add after the `// ─── Low-level` section:

```typescript
	// ─── Staging ─────────────────────────────────────────────────
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
```

**Step 2: Implement in `local.ts`**

Add corresponding methods using `simpleGit(repoPath)`. Mirror the logic from `$SEC/git-commands.ts` lines 27-281 but without the security assertions (those are handled at the caller level).

**Step 3: Implement in `remote.ts`**

Add corresponding methods using `this.git(repoPath, [...])`. For example:
```typescript
async stageFile(repoPath: string, filePath: string): Promise<void> {
  await this.git(repoPath, ["add", "--", filePath]);
}
```

**Step 4: Verify compilation**

Run: `cd apps/desktop && npx tsc --noEmit`

**Step 5: Commit**

```bash
git add apps/desktop/src/main/lib/git/
git commit -m "feat(git): add staging/stash methods to GitOperations interface"
```

---

### Task 2: Add remote operations to `GitOperations`

**Files:**
- Modify: `$GIT_CORE/types.ts`
- Modify: `$GIT_CORE/local.ts`
- Modify: `$GIT_CORE/remote.ts`

**Step 1: Extend the interface**

```typescript
	// ─── Remote operations ───────────────────────────────────────
	commit(repoPath: string, message: string): Promise<{ hash: string }>;
	push(repoPath: string, args?: string[]): Promise<void>;
	pull(repoPath: string, args?: string[]): Promise<void>;
	switchBranch(repoPath: string, branch: string): Promise<void>;
```

**Step 2: Implement in `local.ts`**

```typescript
async commit(repoPath: string, message: string): Promise<{ hash: string }> {
  const git = simpleGit(repoPath);
  const result = await git.commit(message);
  return { hash: result.commit };
}

async push(repoPath: string, args: string[] = []): Promise<void> {
  const git = simpleGit(repoPath);
  await git.push(args);
}

async pull(repoPath: string, args: string[] = []): Promise<void> {
  const git = simpleGit(repoPath);
  await git.pull(args);
}

async switchBranch(repoPath: string, branch: string): Promise<void> {
  const git = simpleGit(repoPath);
  try {
    await git.raw(["switch", branch]);
  } catch (err) {
    if (String(err).includes("is not a git command")) {
      await git.checkout(branch);
    } else {
      throw err;
    }
  }
}
```

**Step 3: Implement in `remote.ts`**

```typescript
async commit(repoPath: string, message: string): Promise<{ hash: string }> {
  await this.git(repoPath, ["commit", "-m", this.shellEscape(message)]);
  const hash = await this.git(repoPath, ["rev-parse", "HEAD"]);
  return { hash: hash.trim() };
}

async push(repoPath: string, args: string[] = []): Promise<void> {
  await this.git(repoPath, ["push", ...args]);
}

async pull(repoPath: string, args: string[] = []): Promise<void> {
  await this.git(repoPath, ["pull", ...args]);
}

async switchBranch(repoPath: string, branch: string): Promise<void> {
  try {
    await this.git(repoPath, ["switch", branch]);
  } catch {
    await this.git(repoPath, ["checkout", branch]);
  }
}
```

**Step 4: Verify and commit**

Run: `cd apps/desktop && npx tsc --noEmit`

```bash
git add apps/desktop/src/main/lib/git/
git commit -m "feat(git): add commit/push/pull/switch to GitOperations interface"
```

---

### Task 3: Add diff/content methods to `GitOperations`

**Files:**
- Modify: `$GIT_CORE/types.ts`
- Modify: `$GIT_CORE/local.ts`
- Modify: `$GIT_CORE/remote.ts`

**Step 1: Extend the interface**

```typescript
	// ─── Diff / content ──────────────────────────────────────────
	getHeadSha(repoPath: string): Promise<string>;
	isAncestor(repoPath: string, ancestor: string, descendant: string): Promise<boolean>;
	showFile(repoPath: string, spec: string): Promise<string | null>;
	catFileSize(repoPath: string, spec: string): Promise<number>;
	getUpstreamBranch(repoPath: string): Promise<string | null>;
	getTrackingDivergence(repoPath: string): Promise<{ pushCount: number; pullCount: number; hasUpstream: boolean }>;
	getLocalBranchesWithDates(repoPath: string): Promise<Array<{ branch: string; lastCommitDate: number }>>;
	getRemoteBranchesWithDates(repoPath: string): Promise<Array<{ branch: string; lastCommitDate: number; lastCommitMessage?: string }>>;
```

**Step 2: Implement in both `local.ts` and `remote.ts`**

Local uses `simpleGit`, remote uses `this.git()`. Key implementations:

```typescript
// local.ts
async getHeadSha(repoPath: string): Promise<string> {
  const git = simpleGit(repoPath);
  return (await git.revparse(["HEAD"])).trim();
}

async isAncestor(repoPath: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    const git = simpleGit(repoPath);
    await git.raw(["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

async showFile(repoPath: string, spec: string): Promise<string | null> {
  try {
    const git = simpleGit(repoPath);
    return await git.show([spec]);
  } catch {
    return null;
  }
}

async catFileSize(repoPath: string, spec: string): Promise<number> {
  const git = simpleGit(repoPath);
  const out = await git.raw(["cat-file", "-s", spec]);
  return Number.parseInt(out.trim(), 10);
}

async getUpstreamBranch(repoPath: string): Promise<string | null> {
  try {
    const git = simpleGit(repoPath);
    const out = await git.raw(["rev-parse", "--abbrev-ref", "@{upstream}"]);
    return out.trim() || null;
  } catch {
    return null;
  }
}

async getTrackingDivergence(repoPath: string) {
  try {
    const git = simpleGit(repoPath);
    const out = await git.raw(["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
    const [behind = "0", ahead = "0"] = out.trim().split(/\s+/);
    return { pullCount: Number.parseInt(behind, 10), pushCount: Number.parseInt(ahead, 10), hasUpstream: true };
  } catch {
    return { pushCount: 0, pullCount: 0, hasUpstream: false };
  }
}

async getLocalBranchesWithDates(repoPath: string) {
  const git = simpleGit(repoPath);
  const out = await git.raw(["for-each-ref", "--sort=-committerdate", "--format=%(refname:short) %(committerdate:unix)", "refs/heads/"]);
  if (!out.trim()) return [];
  return out.trim().split("\n").map((line) => {
    const lastSpace = line.lastIndexOf(" ");
    return { branch: line.slice(0, lastSpace), lastCommitDate: Number.parseInt(line.slice(lastSpace + 1), 10) };
  });
}

async getRemoteBranchesWithDates(repoPath: string) {
  const git = simpleGit(repoPath);
  const out = await git.raw(["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)%09%(committerdate:unix)%09%(subject)", "refs/remotes/origin/"]);
  if (!out.trim()) return [];
  return out.trim().split("\n").filter((l) => !l.includes("origin/HEAD")).map((line) => {
    const [ref, dateStr, ...msg] = line.split("\t");
    return { branch: ref.replace("origin/", ""), lastCommitDate: Number.parseInt(dateStr, 10), lastCommitMessage: msg.join("\t") };
  });
}
```

Remote implementations follow the same logic using `this.git(repoPath, [...])`.

**Step 3: Verify and commit**

Run: `cd apps/desktop && npx tsc --noEmit`

```bash
git add apps/desktop/src/main/lib/git/
git commit -m "feat(git): add diff/content/branch-query methods to GitOperations"
```

---

## Phase 2: Split `workspaces/utils/git.ts` Into Domain Modules

### Task 4: Create `git/core.ts`

**Files:**
- Create: `$GIT_UTIL/core.ts`

Extract from `git.ts`:
- All top-level imports (lines 1-14)
- `execFileAsync` definition
- `NotGitRepoError` class (lines 16-21)
- `GIT_EXIT_CODES` and `GIT_ERROR_PATTERNS` constants
- `getGitWithShellPath()` — centralized factory (currently duplicated in `git-commands.ts` and `git-operations.ts`)
- Re-export `GitOperations` type from `main/lib/git`
- `GitValidators` interface for security callbacks

```typescript
export interface GitValidators {
  assertWorktree?: (worktreePath: string) => void;
  assertPath?: (filePath: string) => void;
}
```

---

### Task 5: Create `git/status.ts`

**Files:**
- Create: `$GIT_UTIL/status.ts`

Move from `git.ts`:
- `getStatusNoLock` (uses `execFileAsync`, accepts `gitOps?`)
- `hasUncommittedChanges` (delegates to `getStatusNoLock`)

---

### Task 6: Create `git/branches.ts`

**Files:**
- Create: `$GIT_UTIL/branches.ts`

Move from `git.ts`:
- `getCurrentBranch`, `getDefaultBranch`, `listBranches`
- `checkBranchCheckoutSafety`, `checkoutBranch`, `refExistsLocally`
- `safeCheckoutBranch`, `deleteLocalBranch`, `detectBaseBranch`

Add new wrapper functions that delegate to `gitOps`:
- `getUpstreamBranch(repoPath, gitOps?)` → `gitOps.getUpstreamBranch(repoPath)`
- `getLocalBranchesWithDates(repoPath, gitOps?)` → `gitOps.getLocalBranchesWithDates(repoPath)`
- `getRemoteBranchesWithDates(repoPath, gitOps?)` → `gitOps.getRemoteBranchesWithDates(repoPath)`
- `getCheckedOutBranches(mainRepoPath, gitOps?)` — parses `gitOps.worktreeList()`
- `gitSwitchBranch(worktreePath, branch, gitOps?)` → `gitOps.switchBranch()`

---

### Task 7: Create `git/worktrees.ts`

**Files:**
- Create: `$GIT_UTIL/worktrees.ts`

Move from `git.ts`:
- `createWorktree`, `createWorktreeFromExistingBranch`, `removeWorktree`
- `worktreeExists`, `listExternalWorktrees`, `getBranchWorktreePath`
- Private helpers: `isWorktreeRegistered`, `execWorktreeAdd`

---

### Task 8: Create `git/remotes.ts`

**Files:**
- Create: `$GIT_UTIL/remotes.ts`

Move from `git.ts`:
- `hasOriginRemote`, `fetchDefaultBranch`, `refreshDefaultBranch`
- `checkNeedsRebase`, `hasUnpushedCommits`, `branchExistsOnRemote`
- `BranchExistsResult` type, `categorizeBranchExistsError` helper

Add new functions:
- `isUpstreamMissingError(message)` — from `$CHG/git-utils.ts`
- `commit(worktreePath, message, gitOps?)` → delegates to `gitOps.commit()`
- `push(worktreePath, options?, gitOps?)` — with `--set-upstream` auto-retry
- `pull(worktreePath, gitOps?)` → `gitOps.pull(repoPath, ["--rebase"])`
- `sync(worktreePath, gitOps?)` — pull then push
- `fetchCurrentBranch(worktreePath, gitOps?)` — fetch origin for current branch
- `shouldRetryPushWithUpstream(message)` — from `git-operations.ts`

---

### Task 9: Create `git/diff.ts`

**Files:**
- Create: `$GIT_UTIL/diff.ts`

Move from `git.ts`:
- `getAheadBehindCount`, `checkNeedsRebase` (or keep in remotes — decide by fit)

Add new functions:
- `getHeadSha(repoPath, gitOps?)` → `gitOps.getHeadSha(repoPath)`
- `isAncestor(repoPath, ancestor, descendant, gitOps?)` → `gitOps.isAncestor()`
- `getTrackingDivergence(repoPath, gitOps?)` → `gitOps.getTrackingDivergence()`
- `getCommitsAheadOfBase(repoPath, baseBranch, gitOps?)` — structured commit log via `gitOps.raw()`
- `getFileAtRevision(repoPath, spec, maxBytes?, gitOps?)` — size check + show via `gitOps`
- `getCommitFiles(repoPath, hash, gitOps?)` — `diff-tree` via `gitOps.raw()`

---

### Task 10: Create `git/repo.ts`

**Files:**
- Create: `$GIT_UTIL/repo.ts`

Move from `git.ts`:
- `getGitRoot` (already accepts `gitOps?`)

Add new:
- `initRepo(repoPath, gitOps?)` — from `projects.ts` line 68
- `cloneRepo(url, targetPath, gitOps?)` → `gitOps.clone()`

---

### Task 11: Create `git/config.ts`

**Files:**
- Create: `$GIT_UTIL/config.ts`

Absorb `base-branch-config.ts` entirely. Thread through `gitOps?`:

```typescript
export async function getBranchBaseConfig(
  { repoPath, branch }: BranchConfigParams,
  gitOps?: GitOperations,
): Promise<BranchBaseConfig> {
  if (gitOps) {
    const [baseOutput, explicitOutput] = await Promise.all([
      gitOps.configGet(repoPath, `branch.${branch}.base`).catch(() => ""),
      gitOps.configGet(repoPath, `branch.${branch}.base-explicit`).catch(() => ""),
    ]);
    return { baseBranch: baseOutput.trim() || null, isExplicit: parseBooleanConfig(explicitOutput) };
  }
  // ... existing simpleGit fallback
}
```

Note: `base-branch-config.ts` already delegates through `GitOperations` in the worktree (the agent reported zero direct calls). Verify this — if true, this file just needs to move, not change.

---

### Task 12: Create `git/github.ts`

**Files:**
- Create: `$GIT_UTIL/github.ts`

Move from `git.ts`:
- `PullRequestInfo` interface, `getPrLocalBranchName`, `parsePrUrl`
- `getPrInfo`, `createWorktreeFromPr`

Add new:
- `createPR(worktreePath, gitOps?)` — from `git-operations.ts`
- `mergePR(worktreePath, strategy, gitOps?)` — from `git-operations.ts`

---

### Task 13: Create `git/identity.ts`

**Files:**
- Create: `$GIT_UTIL/identity.ts`

Move from `git.ts`:
- `getGitAuthorName`, `getGitHubUsername`, `getAuthorPrefix`, `getBranchPrefix`
- `generateBranchName`, `sanitizeAuthorPrefix`, `sanitizeBranchName`, `sanitizeBranchNameWithMaxLength`
- `friendlyWords` import

---

### Task 14: Create `git/staging.ts`

**Files:**
- Create: `$GIT_UTIL/staging.ts`

Move from `$SEC/git-commands.ts`:
- All 13 staging/stash/discard functions

Thread `gitOps?` and `validators?`:

```typescript
export async function gitStageFile(
  worktreePath: string,
  filePath: string,
  gitOps?: GitOperations,
  validators?: GitValidators,
): Promise<void> {
  validators?.assertWorktree?.(worktreePath);
  validators?.assertPath?.(filePath);
  if (gitOps) {
    await gitOps.stageFile(worktreePath, filePath);
    return;
  }
  const git = await getGitWithShellPath(worktreePath);
  await git.add(["--", filePath]);
}
```

**Bug fix:** `gitStageFiles` and `gitUnstageFiles` currently bypass `getGitWithShellPath()` and create `simpleGit()` directly (missing the remote guard). The new implementation fixes this by going through `gitOps` when provided.

---

### Task 15: Create `git/index.ts` barrel and delete old `git.ts`

**Files:**
- Create: `$GIT_UTIL/index.ts`
- Delete: `$BASE/workspaces/utils/git.ts`

**Step 1: Create barrel**

```typescript
export * from "./core";
export * from "./status";
export * from "./branches";
export * from "./worktrees";
export * from "./remotes";
export * from "./diff";
export * from "./repo";
export * from "./config";
export * from "./github";
export * from "./identity";
export * from "./staging";
```

**Step 2: Delete old `git.ts`**

**Step 3: Verify imports resolve**

Run: `cd apps/desktop && npx tsc --noEmit`

All `import { ... } from "../git"` → resolves to `../git/index.ts`.

**Step 4: Run existing tests**

Run: `cd apps/desktop && bun test src/lib/trpc/routers/workspaces/utils/git.test.ts`

**Step 5: Commit**

```bash
git add apps/desktop/src/lib/trpc/routers/workspaces/utils/git/
git add -u
git commit -m "refactor(git): split git.ts monolith into domain modules under git/"
```

---

## Phase 3: Migrate Consumers

### Task 16: Migrate `github/github.ts`

**Files:**
- Modify: `$BASE/workspaces/utils/github/github.ts`

Replace 3 `execFile("git"...)` calls:
1. Line 35-40: `execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"])` → `getCurrentBranch(worktreePath)`
2. Line 233-237: `execFileAsync("git", ["-C", worktreePath, "rev-parse", "HEAD"])` → `getHeadSha(worktreePath)`
3. Lines 249-264: `execFileAsync("git", [..., "merge-base", "--is-ancestor", ...])` → `isAncestor(worktreePath, a, b)`

Remove `execFile`/`promisify` imports if no longer needed.

**Also fix:** Add `isRemoteWorktree()` guard at the top of `fetchGitHubPRStatus` to return `null` early for remote worktrees (the function has no remote guard at all).

Commit: `refactor(git): migrate github.ts to use git abstraction`

---

### Task 17: Migrate `changes/staging.ts`

**Files:**
- Modify: `$CHG/staging.ts`

Replace `import simpleGit from "simple-git"` → `import { getStatusNoLock } from "../workspaces/utils/git"`.
Replace `simpleGit(worktreePath).status()` in `getUntrackedFilePaths` and `getStagedNewFilePaths` with `getStatusNoLock(worktreePath)`.

Update imports of staging functions from `./security` to `../workspaces/utils/git` (or keep the re-export chain — decide per taste).

Commit: `refactor(git): migrate changes/staging.ts to git abstraction`

---

### Task 18: Migrate `changes/branches.ts`

**Files:**
- Modify: `$CHG/branches.ts`

Remove `import simpleGit from "simple-git"`.
Remove `import { ... } from "../workspaces/utils/base-branch-config"` → import from `../workspaces/utils/git`.
Replace `simpleGit().branch(["-a"])` → `listBranches()`.
Replace local `getDefaultBranch` duplicate → import from abstraction.
Replace `for-each-ref` calls → `getLocalBranchesWithDates()`.
Replace `worktree list` → `getCheckedOutBranches()`.

Commit: `refactor(git): migrate changes/branches.ts to git abstraction`

---

### Task 19: Migrate `changes/status.ts`

**Files:**
- Modify: `$CHG/status.ts`

Remove `import simpleGit from "simple-git"`.
Replace direct calls with:
- `getAheadBehindCount()` for rev-list counts
- `getCommitsAheadOfBase()` for commit log
- `getTrackingDivergence()` for upstream counts
- `getUpstreamBranch()` for tracking ref name
- `getCommitFiles()` for diff-tree

The `diff --name-status`/`--numstat` calls for file-level changes can use `gitOps.raw()` if no dedicated function covers them, or add a `getFileDiffAgainstBase()` wrapper.

Commit: `refactor(git): migrate changes/status.ts to git abstraction`

---

### Task 20: Migrate `changes/file-contents.ts`

**Files:**
- Modify: `$CHG/file-contents.ts`

Remove `import simpleGit from "simple-git"`.
Replace `safeGitShow` / `git.show([spec])` / `git.raw(["cat-file", "-s", spec])` calls with `getFileAtRevision(worktreePath, spec, maxBytes)`.

Commit: `refactor(git): migrate changes/file-contents.ts to git abstraction`

---

### Task 21: Migrate `changes/git-operations.ts`

**Files:**
- Modify: `$CHG/git-operations.ts`

Remove `import simpleGit from "simple-git"`.
Remove `import { execWithShellEnv, getProcessEnvWithShellPath } from "..."`.
Remove private helpers: `getGitWithShellPath`, `hasUpstreamBranch`, `fetchCurrentBranch`, `pushWithSetUpstream`, `shouldRetryPushWithUpstream`.

Each tRPC procedure becomes a thin wrapper:

```typescript
commit: publicProcedure
  .input(z.object({ worktreePath: z.string(), message: z.string() }))
  .mutation(async ({ input }) => {
    assertRegisteredWorktree(input.worktreePath);
    const result = await gitCommit(input.worktreePath, input.message);
    return { success: true, hash: result.hash };
  }),
```

Preserve TRPCError wrapping for user-friendly error messages.

Commit: `refactor(git): migrate git-operations.ts to thin tRPC wrappers`

---

### Task 22: Migrate `projects/projects.ts`

**Files:**
- Modify: `$PRJ/projects.ts`

Remove `import simpleGit from "simple-git"`.
Replace:
- `initGitRepo` local function → `initRepo()` from abstraction
- `simpleGit().clone()` → `cloneRepo()`
- `simpleGit().getRemotes()` → `hasOriginRemote()`
- `simpleGit().branch(["-a"])` → `listBranches()`
- `for-each-ref` calls → `getLocalBranchesWithDates()`, `getRemoteBranchesWithDates()`

Commit: `refactor(git): migrate projects.ts to git abstraction`

---

### Task 23: Delete absorbed files

**Files:**
- Delete: `$SEC/git-commands.ts`
- Delete: `$CHG/git-utils.ts`
- Delete: `$BASE/workspaces/utils/base-branch-config.ts`

Update the security barrel (`$SEC/index.ts`) to re-export staging functions from `../workspaces/utils/git` instead of `./git-commands`.

Verify: `cd apps/desktop && npx tsc --noEmit`

Commit: `refactor(git): delete files absorbed into git abstraction`

---

## Phase 4: Validate

### Task 24: Run full test suite and typecheck

**Step 1:** `cd apps/desktop && bun test src/lib/trpc/routers/workspaces/utils/git.test.ts`
**Step 2:** `cd apps/desktop && bun test src/lib/trpc/routers/changes/git-operations.test.ts`
**Step 3:** `cd apps/desktop && bun test`
**Step 4:** `bun run typecheck`
**Step 5:** `bun run lint`

Fix any issues. Commit fixes.

---

## Phase 5: Prevent Future Drift

### Task 25: Add CI lint rule

Create `scripts/check-no-direct-git.sh`:

```bash
#!/bin/bash
ALLOWED="workspaces/utils/git/|main/lib/git/"
SEARCH="apps/desktop/src/"

VIOLATIONS=$(grep -rn "from ['\"]simple-git['\"]" "$SEARCH" \
  --include="*.ts" \
  | grep -vE "$ALLOWED" \
  | grep -v "node_modules" \
  | grep -v ".test.ts")

if [ -n "$VIOLATIONS" ]; then
  echo "ERROR: Direct simpleGit imports found outside git abstraction:"
  echo "$VIOLATIONS"
  exit 1
fi

echo "OK: No direct git usage outside abstraction."
```

Commit: `ci: add lint rule to prevent direct git usage outside abstraction`

---

## Summary

| Phase | Tasks | Description |
|---|---|---|
| 1. Extend `GitOperations` | 1-3 | Add staging, remote ops, diff/content to interface + implementations |
| 2. Split monolith | 4-15 | Create domain modules, barrel export, delete old `git.ts` |
| 3. Migrate consumers | 16-23 | Replace all direct calls, delete absorbed files |
| 4. Validate | 24 | Full test suite + typecheck + lint |
| 5. Prevent drift | 25 | CI lint rule |

**Total: 25 tasks, ~12 commits**

Each consumer migration (Phase 3) is independently deployable and revertable.
