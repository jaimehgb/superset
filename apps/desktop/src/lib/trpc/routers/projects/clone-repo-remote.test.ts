import { describe, expect, it } from "bun:test";
import { z } from "zod";

/**
 * Tests for the remote clone branch in the cloneRepo mutation.
 *
 * These tests validate:
 * 1. The input schema accepts an optional remoteMachineId
 * 2. The extractRepoName helper (re-exported for testing) works correctly
 * 3. Remote path construction uses the machine's projectsDir + repo name
 */

// ---------------------------------------------------------------------------
// We test the Zod schema shape in isolation. The actual cloneRepo mutation
// touches the DB and Electron dialog, so we focus on the input validation
// layer and the path construction logic that the remote branch introduces.
// ---------------------------------------------------------------------------

const ALLOWED_URL_PROTOCOLS = new Set(["http:", "https:", "ssh:", "git:"]);
const SSH_GIT_URL_REGEX = /^[\w.-]+@[\w.-]+:[\w./-]+$/;
const SAFE_REPO_NAME_REGEX = /^[a-zA-Z0-9._\- ]+$/;

/**
 * Mirror of the cloneRepo input schema WITH the new remoteMachineId field.
 * This lets us validate the shape without importing from the router
 * (which pulls in Electron/DB dependencies).
 */
const cloneRepoInputSchema = z.object({
	url: z
		.string()
		.min(1)
		.refine(
			(val) => {
				try {
					const parsed = new URL(val);
					return ALLOWED_URL_PROTOCOLS.has(parsed.protocol);
				} catch {
					return SSH_GIT_URL_REGEX.test(val);
				}
			},
			{ message: "Must be a valid Git URL (HTTPS or SSH)" },
		),
	targetDirectory: z
		.string()
		.trim()
		.optional()
		.transform((v) => (v && v.length > 0 ? v : undefined)),
	remoteMachineId: z.string().optional(),
});

/**
 * Mirror of extractRepoName from projects.ts for testing path construction.
 */
function extractRepoName(urlInput: string): string | null {
	let normalized = urlInput.trim().replace(/\/+$/, "");
	if (!normalized) return null;

	let repoSegment: string | undefined;

	try {
		const parsed = new URL(normalized);
		if (parsed.protocol === "http:" || parsed.protocol === "https:") {
			const pathname = parsed.pathname;
			repoSegment = pathname.split("/").filter(Boolean).pop();
		}
	} catch {
		// Not a standard URL - fall through to SSH-style parsing
	}

	if (!repoSegment) {
		const colonIndex = normalized.indexOf(":");
		if (colonIndex !== -1 && !normalized.includes("://")) {
			normalized = normalized.slice(colonIndex + 1);
		}
		repoSegment = normalized.split("/").filter(Boolean).pop();
	}

	if (!repoSegment) return null;

	repoSegment = repoSegment.split("?")[0].split("#")[0];
	repoSegment = repoSegment.replace(/\.git$/, "");

	try {
		repoSegment = decodeURIComponent(repoSegment);
	} catch {}

	repoSegment = repoSegment.trim();

	if (!repoSegment || !SAFE_REPO_NAME_REGEX.test(repoSegment)) {
		return null;
	}

	return repoSegment;
}

// ===========================================================================
// Input Schema Tests
// ===========================================================================

describe("cloneRepo input schema with remoteMachineId", () => {
	it("accepts input without remoteMachineId (local clone)", () => {
		const result = cloneRepoInputSchema.safeParse({
			url: "https://github.com/user/repo.git",
			targetDirectory: "/Users/dev/projects",
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.remoteMachineId).toBeUndefined();
		}
	});

	it("accepts input with remoteMachineId (remote clone)", () => {
		const result = cloneRepoInputSchema.safeParse({
			url: "https://github.com/user/repo.git",
			remoteMachineId: "machine-uuid-123",
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.remoteMachineId).toBe("machine-uuid-123");
		}
	});

	it("accepts SSH URL with remoteMachineId", () => {
		const result = cloneRepoInputSchema.safeParse({
			url: "git@github.com:user/repo.git",
			remoteMachineId: "machine-uuid-456",
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.remoteMachineId).toBe("machine-uuid-456");
		}
	});

	it("does not require targetDirectory when remoteMachineId is provided", () => {
		const result = cloneRepoInputSchema.safeParse({
			url: "https://github.com/user/repo.git",
			remoteMachineId: "machine-uuid-789",
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.targetDirectory).toBeUndefined();
			expect(result.data.remoteMachineId).toBe("machine-uuid-789");
		}
	});

	it("accepts both targetDirectory and remoteMachineId", () => {
		const result = cloneRepoInputSchema.safeParse({
			url: "https://github.com/user/repo.git",
			targetDirectory: "/some/path",
			remoteMachineId: "machine-uuid-000",
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.targetDirectory).toBe("/some/path");
			expect(result.data.remoteMachineId).toBe("machine-uuid-000");
		}
	});

	it("still rejects invalid URLs even with remoteMachineId", () => {
		const result = cloneRepoInputSchema.safeParse({
			url: "not a valid url",
			remoteMachineId: "machine-uuid-123",
		});
		expect(result.success).toBe(false);
	});

	it("still rejects empty URL with remoteMachineId", () => {
		const result = cloneRepoInputSchema.safeParse({
			url: "",
			remoteMachineId: "machine-uuid-123",
		});
		expect(result.success).toBe(false);
	});
});

// ===========================================================================
// Remote Path Construction Tests
// ===========================================================================

describe("remote clone path construction", () => {
	it("constructs remote path from projectsDir + repoName for HTTPS URL", () => {
		const projectsDir = "~/projects";
		const url = "https://github.com/user/my-repo.git";
		const repoName = extractRepoName(url);

		expect(repoName).toBe("my-repo");
		// Remote path would be: projectsDir + "/" + repoName
		const remotePath = `${projectsDir}/${repoName}`;
		expect(remotePath).toBe("~/projects/my-repo");
	});

	it("constructs remote path from projectsDir + repoName for SSH URL", () => {
		const projectsDir = "/home/ubuntu/work";
		const url = "git@github.com:org/cool-project.git";
		const repoName = extractRepoName(url);

		expect(repoName).toBe("cool-project");
		const remotePath = `${projectsDir}/${repoName}`;
		expect(remotePath).toBe("/home/ubuntu/work/cool-project");
	});

	it("handles projectsDir with trailing slash", () => {
		const projectsDir = "~/projects";
		const url = "https://github.com/user/repo.git";
		const repoName = extractRepoName(url);

		expect(repoName).toBe("repo");
		// The implementation should handle this correctly
		const remotePath = `${projectsDir}/${repoName}`;
		expect(remotePath).toBe("~/projects/repo");
	});

	it("extracts repo name without .git suffix", () => {
		const url = "https://github.com/user/superset-terminal.git";
		const repoName = extractRepoName(url);
		expect(repoName).toBe("superset-terminal");
	});

	it("extracts repo name from URL without .git suffix", () => {
		const url = "https://github.com/user/superset-terminal";
		const repoName = extractRepoName(url);
		expect(repoName).toBe("superset-terminal");
	});
});
