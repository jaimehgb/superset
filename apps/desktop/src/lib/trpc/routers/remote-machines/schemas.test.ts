import { describe, expect, it } from "bun:test";
import {
	createMachineSchema,
	machineIdSchema,
	updateMachineSchema,
} from "./schemas";

describe("remote-machines input schemas", () => {
	// ===========================================================================
	// createMachineSchema
	// ===========================================================================

	describe("createMachineSchema", () => {
		it("accepts valid minimal input", () => {
			const result = createMachineSchema.safeParse({
				name: "dev-box",
				host: "10.0.0.5",
				username: "ubuntu",
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.port).toBe(22);
				expect(result.data.projectsDir).toBe("~/projects");
			}
		});

		it("accepts valid full input", () => {
			const result = createMachineSchema.safeParse({
				name: "production-gpu",
				host: "gpu.example.com",
				port: 2222,
				username: "admin",
				identityFile: "/home/user/.ssh/id_ed25519",
				projectsDir: "/opt/work",
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.port).toBe(2222);
				expect(result.data.identityFile).toBe("/home/user/.ssh/id_ed25519");
				expect(result.data.projectsDir).toBe("/opt/work");
			}
		});

		it("accepts null identityFile", () => {
			const result = createMachineSchema.safeParse({
				name: "box",
				host: "host",
				username: "user",
				identityFile: null,
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.identityFile).toBeNull();
			}
		});

		it("rejects empty name", () => {
			const result = createMachineSchema.safeParse({
				name: "",
				host: "host",
				username: "user",
			});
			expect(result.success).toBe(false);
		});

		it("rejects empty host", () => {
			const result = createMachineSchema.safeParse({
				name: "box",
				host: "",
				username: "user",
			});
			expect(result.success).toBe(false);
		});

		it("rejects empty username", () => {
			const result = createMachineSchema.safeParse({
				name: "box",
				host: "host",
				username: "",
			});
			expect(result.success).toBe(false);
		});

		it("rejects missing required fields", () => {
			const result = createMachineSchema.safeParse({});
			expect(result.success).toBe(false);
		});

		it("rejects port below 1", () => {
			const result = createMachineSchema.safeParse({
				name: "box",
				host: "host",
				username: "user",
				port: 0,
			});
			expect(result.success).toBe(false);
		});

		it("rejects port above 65535", () => {
			const result = createMachineSchema.safeParse({
				name: "box",
				host: "host",
				username: "user",
				port: 65536,
			});
			expect(result.success).toBe(false);
		});

		it("rejects non-integer port", () => {
			const result = createMachineSchema.safeParse({
				name: "box",
				host: "host",
				username: "user",
				port: 22.5,
			});
			expect(result.success).toBe(false);
		});
	});

	// ===========================================================================
	// updateMachineSchema
	// ===========================================================================

	describe("updateMachineSchema", () => {
		it("accepts valid partial update (name only)", () => {
			const result = updateMachineSchema.safeParse({
				id: "abc-123",
				patch: { name: "new-name" },
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.patch.name).toBe("new-name");
				expect(result.data.patch.host).toBeUndefined();
			}
		});

		it("accepts valid full update", () => {
			const result = updateMachineSchema.safeParse({
				id: "abc-123",
				patch: {
					name: "new-name",
					host: "new-host.com",
					port: 3333,
					username: "newuser",
					identityFile: "/new/key",
					projectsDir: "/new/dir",
				},
			});
			expect(result.success).toBe(true);
		});

		it("accepts empty patch (no-op update)", () => {
			const result = updateMachineSchema.safeParse({
				id: "abc-123",
				patch: {},
			});
			expect(result.success).toBe(true);
		});

		it("accepts null identityFile in patch (clear key)", () => {
			const result = updateMachineSchema.safeParse({
				id: "abc-123",
				patch: { identityFile: null },
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.patch.identityFile).toBeNull();
			}
		});

		it("rejects empty id", () => {
			const result = updateMachineSchema.safeParse({
				id: "",
				patch: { name: "test" },
			});
			expect(result.success).toBe(false);
		});

		it("rejects missing id", () => {
			const result = updateMachineSchema.safeParse({
				patch: { name: "test" },
			});
			expect(result.success).toBe(false);
		});

		it("rejects empty name in patch", () => {
			const result = updateMachineSchema.safeParse({
				id: "abc-123",
				patch: { name: "" },
			});
			expect(result.success).toBe(false);
		});

		it("rejects invalid port in patch", () => {
			const result = updateMachineSchema.safeParse({
				id: "abc-123",
				patch: { port: 0 },
			});
			expect(result.success).toBe(false);
		});

		it("rejects port above 65535 in patch", () => {
			const result = updateMachineSchema.safeParse({
				id: "abc-123",
				patch: { port: 99999 },
			});
			expect(result.success).toBe(false);
		});
	});

	// ===========================================================================
	// machineIdSchema
	// ===========================================================================

	describe("machineIdSchema", () => {
		it("accepts valid id", () => {
			const result = machineIdSchema.safeParse({ id: "some-uuid-here" });
			expect(result.success).toBe(true);
		});

		it("rejects empty id", () => {
			const result = machineIdSchema.safeParse({ id: "" });
			expect(result.success).toBe(false);
		});

		it("rejects missing id", () => {
			const result = machineIdSchema.safeParse({});
			expect(result.success).toBe(false);
		});
	});
});
