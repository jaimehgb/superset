import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
	getWorkspaceRuntimeRegistry,
	resetWorkspaceRuntimeRegistry,
} from "./registry";
import type { WorkspaceRuntimeRegistry } from "./types";

describe("WorkspaceRuntimeRegistry", () => {
	let registry: WorkspaceRuntimeRegistry;

	beforeEach(() => {
		resetWorkspaceRuntimeRegistry();
		registry = getWorkspaceRuntimeRegistry();
	});

	afterEach(() => {
		resetWorkspaceRuntimeRegistry();
	});

	describe("getForWorkspaceId (no project lookup)", () => {
		it("returns the default local runtime when no project lookup is set", () => {
			const runtime = registry.getForWorkspaceId("workspace-1");
			const defaultRuntime = registry.getDefault();
			expect(runtime).toBe(defaultRuntime);
		});

		it("returns the same runtime for different workspace IDs without lookup", () => {
			const r1 = registry.getForWorkspaceId("ws-a");
			const r2 = registry.getForWorkspaceId("ws-b");
			expect(r1).toBe(r2);
		});
	});

	describe("getForWorkspaceId (with project lookup)", () => {
		it("returns local runtime when lookup returns null (no remote machine)", () => {
			const lookup = mock(() => null);
			registry.setProjectMachineLookup(lookup);

			const runtime = registry.getForWorkspaceId("workspace-1");
			const defaultRuntime = registry.getDefault();
			expect(runtime).toBe(defaultRuntime);
			expect(lookup).toHaveBeenCalledWith("workspace-1");
		});

		it("returns remote runtime when lookup returns a registered machineId", () => {
			const remoteRuntime = registry.registerRemoteRuntime(
				"machine-1",
				"/tmp/forwarded.sock",
			);
			const lookup = mock(() => "machine-1");
			registry.setProjectMachineLookup(lookup);

			const runtime = registry.getForWorkspaceId("workspace-with-remote");
			expect(runtime).toBe(remoteRuntime);
			expect(lookup).toHaveBeenCalledWith("workspace-with-remote");
		});

		it("falls back to local runtime when lookup returns a machineId that is not registered", () => {
			const lookup = mock(() => "machine-not-registered");
			registry.setProjectMachineLookup(lookup);

			const runtime = registry.getForWorkspaceId("workspace-1");
			const defaultRuntime = registry.getDefault();
			expect(runtime).toBe(defaultRuntime);
		});

		it("uses lookup result per workspace to select different runtimes", () => {
			const remoteMachine1 = registry.registerRemoteRuntime(
				"machine-1",
				"/tmp/m1.sock",
			);
			const remoteMachine2 = registry.registerRemoteRuntime(
				"machine-2",
				"/tmp/m2.sock",
			);

			const lookup = mock((workspaceId: string) => {
				if (workspaceId === "ws-remote-1") return "machine-1";
				if (workspaceId === "ws-remote-2") return "machine-2";
				return null;
			});
			registry.setProjectMachineLookup(lookup);

			const r1 = registry.getForWorkspaceId("ws-remote-1");
			const r2 = registry.getForWorkspaceId("ws-remote-2");
			const r3 = registry.getForWorkspaceId("ws-local");

			expect(r1).toBe(remoteMachine1);
			expect(r2).toBe(remoteMachine2);
			expect(r3).toBe(registry.getDefault());
		});
	});

	describe("getForMachineId", () => {
		it("returns the default local runtime when no remote is registered for the machineId", () => {
			const runtime = registry.getForMachineId("unknown-machine");
			expect(runtime).toBe(registry.getDefault());
		});

		it("returns the remote runtime when registered", () => {
			const remoteRuntime = registry.registerRemoteRuntime(
				"machine-1",
				"/tmp/forwarded.sock",
			);

			const runtime = registry.getForMachineId("machine-1");
			expect(runtime).toBe(remoteRuntime);
		});

		it("returns null when called with null", () => {
			const runtime = registry.getForMachineId(null);
			expect(runtime).toBe(registry.getDefault());
		});
	});

	describe("registerRemoteRuntime", () => {
		it("returns a new runtime for a new machineId", () => {
			const runtime = registry.registerRemoteRuntime(
				"machine-1",
				"/tmp/m1.sock",
			);
			expect(runtime.id).toBe("remote:machine-1");
		});

		it("returns the existing runtime for an already-registered machineId", () => {
			const r1 = registry.registerRemoteRuntime("machine-1", "/tmp/m1.sock");
			const r2 = registry.registerRemoteRuntime("machine-1", "/tmp/m1.sock");
			expect(r1).toBe(r2);
		});
	});

	describe("unregisterRemoteRuntime", () => {
		it("removes the runtime so getForMachineId falls back to local", () => {
			registry.registerRemoteRuntime("machine-1", "/tmp/m1.sock");
			registry.unregisterRemoteRuntime("machine-1");

			const runtime = registry.getForMachineId("machine-1");
			expect(runtime).toBe(registry.getDefault());
		});

		it("is a no-op for unregistered machineIds", () => {
			// Should not throw
			registry.unregisterRemoteRuntime("nonexistent");
		});
	});

	describe("getRemoteRuntime", () => {
		it("returns undefined for unregistered machineId", () => {
			expect(registry.getRemoteRuntime("unknown")).toBeUndefined();
		});

		it("returns the runtime for a registered machineId", () => {
			const registered = registry.registerRemoteRuntime(
				"machine-1",
				"/tmp/m1.sock",
			);
			expect(registry.getRemoteRuntime("machine-1")).toBe(registered);
		});
	});
});
