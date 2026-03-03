import { z } from "zod";

// =============================================================================
// Shared Constants
// =============================================================================

/** SSH connection state values (mirrors SshConnectionState from ssh/types) */
export const SSH_CONNECTION_STATES = [
	"disconnected",
	"connecting",
	"connected",
	"reconnecting",
	"error",
] as const;

export type SshConnectionStateValue = (typeof SSH_CONNECTION_STATES)[number];

/** Remote machine status values (mirrors REMOTE_MACHINE_STATUSES from local-db) */
export const MACHINE_STATUSES = [
	"connected",
	"disconnected",
	"unknown",
] as const;

// =============================================================================
// Input Schemas
// =============================================================================

export const createMachineSchema = z.object({
	name: z.string().min(1, "Machine name is required"),
	host: z.string().min(1, "Host is required"),
	port: z.number().int().min(1).max(65535).default(22),
	username: z.string().min(1, "Username is required"),
	identityFile: z.string().nullable().optional(),
	projectsDir: z.string().default("~/projects"),
});

export const updateMachineSchema = z.object({
	id: z.string().min(1),
	patch: z.object({
		name: z.string().min(1).optional(),
		host: z.string().min(1).optional(),
		port: z.number().int().min(1).max(65535).optional(),
		username: z.string().min(1).optional(),
		identityFile: z.string().nullable().optional(),
		projectsDir: z.string().min(1).optional(),
	}),
});

export const machineIdSchema = z.object({
	id: z.string().min(1),
});

// =============================================================================
// Output Types
// =============================================================================

export const testConnectionResultSchema = z.object({
	success: z.boolean(),
	nodeVersion: z.string().optional(),
	error: z.string().optional(),
});

export type TestConnectionResult = z.infer<typeof testConnectionResultSchema>;

export const machineStatusSchema = z.object({
	id: z.string(),
	status: z.enum(MACHINE_STATUSES),
	sshState: z.enum(SSH_CONNECTION_STATES).optional(),
});

export type MachineStatus = z.infer<typeof machineStatusSchema>;
