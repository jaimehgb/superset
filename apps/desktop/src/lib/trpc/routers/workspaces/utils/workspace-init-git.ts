/**
 * Wraps git utilities used by workspace-init.ts.
 *
 * This indirection exists so workspace-init.test.ts can mock this module
 * without polluting `./git` (which git.test.ts imports directly).
 * Bun's `mock.module` is process-global with no restore mechanism.
 *
 * IMPORTANT: Use import-then-assign (not `export { ... } from`) to break
 * ESM live binding chains — otherwise Bun's mock may trace through
 * re-exports and replace the original module.
 */
import {
	branchExistsOnRemote as _branchExistsOnRemote,
	createWorktree as _createWorktree,
	createWorktreeFromExistingBranch as _createWorktreeFromExistingBranch,
	fetchDefaultBranch as _fetchDefaultBranch,
	hasOriginRemote as _hasOriginRemote,
	refExistsLocally as _refExistsLocally,
	refreshDefaultBranch as _refreshDefaultBranch,
	removeWorktree as _removeWorktree,
	sanitizeGitError as _sanitizeGitError,
} from "./git";

export const branchExistsOnRemote = _branchExistsOnRemote;
export const createWorktree = _createWorktree;
export const createWorktreeFromExistingBranch =
	_createWorktreeFromExistingBranch;
export const fetchDefaultBranch = _fetchDefaultBranch;
export const hasOriginRemote = _hasOriginRemote;
export const refExistsLocally = _refExistsLocally;
export const refreshDefaultBranch = _refreshDefaultBranch;
export const removeWorktree = _removeWorktree;
export const sanitizeGitError = _sanitizeGitError;
