# Remote Compute Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable Superset to run terminal sessions and coding agents on a remote machine via SSH, while the desktop app serves as the UI layer.

**Architecture:** SSH socket forwarding approach — deploy the existing terminal-host daemon on a remote machine, forward its Unix socket over SSH to the local app. A `RemoteWorkspaceRuntime` implements the same `WorkspaceRuntime` interface, selecting between local and remote based on `project.remoteMachineId`. Agent hooks use an SSH reverse tunnel to reach the local notification server.

**Tech Stack:** `ssh2` (Node.js SSH client), Drizzle ORM (schema changes), tRPC (new endpoints), React + shadcn/ui (settings UI), existing terminal-host daemon (repackaged for remote).

**Design doc:** `docs/plans/2026-03-01-remote-compute-design.md`

---

## Task 1: Add `remote_machines` table and `projects.remoteMachineId` column

**Files:**
- Modify: `packages/local-db/src/schema/schema.ts`
- Modify: `packages/local-db/src/schema/zod.ts`
- Modify: `packages/local-db/src/schema/relations.ts`

**Step 1: Add Zod types for remote machine status**

In `packages/local-db/src/schema/zod.ts`, add at the end:

```typescript
export const REMOTE_MACHINE_STATUSES = [
  "connected",
  "disconnected",
  "unknown",
] as const;

export type RemoteMachineStatus = (typeof REMOTE_MACHINE_STATUSES)[number];
```

**Step 2: Add `remote_machines` table to schema**

In `packages/local-db/src/schema/schema.ts`, add after the `browserHistory` table (after line 341):

```typescript
/**
 * Remote machines table - represents an SSH-accessible remote compute box
 */
export const remoteMachines = sqliteTable(
  "remote_machines",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => uuidv4()),
    name: text("name").notNull(),
    host: text("host").notNull(),
    port: integer("port").notNull().default(22),
    username: text("username").notNull(),
    identityFile: text("identity_file"),
    projectsDir: text("projects_dir").notNull().default("~/projects"),
    status: text("status").notNull().$type<RemoteMachineStatus>().default("unknown"),
    lastSeenAt: integer("last_seen_at"),
    createdAt: integer("created_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (table) => [
    index("remote_machines_host_idx").on(table.host),
  ],
);

export type InsertRemoteMachine = typeof remoteMachines.$inferInsert;
export type SelectRemoteMachine = typeof remoteMachines.$inferSelect;
```

Add import for `RemoteMachineStatus` from `"./zod"` to the imports at the top of schema.ts.

**Step 3: Add `remoteMachineId` FK to `projects` table**

In `packages/local-db/src/schema/schema.ts`, add after `defaultApp` in the `projects` column definition (after line 46):

```typescript
remoteMachineId: text("remote_machine_id").references(
  () => remoteMachines.id,
  { onDelete: "set null" },
),
```

**Step 4: Add `defaultRemoteMachineId` to `settings` table**

In `packages/local-db/src/schema/schema.ts`, add after `openLinksInApp` in the `settings` column definition (after line 176):

```typescript
defaultRemoteMachineId: text("default_remote_machine_id"),
```

**Step 5: Add relations for remote_machines**

In `packages/local-db/src/schema/relations.ts`, add:

```typescript
import { remoteMachines } from "./schema";

export const remoteMachinesRelations = relations(remoteMachines, ({ many }) => ({
  projects: many(projects),
}));
```

Update `projectsRelations` to include:

```typescript
remoteMachine: one(remoteMachines, {
  fields: [projects.remoteMachineId],
  references: [remoteMachines.id],
}),
```

**Step 6: Generate migration**

Run: `cd packages/local-db && bunx drizzle-kit generate --name="add_remote_machines"`

Expected: new migration file `drizzle/0034_add_remote_machines.sql` (or next number) with CREATE TABLE and ALTER TABLE statements.

**Step 7: Commit**

```bash
git add packages/local-db/src/schema/ packages/local-db/drizzle/
git commit -m "feat(local-db): add remote_machines table and projects.remoteMachineId"
```

---

## Task 2: Install `ssh2` and create SSH types

**Files:**
- Create: `apps/desktop/src/main/lib/ssh/types.ts`

**Step 1: Install ssh2**

Run: `cd apps/desktop && bun add ssh2 && bun add -d @types/ssh2`

**Step 2: Create SSH types**

Create `apps/desktop/src/main/lib/ssh/types.ts`:

```typescript
import type { Client as Ssh2Client, ConnectConfig } from "ssh2";

export interface SshMachineConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  identityFile?: string;
  projectsDir: string;
}

export interface SshExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type SshConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

export interface SshConnectionEvents {
  stateChange: (state: SshConnectionState) => void;
  error: (error: Error) => void;
}

export const REMOTE_DAEMON_SOCKET_NAME = "terminal-host.sock";
export const REMOTE_SUPERSET_DIR = ".superset";
export const REMOTE_HOOK_PORT = 18787;
export const REMOTE_VERSION_FILE = ".version";
```

**Step 3: Commit**

```bash
git add apps/desktop/package.json apps/desktop/src/main/lib/ssh/
git commit -m "feat(desktop): add ssh2 dependency and SSH types"
```

---

## Task 3: Implement `SshConnectionManager`

**Files:**
- Create: `apps/desktop/src/main/lib/ssh/connection-manager.ts`
- Test: `apps/desktop/src/main/lib/ssh/connection-manager.test.ts`

**Step 1: Write tests for SshConnectionManager**

Create `apps/desktop/src/main/lib/ssh/connection-manager.test.ts`:

```typescript
import { describe, test, expect, mock, beforeEach } from "bun:test";

// Tests will verify:
// 1. connect() establishes SSH connection with correct config
// 2. exec() runs commands and returns stdout/stderr/code
// 3. disconnect() cleans up resources
// 4. State transitions: disconnected → connecting → connected
// 5. Reconnection on unexpected disconnect
// 6. forwardUnixSocket creates local socket pointing to remote
// 7. reversePortForward establishes reverse tunnel

describe("SshConnectionManager", () => {
  test("connect transitions to connected state", async () => {
    // Implementation test
  });

  test("exec returns stdout/stderr/code", async () => {
    // Implementation test
  });

  test("disconnect transitions to disconnected state", async () => {
    // Implementation test
  });

  test("auto-reconnects on unexpected disconnect", async () => {
    // Implementation test
  });
});
```

**Step 2: Implement SshConnectionManager**

Create `apps/desktop/src/main/lib/ssh/connection-manager.ts`:

```typescript
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { Client as Ssh2Client } from "ssh2";
import type {
  SshConnectionState,
  SshExecResult,
  SshMachineConfig,
} from "./types";
import { REMOTE_HOOK_PORT } from "./types";

const MAX_RECONNECT_DELAY_MS = 30_000;
const KEEPALIVE_INTERVAL_MS = 15_000;
const KEEPALIVE_COUNT_MAX = 3;

export class SshConnectionManager extends EventEmitter {
  private client: Ssh2Client | null = null;
  private config: SshMachineConfig;
  private state: SshConnectionState = "disconnected";
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private localSocketPath: string | null = null;
  private reverseForwardPort: number | null = null;

  constructor(config: SshMachineConfig) {
    super();
    this.config = config;
  }

  getState(): SshConnectionState {
    return this.state;
  }

  getLocalSocketPath(): string | null {
    return this.localSocketPath;
  }

  getReverseForwardPort(): number | null {
    return this.reverseForwardPort;
  }

  async connect(): Promise<void> {
    if (this.state === "connected" || this.state === "connecting") return;
    this.setState("connecting");

    const client = new Ssh2Client();
    this.client = client;

    return new Promise<void>((resolve, reject) => {
      client.on("ready", () => {
        this.setState("connected");
        this.reconnectAttempts = 0;
        resolve();
      });

      client.on("error", (err) => {
        this.emit("error", err);
        if (this.state === "connecting") {
          reject(err);
        }
      });

      client.on("close", () => {
        if (this.state === "connected") {
          this.setState("reconnecting");
          this.scheduleReconnect();
        }
      });

      const connectConfig: Record<string, unknown> = {
        host: this.config.host,
        port: this.config.port,
        username: this.config.username,
        agent: process.env.SSH_AUTH_SOCK,
        agentForward: true,
        keepaliveInterval: KEEPALIVE_INTERVAL_MS,
        keepaliveCountMax: KEEPALIVE_COUNT_MAX,
      };

      if (this.config.identityFile) {
        connectConfig.privateKey = readFileSync(this.config.identityFile);
      }

      client.connect(connectConfig);
    });
  }

  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;

    if (this.client) {
      this.client.end();
      this.client = null;
    }

    this.localSocketPath = null;
    this.reverseForwardPort = null;
    this.setState("disconnected");
  }

  async exec(command: string): Promise<SshExecResult> {
    if (!this.client || this.state !== "connected") {
      throw new Error("SSH not connected");
    }

    return new Promise((resolve, reject) => {
      this.client!.exec(command, (err, stream) => {
        if (err) return reject(err);

        let stdout = "";
        let stderr = "";

        stream.on("data", (data: Buffer) => {
          stdout += data.toString();
        });

        stream.stderr.on("data", (data: Buffer) => {
          stderr += data.toString();
        });

        stream.on("close", (code: number) => {
          resolve({ stdout, stderr, code: code ?? 0 });
        });
      });
    });
  }

  async forwardUnixSocket(
    remotePath: string,
    localPath: string,
  ): Promise<void> {
    if (!this.client || this.state !== "connected") {
      throw new Error("SSH not connected");
    }

    // Use openssh-style streamlocal forwarding via ssh2
    // The ssh2 library supports Unix domain socket forwarding
    // through the openssh-streamlocal@openssh.com channel type
    return new Promise((resolve, reject) => {
      this.client!.openssh_forwardInStreamLocal(remotePath, (err) => {
        if (err) return reject(err);
        this.localSocketPath = localPath;
        resolve();
      });
    });
  }

  async setupReversePortForward(localPort: number): Promise<number> {
    if (!this.client || this.state !== "connected") {
      throw new Error("SSH not connected");
    }

    return new Promise((resolve, reject) => {
      // Try fixed port first, fall back to dynamic
      this.client!.forwardIn("127.0.0.1", REMOTE_HOOK_PORT, (err, port) => {
        if (err) {
          // Fixed port occupied, try dynamic
          this.client!.forwardIn("127.0.0.1", 0, (err2, port2) => {
            if (err2) return reject(err2);
            this.reverseForwardPort = port2;
            resolve(port2);
          });
          return;
        }
        this.reverseForwardPort = port ?? REMOTE_HOOK_PORT;
        resolve(this.reverseForwardPort);
      });
    });
  }

  getSftpClient(): Promise<import("ssh2").SFTPWrapper> {
    if (!this.client || this.state !== "connected") {
      throw new Error("SSH not connected");
    }

    return new Promise((resolve, reject) => {
      this.client!.sftp((err, sftp) => {
        if (err) return reject(err);
        resolve(sftp);
      });
    });
  }

  private setState(state: SshConnectionState): void {
    this.state = state;
    this.emit("stateChange", state);
  }

  private scheduleReconnect(): void {
    const delay = Math.min(
      1000 * 2 ** this.reconnectAttempts,
      MAX_RECONNECT_DELAY_MS,
    );
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch {
        // connect() will trigger close → scheduleReconnect again
      }
    }, delay);
  }
}
```

**Step 3: Run tests**

Run: `cd apps/desktop && bun test src/main/lib/ssh/connection-manager.test.ts`

**Step 4: Commit**

```bash
git add apps/desktop/src/main/lib/ssh/
git commit -m "feat(desktop): implement SshConnectionManager with reconnection"
```

---

## Task 4: Implement remote provisioner

**Files:**
- Create: `apps/desktop/src/main/lib/ssh/provisioner.ts`

**Step 1: Implement provisioner**

Create `apps/desktop/src/main/lib/ssh/provisioner.ts`:

```typescript
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import type { SFTPWrapper } from "ssh2";
import type { SshConnectionManager } from "./connection-manager";
import { REMOTE_SUPERSET_DIR, REMOTE_VERSION_FILE } from "./types";
import { SUPERSET_DIR_NAME } from "shared/constants";

// Use the same version as the local app
const PROVISION_VERSION = "1"; // Bump when provisioned files change

export class RemoteProvisioner {
  private ssh: SshConnectionManager;

  constructor(ssh: SshConnectionManager) {
    this.ssh = ssh;
  }

  /**
   * Check if remote needs provisioning.
   * Returns true if provisioning is needed.
   */
  async needsProvisioning(): Promise<boolean> {
    const result = await this.ssh.exec(
      `cat ~/${REMOTE_SUPERSET_DIR}/${REMOTE_VERSION_FILE} 2>/dev/null || echo "missing"`,
    );
    return result.stdout.trim() !== PROVISION_VERSION;
  }

  /**
   * Check that Node.js is available on the remote machine.
   * Throws if not found.
   */
  async checkNodeAvailable(): Promise<string> {
    const result = await this.ssh.exec("node --version 2>/dev/null");
    if (result.code !== 0) {
      throw new Error(
        "Node.js not found on remote machine. Please install Node.js on the remote machine first.",
      );
    }
    return result.stdout.trim();
  }

  /**
   * Provision the remote machine with Superset infrastructure.
   * Uploads daemon, agent shims, shell dotfiles.
   */
  async provision(): Promise<void> {
    const sftp = await this.ssh.getSftpClient();
    const remoteBase = `~/${REMOTE_SUPERSET_DIR}`;

    // Create directory structure
    await this.ssh.exec(`mkdir -p ${remoteBase}/{bin,hooks,zsh,bash,hooks/opencode/plugin}`);

    // Upload files from local ~/.superset/
    const localBase = join(homedir(), SUPERSET_DIR_NAME);
    await this.uploadDirectory(sftp, join(localBase, "bin"), `${remoteBase}/bin`);
    await this.uploadDirectory(sftp, join(localBase, "hooks"), `${remoteBase}/hooks`);
    await this.uploadDirectory(sftp, join(localBase, "zsh"), `${remoteBase}/zsh`);
    await this.uploadDirectory(sftp, join(localBase, "bash"), `${remoteBase}/bash`);

    // Make bin/ and hooks/ scripts executable
    await this.ssh.exec(`chmod +x ${remoteBase}/bin/* ${remoteBase}/hooks/*.sh 2>/dev/null || true`);

    // Write version marker
    await this.ssh.exec(`echo "${PROVISION_VERSION}" > ${remoteBase}/${REMOTE_VERSION_FILE}`);

    sftp.end();
  }

  /**
   * Start the terminal-host daemon on the remote machine.
   * If already running, does nothing.
   */
  async ensureDaemonRunning(): Promise<void> {
    // Check if daemon is already running
    const check = await this.ssh.exec(
      `test -S ~/${REMOTE_SUPERSET_DIR}/terminal-host.sock && echo "running" || echo "stopped"`,
    );

    if (check.stdout.trim() === "running") {
      return; // Daemon is already running
    }

    // Start daemon in background
    // The daemon script is terminal-host.js, run with ELECTRON_RUN_AS_NODE=1
    // On remote, we use plain node instead of electron
    await this.ssh.exec(
      `cd ~/${REMOTE_SUPERSET_DIR} && nohup node terminal-host.js > terminal-host.log 2>&1 &`,
    );

    // Wait for socket to appear (max 5 seconds)
    for (let i = 0; i < 50; i++) {
      const sockCheck = await this.ssh.exec(
        `test -S ~/${REMOTE_SUPERSET_DIR}/terminal-host.sock && echo "ready"`,
      );
      if (sockCheck.stdout.trim() === "ready") return;
      await new Promise((r) => setTimeout(r, 100));
    }

    throw new Error("Remote daemon failed to start within 5 seconds");
  }

  private async uploadDirectory(
    sftp: SFTPWrapper,
    localDir: string,
    remoteDir: string,
  ): Promise<void> {
    try {
      const entries = readdirSync(localDir);
      for (const entry of entries) {
        const localPath = join(localDir, entry);
        const remotePath = `${remoteDir}/${entry}`;
        const stat = statSync(localPath);

        if (stat.isDirectory()) {
          await this.ssh.exec(`mkdir -p ${remotePath}`);
          await this.uploadDirectory(sftp, localPath, remotePath);
        } else {
          await this.uploadFile(sftp, localPath, remotePath);
        }
      }
    } catch {
      // Directory may not exist locally yet, skip
    }
  }

  private uploadFile(
    sftp: SFTPWrapper,
    localPath: string,
    remotePath: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      sftp.fastPut(localPath, remotePath, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }
}
```

**Step 2: Commit**

```bash
git add apps/desktop/src/main/lib/ssh/provisioner.ts
git commit -m "feat(desktop): implement remote provisioner for daemon and agent shims"
```

---

## Task 5: Parameterize `TerminalHostClient` socket path

The `TerminalHostClient` currently has hardcoded socket/token/PID paths as module constants. We need to make these configurable so a remote-forwarded socket can be used.

**Files:**
- Modify: `apps/desktop/src/main/lib/terminal-host/client.ts`
- Test: `apps/desktop/src/main/lib/terminal/daemon/daemon-manager.test.ts` (ensure existing tests still pass)

**Step 1: Add options interface to `TerminalHostClient`**

In `apps/desktop/src/main/lib/terminal-host/client.ts`, add an options type near the top (after the existing constants around line 76):

```typescript
export interface TerminalHostClientOptions {
  /** Override socket path (default: ~/.superset/terminal-host.sock) */
  socketPath?: string;
  /** Override token path (default: ~/.superset/terminal-host.token) */
  tokenPath?: string;
  /** Override PID path (default: ~/.superset/terminal-host.pid) */
  pidPath?: string;
  /** Skip spawning daemon if not running (for remote connections) */
  skipSpawn?: boolean;
}
```

**Step 2: Modify constructor to accept options**

Change the constructor (around line 174) from:

```typescript
constructor() {
```

To:

```typescript
constructor(private readonly options: TerminalHostClientOptions = {}) {
```

**Step 3: Replace hardcoded path references with instance getters**

Add private getters that fall back to the module defaults:

```typescript
private get socketPath(): string {
  return this.options.socketPath ?? SOCKET_PATH;
}
private get tokenPath(): string {
  return this.options.tokenPath ?? TOKEN_PATH;
}
private get pidPath(): string {
  return this.options.pidPath ?? PID_PATH;
}
```

Replace all usages of `SOCKET_PATH`, `TOKEN_PATH`, `PID_PATH` inside instance methods with `this.socketPath`, `this.tokenPath`, `this.pidPath`. Keep the module constants as defaults.

**Step 4: Add skipSpawn guard in `connectAndAuthenticate`**

In the `connectAndAuthenticate()` method (around line 297), after `tryConnectControl()` returns false, add:

```typescript
if (!controlConnected) {
  if (this.options.skipSpawn) {
    throw new Error("Remote daemon not running and skipSpawn is true");
  }
  await this.spawnDaemon();
  // ... rest of existing logic
}
```

**Step 5: Run existing tests to verify no regression**

Run: `cd apps/desktop && bun test src/main/lib/terminal/daemon/daemon-manager.test.ts`
Expected: all existing tests pass (default options = same behavior as before)

**Step 6: Commit**

```bash
git add apps/desktop/src/main/lib/terminal-host/client.ts
git commit -m "refactor(desktop): parameterize TerminalHostClient socket paths and add skipSpawn option"
```

---

## Task 6: Make `DaemonTerminalManager` accept an injected client

Currently `DaemonTerminalManager` always gets its client from the module singleton `getTerminalHostClient()`. We need it to optionally accept a client via constructor injection for remote use.

**Files:**
- Modify: `apps/desktop/src/main/lib/terminal/daemon/daemon-manager.ts`
- Modify: `apps/desktop/src/main/lib/terminal/index.ts` (update factory)

**Step 1: Add optional client parameter to constructor**

In `apps/desktop/src/main/lib/terminal/daemon/daemon-manager.ts`, change the constructor (around line 44):

```typescript
constructor(injectedClient?: TerminalHostClient) {
  super();
  this.initializeClient(injectedClient);
}
```

**Step 2: Update `initializeClient` to use injected client**

Around line 74:

```typescript
private initializeClient(injectedClient?: TerminalHostClient): void {
  this.client = injectedClient ?? getTerminalHostClient();
  this.setupClientEventHandlers();
}
```

**Step 3: Update `getDaemonTerminalManager` to pass through**

In `apps/desktop/src/main/lib/terminal/index.ts` (or `daemon/index.ts`), the default singleton still works as before since no injected client is passed.

**Step 4: Run existing tests**

Run: `cd apps/desktop && bun test src/main/lib/terminal/daemon/daemon-manager.test.ts`
Expected: all existing tests pass

**Step 5: Commit**

```bash
git add apps/desktop/src/main/lib/terminal/daemon/ apps/desktop/src/main/lib/terminal/index.ts
git commit -m "refactor(desktop): allow DaemonTerminalManager to accept injected TerminalHostClient"
```

---

## Task 7: Implement `RemoteWorkspaceRuntime`

**Files:**
- Create: `apps/desktop/src/main/lib/workspace-runtime/remote.ts`
- Modify: `apps/desktop/src/main/lib/workspace-runtime/registry.ts`

**Step 1: Create RemoteWorkspaceRuntime**

Create `apps/desktop/src/main/lib/workspace-runtime/remote.ts`:

```typescript
import { TerminalHostClient } from "main/lib/terminal-host/client";
import type { TerminalHostClientOptions } from "main/lib/terminal-host/client";
import { DaemonTerminalManager } from "main/lib/terminal/daemon/daemon-manager";
import type {
  TerminalCapabilities,
  TerminalManagement,
  TerminalRuntime,
  WorkspaceRuntime,
  WorkspaceRuntimeId,
} from "./types";
import type { SshConnectionManager } from "main/lib/ssh/connection-manager";

/**
 * Remote terminal runtime that connects to a daemon on a remote machine
 * via an SSH-forwarded Unix socket.
 *
 * The key insight: the DaemonTerminalManager speaks NDJSON over a Unix socket.
 * SSH socket forwarding makes the remote socket appear as a local socket.
 * So we create a TerminalHostClient pointed at the forwarded socket path,
 * inject it into a DaemonTerminalManager, and everything Just Works.
 */
class RemoteTerminalRuntime implements TerminalRuntime {
  private readonly backend: DaemonTerminalManager;

  readonly management: TerminalManagement;
  readonly capabilities: TerminalCapabilities;

  constructor(forwardedSocketPath: string) {
    // Create a client pointed at the SSH-forwarded socket
    const clientOptions: TerminalHostClientOptions = {
      socketPath: forwardedSocketPath,
      tokenPath: forwardedSocketPath.replace(".sock", ".token"),
      pidPath: forwardedSocketPath.replace(".sock", ".pid"),
      skipSpawn: true, // Daemon is managed remotely, don't try to spawn locally
    };

    const client = new TerminalHostClient(clientOptions);
    this.backend = new DaemonTerminalManager(client);

    this.capabilities = {
      persistent: true,
      coldRestore: false, // Can't read remote scrollback files yet
    };

    this.management = {
      listSessions: () => this.backend.listDaemonSessions(),
      killAllSessions: () => this.backend.forceKillAll(),
      resetHistoryPersistence: () => this.backend.resetHistoryPersistence(),
    };
  }

  // Delegate all TerminalSessionOperations to backend
  createOrAttach: TerminalRuntime["createOrAttach"] = (params) =>
    this.backend.createOrAttach(params);
  write: TerminalRuntime["write"] = (params) => this.backend.write(params);
  resize: TerminalRuntime["resize"] = (params) => this.backend.resize(params);
  signal: TerminalRuntime["signal"] = (params) => this.backend.signal(params);
  kill: TerminalRuntime["kill"] = (params) => this.backend.kill(params);
  detach: TerminalRuntime["detach"] = (params) => this.backend.detach(params);
  clearScrollback: TerminalRuntime["clearScrollback"] = (params) =>
    this.backend.clearScrollback(params);
  ackColdRestore: TerminalRuntime["ackColdRestore"] = (paneId) =>
    this.backend.ackColdRestore(paneId);
  getSession: TerminalRuntime["getSession"] = (paneId) =>
    this.backend.getSession(paneId);

  // Delegate TerminalWorkspaceOperations
  killByWorkspaceId: TerminalRuntime["killByWorkspaceId"] = (workspaceId) =>
    this.backend.killByWorkspaceId(workspaceId);
  getSessionCountByWorkspaceId: TerminalRuntime["getSessionCountByWorkspaceId"] =
    (workspaceId) => this.backend.getSessionCountByWorkspaceId(workspaceId);
  refreshPromptsForWorkspace: TerminalRuntime["refreshPromptsForWorkspace"] = (
    workspaceId,
  ) => this.backend.refreshPromptsForWorkspace(workspaceId);

  // Delegate EventEmitter methods
  on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    this.backend.on(event, listener);
    return this;
  }
  off(event: string | symbol, listener: (...args: unknown[]) => void): this {
    this.backend.off(event, listener);
    return this;
  }
  once(event: string | symbol, listener: (...args: unknown[]) => void): this {
    this.backend.once(event, listener);
    return this;
  }
  emit(event: string | symbol, ...args: unknown[]): boolean {
    return this.backend.emit(event, ...args);
  }
  addListener(event: string | symbol, listener: (...args: unknown[]) => void): this {
    this.backend.addListener(event, listener);
    return this;
  }
  removeListener(event: string | symbol, listener: (...args: unknown[]) => void): this {
    this.backend.removeListener(event, listener);
    return this;
  }
  removeAllListeners(event?: string | symbol): this {
    this.backend.removeAllListeners(event);
    return this;
  }
  setMaxListeners(n: number): this {
    this.backend.setMaxListeners(n);
    return this;
  }
  getMaxListeners(): number {
    return this.backend.getMaxListeners();
  }
  listeners(event: string | symbol): Function[] {
    return this.backend.listeners(event);
  }
  rawListeners(event: string | symbol): Function[] {
    return this.backend.rawListeners(event);
  }
  listenerCount(event: string | symbol, listener?: (...args: unknown[]) => void): number {
    return this.backend.listenerCount(event, listener);
  }
  prependListener(event: string | symbol, listener: (...args: unknown[]) => void): this {
    this.backend.prependListener(event, listener);
    return this;
  }
  prependOnceListener(event: string | symbol, listener: (...args: unknown[]) => void): this {
    this.backend.prependOnceListener(event, listener);
    return this;
  }
  eventNames(): (string | symbol)[] {
    return this.backend.eventNames();
  }
  detachAllListeners(): void {
    this.backend.detachAllListeners();
  }

  cleanup: TerminalRuntime["cleanup"] = () => this.backend.cleanup();
}

/**
 * Remote workspace runtime.
 * Wraps a RemoteTerminalRuntime connected to a remote daemon
 * via SSH-forwarded socket.
 */
export class RemoteWorkspaceRuntime implements WorkspaceRuntime {
  readonly id: WorkspaceRuntimeId;
  readonly terminal: TerminalRuntime;
  readonly capabilities: WorkspaceRuntime["capabilities"];

  constructor(machineId: string, forwardedSocketPath: string) {
    this.id = `remote:${machineId}`;
    this.terminal = new RemoteTerminalRuntime(forwardedSocketPath);
    this.capabilities = {
      terminal: { persistent: true, coldRestore: false },
    };
  }
}
```

**Step 2: Update registry to support remote runtimes**

In `apps/desktop/src/main/lib/workspace-runtime/registry.ts`, update `DefaultWorkspaceRuntimeRegistry`:

```typescript
import { RemoteWorkspaceRuntime } from "./remote";

class DefaultWorkspaceRuntimeRegistry implements WorkspaceRuntimeRegistry {
  private localRuntime: LocalWorkspaceRuntime | null = null;
  private remoteRuntimes: Map<string, RemoteWorkspaceRuntime> = new Map();

  getForWorkspaceId(_workspaceId: string): WorkspaceRuntime {
    // TODO: Task 10 will wire this to look up project.remoteMachineId
    // For now, always returns local
    return this.getDefault();
  }

  getDefault(): WorkspaceRuntime {
    if (!this.localRuntime) {
      this.localRuntime = new LocalWorkspaceRuntime();
    }
    return this.localRuntime;
  }

  /**
   * Register a remote runtime for a machine.
   * Called by the SSH connection manager after establishing socket forwarding.
   */
  registerRemoteRuntime(
    machineId: string,
    forwardedSocketPath: string,
  ): RemoteWorkspaceRuntime {
    const existing = this.remoteRuntimes.get(machineId);
    if (existing) return existing;

    const runtime = new RemoteWorkspaceRuntime(machineId, forwardedSocketPath);
    this.remoteRuntimes.set(machineId, runtime);
    return runtime;
  }

  /**
   * Remove a remote runtime (on disconnect).
   */
  unregisterRemoteRuntime(machineId: string): void {
    const runtime = this.remoteRuntimes.get(machineId);
    if (runtime) {
      runtime.terminal.cleanup();
      this.remoteRuntimes.delete(machineId);
    }
  }

  getRemoteRuntime(machineId: string): RemoteWorkspaceRuntime | undefined {
    return this.remoteRuntimes.get(machineId);
  }
}
```

**Step 3: Commit**

```bash
git add apps/desktop/src/main/lib/workspace-runtime/
git commit -m "feat(desktop): implement RemoteWorkspaceRuntime with SSH-forwarded daemon socket"
```

---

## Task 8: Implement `GitOperations` abstraction

**Files:**
- Create: `apps/desktop/src/main/lib/git/types.ts`
- Create: `apps/desktop/src/main/lib/git/local.ts`
- Create: `apps/desktop/src/main/lib/git/remote.ts`

**Step 1: Create GitOperations interface**

Create `apps/desktop/src/main/lib/git/types.ts`:

```typescript
export interface GitStatus {
  branch: string;
  needsRebase: boolean;
  ahead?: number;
  behind?: number;
  lastRefreshed: number;
}

export interface GitOperations {
  clone(url: string, targetPath: string): Promise<void>;
  worktreeAdd(
    repoPath: string,
    branch: string,
    worktreePath: string,
    startPoint: string,
  ): Promise<void>;
  worktreeRemove(repoPath: string, worktreePath: string): Promise<void>;
  fetch(repoPath: string, remote?: string, branch?: string): Promise<void>;
  getDefaultBranch(repoPath: string): Promise<string>;
  getCurrentBranch(repoPath: string): Promise<string>;
  branchExistsOnRemote(
    repoPath: string,
    branchName: string,
  ): Promise<boolean>;
  status(repoPath: string): Promise<string>;
}
```

**Step 2: Create LocalGitOperations**

Create `apps/desktop/src/main/lib/git/local.ts` — wraps existing `simple-git` calls:

```typescript
import simpleGit from "simple-git";
import type { GitOperations } from "./types";

export class LocalGitOperations implements GitOperations {
  async clone(url: string, targetPath: string): Promise<void> {
    await simpleGit().clone(url, targetPath);
  }

  async worktreeAdd(
    repoPath: string,
    branch: string,
    worktreePath: string,
    startPoint: string,
  ): Promise<void> {
    await simpleGit(repoPath).raw([
      "worktree", "add", worktreePath, "-b", branch, `${startPoint}^{commit}`,
    ]);
    await simpleGit(worktreePath).raw([
      "config", "--local", "push.autoSetupRemote", "true",
    ]);
  }

  async worktreeRemove(repoPath: string, worktreePath: string): Promise<void> {
    await simpleGit(repoPath).raw(["worktree", "remove", "--force", worktreePath]);
  }

  async fetch(
    repoPath: string,
    remote = "origin",
    branch?: string,
  ): Promise<void> {
    if (branch) {
      await simpleGit(repoPath).fetch(remote, branch);
    } else {
      await simpleGit(repoPath).fetch(remote);
    }
  }

  async getDefaultBranch(repoPath: string): Promise<string> {
    try {
      const result = await simpleGit(repoPath).raw([
        "symbolic-ref", "refs/remotes/origin/HEAD",
      ]);
      return result.trim().replace("refs/remotes/origin/", "");
    } catch {
      return "main";
    }
  }

  async getCurrentBranch(repoPath: string): Promise<string> {
    const result = await simpleGit(repoPath).revparse(["--abbrev-ref", "HEAD"]);
    return result.trim();
  }

  async branchExistsOnRemote(
    repoPath: string,
    branchName: string,
  ): Promise<boolean> {
    try {
      await simpleGit(repoPath).raw([
        "ls-remote", "--exit-code", "--heads", "origin", branchName,
      ]);
      return true;
    } catch {
      return false;
    }
  }

  async status(repoPath: string): Promise<string> {
    return simpleGit(repoPath).raw(["status", "--porcelain=v1", "-b", "-z"]);
  }
}
```

**Step 3: Create RemoteGitOperations**

Create `apps/desktop/src/main/lib/git/remote.ts`:

```typescript
import type { SshConnectionManager } from "../ssh/connection-manager";
import type { GitOperations } from "./types";

export class RemoteGitOperations implements GitOperations {
  private ssh: SshConnectionManager;

  constructor(ssh: SshConnectionManager) {
    this.ssh = ssh;
  }

  async clone(url: string, targetPath: string): Promise<void> {
    const result = await this.ssh.exec(`git clone ${this.escapeArg(url)} ${this.escapeArg(targetPath)}`);
    if (result.code !== 0) {
      throw new Error(`git clone failed: ${result.stderr}`);
    }
  }

  async worktreeAdd(
    repoPath: string,
    branch: string,
    worktreePath: string,
    startPoint: string,
  ): Promise<void> {
    const result = await this.ssh.exec(
      `git -C ${this.escapeArg(repoPath)} worktree add ${this.escapeArg(worktreePath)} -b ${this.escapeArg(branch)} "${startPoint}^{commit}"`,
    );
    if (result.code !== 0) {
      throw new Error(`git worktree add failed: ${result.stderr}`);
    }
    await this.ssh.exec(
      `git -C ${this.escapeArg(worktreePath)} config --local push.autoSetupRemote true`,
    );
  }

  async worktreeRemove(repoPath: string, worktreePath: string): Promise<void> {
    await this.ssh.exec(
      `git -C ${this.escapeArg(repoPath)} worktree remove --force ${this.escapeArg(worktreePath)}`,
    );
  }

  async fetch(
    repoPath: string,
    remote = "origin",
    branch?: string,
  ): Promise<void> {
    const cmd = branch
      ? `git -C ${this.escapeArg(repoPath)} fetch ${this.escapeArg(remote)} ${this.escapeArg(branch)}`
      : `git -C ${this.escapeArg(repoPath)} fetch ${this.escapeArg(remote)}`;
    const result = await this.ssh.exec(cmd);
    if (result.code !== 0) {
      throw new Error(`git fetch failed: ${result.stderr}`);
    }
  }

  async getDefaultBranch(repoPath: string): Promise<string> {
    const result = await this.ssh.exec(
      `git -C ${this.escapeArg(repoPath)} symbolic-ref refs/remotes/origin/HEAD 2>/dev/null`,
    );
    if (result.code === 0) {
      return result.stdout.trim().replace("refs/remotes/origin/", "");
    }
    return "main";
  }

  async getCurrentBranch(repoPath: string): Promise<string> {
    const result = await this.ssh.exec(
      `git -C ${this.escapeArg(repoPath)} rev-parse --abbrev-ref HEAD`,
    );
    return result.stdout.trim();
  }

  async branchExistsOnRemote(
    repoPath: string,
    branchName: string,
  ): Promise<boolean> {
    const result = await this.ssh.exec(
      `git -C ${this.escapeArg(repoPath)} ls-remote --exit-code --heads origin ${this.escapeArg(branchName)}`,
    );
    return result.code === 0;
  }

  async status(repoPath: string): Promise<string> {
    const result = await this.ssh.exec(
      `git --no-optional-locks -C ${this.escapeArg(repoPath)} status --porcelain=v1 -b -z`,
    );
    return result.stdout;
  }

  private escapeArg(arg: string): string {
    // Shell-escape single quotes
    return `'${arg.replace(/'/g, "'\\''")}'`;
  }
}
```

**Step 4: Commit**

```bash
git add apps/desktop/src/main/lib/git/
git commit -m "feat(desktop): add GitOperations abstraction with local and remote implementations"
```

---

## Task 9: Create tRPC router for remote machines

**Files:**
- Create: `apps/desktop/src/lib/trpc/routers/remote-machines/index.ts`
- Modify: `apps/desktop/src/lib/trpc/routers/index.ts` (register router)

**Step 1: Create remote machines tRPC router**

Create `apps/desktop/src/lib/trpc/routers/remote-machines/index.ts`:

This router provides CRUD for `remote_machines` table plus `connect`, `disconnect`, and `testConnection` mutations. Follow the exact same patterns as the existing settings and projects routers: `publicProcedure`, Zod input validation, local-db queries.

Key procedures:
- `remoteMachines.list` — query, returns all machines
- `remoteMachines.create` — mutation, inserts new machine
- `remoteMachines.update` — mutation, updates machine config
- `remoteMachines.delete` — mutation, deletes machine
- `remoteMachines.testConnection` — mutation, SSH connect + check Node.js, returns success/error
- `remoteMachines.connect` — mutation, connects to machine, provisions, starts daemon, forwards socket, sets up reverse tunnel
- `remoteMachines.disconnect` — mutation, disconnects from machine
- `remoteMachines.getStatus` — query, returns connection state

**Step 2: Register router**

In the main app router file, add `remoteMachines: createRemoteMachinesRouter()`.

**Step 3: Commit**

```bash
git add apps/desktop/src/lib/trpc/routers/remote-machines/ apps/desktop/src/lib/trpc/routers/index.ts
git commit -m "feat(desktop): add tRPC router for remote machine management"
```

---

## Task 10: Wire registry to select runtime by project.remoteMachineId

**Files:**
- Modify: `apps/desktop/src/main/lib/workspace-runtime/registry.ts`
- Modify: `apps/desktop/src/lib/trpc/routers/terminal/terminal.ts`

**Step 1: Update registry to look up project for workspace**

The `getForWorkspaceId` method needs to query the local DB to check if the workspace's project has a `remoteMachineId`. This requires passing a DB reference to the registry or using a lookup function.

**Step 2: Update terminal router to pass workspace context**

The terminal tRPC router calls `runtime.getForWorkspaceId(workspaceId)`. Ensure the workspaceId is available in all terminal operations so the registry can look up the project and select the correct runtime.

**Step 3: Commit**

```bash
git add apps/desktop/src/main/lib/workspace-runtime/ apps/desktop/src/lib/trpc/routers/terminal/
git commit -m "feat(desktop): wire registry to select local vs remote runtime by project"
```

---

## Task 11: Update `buildTerminalEnv` for remote sessions

**Files:**
- Modify: `apps/desktop/src/main/lib/terminal/env.ts`

**Step 1: Accept remote hook port parameter**

In `buildTerminalEnv()`, add an optional `remoteHookPort` parameter. When set, use it instead of `env.DESKTOP_NOTIFICATIONS_PORT` for `SUPERSET_PORT`:

```typescript
export function buildTerminalEnv(params: {
  // ... existing params
  remoteHookPort?: number;
}): Record<string, string> {
  // ...
  const supersetPort = params.remoteHookPort
    ? String(params.remoteHookPort)
    : String(env.DESKTOP_NOTIFICATIONS_PORT);

  return {
    // ... existing vars
    SUPERSET_PORT: supersetPort,
    // ...
  };
}
```

**Step 2: Commit**

```bash
git add apps/desktop/src/main/lib/terminal/env.ts
git commit -m "feat(desktop): support remote hook port in terminal environment"
```

---

## Task 12: Update clone flow to support remote cloning

**Files:**
- Modify: `apps/desktop/src/lib/trpc/routers/projects/projects.ts` — add remote clone branch in `cloneRepo` mutation

**Step 1: Add remote clone branch**

In the `cloneRepo` mutation, after input validation, check if a `remoteMachineId` is provided. If so, use `RemoteGitOperations.clone()` instead of local `simpleGit().clone()`. Store the remote path in `mainRepoPath`.

**Step 2: Commit**

```bash
git add apps/desktop/src/lib/trpc/routers/projects/projects.ts
git commit -m "feat(desktop): support cloning repos onto remote machine"
```

---

## Task 13: Update workspace creation to support remote worktrees

**Files:**
- Modify: `apps/desktop/src/lib/trpc/routers/workspaces/utils/workspace-init.ts`
- Modify: `apps/desktop/src/lib/trpc/routers/workspaces/utils/git.ts`

**Step 1: Branch git operations based on project location**

In `initializeWorkspaceWorktree`, check if the project has a `remoteMachineId`. If remote, use `RemoteGitOperations` for all git commands (fetch, worktree add, etc.).

**Step 2: Commit**

```bash
git add apps/desktop/src/lib/trpc/routers/workspaces/
git commit -m "feat(desktop): support remote worktree creation"
```

---

## Task 14: Add Remote Compute settings UI

**Files:**
- Create: `apps/desktop/src/renderer/routes/_authenticated/settings/remote-compute/page.tsx`
- Create: `apps/desktop/src/renderer/routes/_authenticated/settings/remote-compute/components/RemoteComputeSettings/RemoteComputeSettings.tsx`
- Create: `apps/desktop/src/renderer/routes/_authenticated/settings/remote-compute/components/RemoteComputeSettings/index.ts`
- Modify: `apps/desktop/src/renderer/stores/settings-state.ts` — add `"remote-compute"` to `SettingsSection`
- Modify: `apps/desktop/src/renderer/routes/_authenticated/settings/utils/settings-search/settings-search.ts` — add search items
- Modify: `apps/desktop/src/renderer/routes/_authenticated/settings/layout.tsx` — add route/section
- Modify: `apps/desktop/src/renderer/routes/_authenticated/settings/components/SettingsSidebar/GeneralSettings.tsx` — add nav item

The settings UI provides:
- Machine configuration form (name, host, port, SSH key, projects dir)
- "Test Connection" button
- Connection status indicator
- Connect/Disconnect button

Follow the exact patterns from `BehaviorSettings` for tRPC integration (optimistic mutations, query invalidation).

**Step 1: Implement all UI files**

**Step 2: Commit**

```bash
git add apps/desktop/src/renderer/routes/_authenticated/settings/remote-compute/ \
  apps/desktop/src/renderer/stores/settings-state.ts \
  apps/desktop/src/renderer/routes/_authenticated/settings/
git commit -m "feat(desktop): add Remote Compute settings UI"
```

---

## Task 15: Add "Clone to Remote" toggle in clone dialog

**Files:**
- Modify: `apps/desktop/src/renderer/routes/_authenticated/_onboarding/new-project/components/CloneRepoTab/CloneRepoTab.tsx`

**Step 1: Add location toggle**

Add a "Clone to" toggle (Local / Remote) to the clone form. When Remote is selected:
- Show the configured machine name
- Pass `remoteMachineId` to the `cloneRepo` mutation
- Hide the local directory picker (remote uses configured `projectsDir`)

**Step 2: Commit**

```bash
git add apps/desktop/src/renderer/routes/_authenticated/_onboarding/new-project/
git commit -m "feat(desktop): add Clone to Remote toggle in clone dialog"
```

---

## Task 16: Add remote badges to project list

**Files:**
- Modify: `apps/desktop/src/renderer/screens/main/components/WorkspaceSidebar/ProjectSection/ProjectHeader.tsx`
- Modify: `apps/desktop/src/renderer/screens/main/components/WorkspaceSidebar/WorkspaceListItem/WorkspaceListItem.tsx`

**Step 1: Add remote indicator to project header**

Show a small "Remote" badge or icon next to the project name when `project.remoteMachineId` is set. Include a connection status dot (green/yellow/red).

**Step 2: Commit**

```bash
git add apps/desktop/src/renderer/screens/main/components/WorkspaceSidebar/
git commit -m "feat(desktop): show remote badge and connection status on remote projects"
```

---

## Task 17: Package terminal-host daemon for remote deployment

**Files:**
- Create: `apps/desktop/scripts/package-remote-daemon.ts`

The terminal-host daemon currently runs as `ELECTRON_RUN_AS_NODE=1 electron dist/main/terminal-host.js`. For remote machines (Linux, no Electron), we need a standalone bundle that runs with plain Node.js.

**Step 1: Create packaging script**

Use esbuild/bun to bundle `apps/desktop/src/main/terminal-host/index.ts` and its dependencies into a single `terminal-host.js` file that can run with `node`. Handle the `node-pty` native dependency (it must be installed on the remote machine via npm/bun).

**Step 2: Add to provisioner**

Update `RemoteProvisioner` to upload the bundled daemon script and install `node-pty` on remote if needed.

**Step 3: Commit**

```bash
git add apps/desktop/scripts/package-remote-daemon.ts apps/desktop/src/main/lib/ssh/provisioner.ts
git commit -m "feat(desktop): package terminal-host daemon for remote deployment"
```

---

## Task 18: End-to-end integration test

**Step 1: Manual integration test**

1. Configure a remote machine in Settings > Remote Compute
2. Click "Test Connection" — verify SSH connects and Node.js is detected
3. Click "Connect" — verify provisioning completes
4. Create a new project via "Clone to Remote"
5. Verify the repo appears on the remote machine
6. Open a terminal — verify shell starts on remote
7. Type `claude` — verify agent starts and hooks work (status updates in UI)
8. Create a worktree — verify it's created on remote
9. Disconnect the SSH connection — verify UI shows "Disconnected"
10. Reconnect — verify sessions resume

**Step 2: Commit any fixes found during testing**

---

## Dependency Graph

```
Task 1 (DB schema)
  ↓
Task 2 (SSH types) ─────→ Task 3 (SSH connection manager)
  ↓                          ↓
Task 4 (Provisioner) ←──────┘
  ↓
Task 5 (Parameterize client) → Task 6 (Inject client into manager)
                                  ↓
                               Task 7 (RemoteWorkspaceRuntime)
                                  ↓
Task 8 (GitOperations) ────→ Task 10 (Wire registry)
  ↓                            ↓
Task 9 (tRPC router) ──────→ Task 11 (Terminal env)
  ↓                            ↓
Task 12 (Remote clone) ────→ Task 13 (Remote worktrees)
  ↓                            ↓
Task 14 (Settings UI) ─────→ Task 15 (Clone toggle) → Task 16 (Badges)
                                                         ↓
Task 17 (Package daemon) ──────────────────────────→ Task 18 (E2E test)
```

**Parallelizable groups:**
- Tasks 1-2 can run in parallel (no dependencies)
- Tasks 5-6 can run in parallel with Tasks 8-9 (independent subsystems)
- Tasks 14-16 (UI) can run in parallel with Tasks 12-13 (backend) once Task 10 is done
