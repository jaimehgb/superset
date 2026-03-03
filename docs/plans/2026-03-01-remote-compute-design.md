# Remote Compute Support

Enable Superset to run terminal sessions and coding agents on a remote machine via SSH, while the desktop app remains the UI layer.

## Requirements

- Per-project location: some projects local, some remote
- Single remote machine (extensible to multiple later)
- SSH key-based authentication
- Clone repos onto remote machine via Superset UI
- Create worktrees on remote
- Run terminals with full agent hook support
- Session persistence via remote daemon (survives app restarts)
- Auto-provision remote machine (daemon, agent shims, shell dotfiles)
- Agents (claude, codex, etc.) assumed pre-installed on remote
- SSH agent forwarding for git credential passthrough

## Architecture

### Approach: SSH Socket Forwarding

Reuse the existing terminal-host daemon architecture. Deploy the daemon on the remote machine, forward its Unix socket over SSH to the local app. The `DaemonTerminalManager` speaks the same NDJSON protocol to the forwarded socket — zero protocol changes.

```
Local (Electron app)                          Remote (compute box)
┌─────────────────┐                          ┌──────────────────────┐
│ xterm.js        │                          │ terminal-host daemon │
│   ↕ tRPC IPC    │                          │   ↕ Unix socket      │
│ tRPC Router     │                          │ ~/.superset/         │
│   ↕             │                          │   terminal-host.sock │
│ Registry        │                          │                      │
│   ↕ select      │                          │ node-pty sessions    │
│ RemoteRuntime   │──SSH socket forward──────│   shell → agents     │
│   ↕ NDJSON      │                          │                      │
│ DaemonManager   │                          │ notify.sh            │
│                 │←─SSH reverse tunnel──────│   ↕ curl             │
│ Hook server     │                          │ hook events          │
└─────────────────┘                          └──────────────────────┘
```

## Data Model

### New table: `remote_machines` (local SQLite)

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT (UUID, PK) | Unique identifier |
| name | TEXT NOT NULL | Display name ("My Compute Box") |
| host | TEXT NOT NULL | SSH host (user@hostname) |
| port | INTEGER DEFAULT 22 | SSH port |
| identityFile | TEXT | Path to SSH key (~/.ssh/id_rsa) |
| projectsDir | TEXT DEFAULT '~/projects' | Base directory for cloned projects on remote |
| status | TEXT DEFAULT 'unknown' | 'connected' / 'disconnected' / 'unknown' |
| lastSeenAt | INTEGER | Last successful connection timestamp |
| createdAt | INTEGER | Creation timestamp |

### `projects` table changes

- Add `remoteMachineId` column: TEXT, nullable, FK to `remote_machines.id`
- Null = local project (no behavior change for existing projects)
- Non-null = remote project, `mainRepoPath` stores the remote absolute path

### `settings` table changes

- Add `defaultRemoteMachineId`: TEXT, nullable — the configured remote machine

## SSH Connection Manager

New module: `apps/desktop/src/main/lib/ssh/`

### `SshConnectionManager`

Uses the `ssh2` npm package for programmatic SSH control.

**Connection config:**
```typescript
ssh.connect({
  host, port, username,
  privateKey: readFileSync(identityFile),
  agent: process.env.SSH_AUTH_SOCK,  // forward local SSH agent
  agentForward: true,                // git on remote uses local keys
  keepaliveInterval: 15000,
  keepaliveCountMax: 3,
});
```

**Primitives:**
- `exec(command): Promise<{ stdout, stderr, code }>` — run command on remote
- `forwardUnixSocket(remotePath, localPath)` — forward remote daemon socket to local
- `reversePortForward(remotePort, localHost, localPort)` — for hook notifications
- `sftp()` — SFTP client for file transfers

**Events:** `connected`, `disconnected`, `error`, `reconnecting`

**Reconnection:** Exponential backoff (1s, 2s, 4s, 8s, max 30s). Re-establish socket forward + reverse tunnel on reconnect.

## Remote Provisioning

On first connect (or version mismatch), auto-provision `~/.superset/` on remote via SFTP:

1. Check `~/.superset/.version` on remote
2. If missing or outdated:
   - Upload terminal-host daemon script bundle
   - Upload agent shims (`bin/claude`, `bin/codex`, etc.)
   - Upload shell dotfiles (`zsh/`, `bash/`)
   - Write version marker
3. Start (or restart) daemon: `node ~/.superset/terminal-host.js`
4. Forward remote socket to local temp path

**Prerequisite:** Node.js on remote. App checks for `node` on remote PATH during first connect and shows error with install instructions if missing.

**Daemon lifecycle on remote:**
- Auto-started by Superset on connect
- Persists after Superset disconnects (sessions survive)
- On reconnect, Superset reattaches to existing daemon
- Listens on `~/.superset/terminal-host.sock`

## RemoteWorkspaceRuntime

### Registry update

```typescript
getForWorkspaceId(workspaceId: string): WorkspaceRuntime {
  const project = lookupProjectForWorkspace(workspaceId);
  if (project.remoteMachineId) {
    return this.getRemoteRuntime(project.remoteMachineId);
  }
  return this.getDefault(); // local
}
```

### RemoteTerminalRuntime

Implements the same `TerminalRuntime` interface as `LocalTerminalRuntime`. Creates a second `DaemonTerminalManager` instance pointed at the SSH-forwarded socket path. All operations (createOrAttach, write, resize, kill, etc.) go through this remote-pointed manager with zero protocol changes.

```typescript
class RemoteWorkspaceRuntime implements WorkspaceRuntime {
  id: "remote:<machineId>";
  terminal: RemoteTerminalRuntime;
  capabilities: {
    terminal: { persistent: true, coldRestore: false }
  };
}
```

`coldRestore: false` because we don't read remote scrollback files (yet).

## Remote Git Operations

### `GitOperations` interface

```typescript
interface GitOperations {
  clone(url: string, targetPath: string): Promise<void>;
  worktreeAdd(repoPath: string, branch: string, worktreePath: string, base: string): Promise<void>;
  worktreeRemove(repoPath: string, worktreePath: string): Promise<void>;
  status(repoPath: string): Promise<GitStatus>;
  fetch(repoPath: string, remote?: string): Promise<void>;
  getDefaultBranch(repoPath: string): Promise<string>;
}
```

Two implementations:
- `LocalGitOperations` — wraps existing `simple-git` calls
- `RemoteGitOperations` — wraps `SshConnectionManager.exec()` with raw git commands

Git auth on remote uses SSH agent forwarding (configured in SSH connection). Zero credential setup needed on remote.

## Agent Hooks on Remote

### SSH Reverse Tunnel

```
SSH connect with reverse forward:
  Remote port 18787 → Local SUPERSET_PORT
```

Uses fixed port `18787` (falls back to dynamic allocation if occupied).

### notify.sh on remote

Templated during provisioning with the tunneled port. `SUPERSET_PORT` env var in remote terminal sessions points to the tunneled port.

```bash
curl -sG "http://127.0.0.1:18787/hook/complete" \
  --data-urlencode "paneId=$SUPERSET_PANE_ID" \
  --data-urlencode "tabId=$SUPERSET_TAB_ID" ...
```

On reconnect with same fixed port, existing sessions' hooks continue working.

## Resilience

| Scenario | Recovery |
|----------|----------|
| Brief network blip (< 30s) | Auto-reconnect. Re-forward socket. Daemon still running. Sessions resume. |
| Extended outage | UI shows "Disconnected". Terminal writes queued (~10s buffer). On reconnect, sessions resume. |
| App restart | Re-establish SSH. Re-forward socket. Warm reattach to existing daemon sessions. |
| Remote machine reboot | Daemon dies. On reconnect, re-provision if needed, restart daemon. Terminal panes show "Session ended". |

## UI Changes

### Settings — Remote Compute section
- Fields: Name, Host, Port, SSH Key path, Projects directory
- "Test Connection" button (verifies SSH + Node.js availability)
- Connection status indicator

### Clone dialog
- Toggle: "Clone to: Local / Remote"
- When Remote: shows configured machine name, clones to remote projectsDir

### Project list
- Remote projects show badge/icon
- Connection status dot (green/yellow/red)

### Terminal panes
- No xterm.js changes — data flows through same tRPC observable
- Connection status overlay when SSH disconnected

## New files

```
apps/desktop/src/main/lib/
├── ssh/
│   ├── connection-manager.ts    — SshConnectionManager class
│   ├── provisioner.ts           — remote provisioning logic
│   └── types.ts                 — SSH config types
├── git/
│   ├── types.ts                 — GitOperations interface
│   ├── local.ts                 — LocalGitOperations (wraps simple-git)
│   └── remote.ts                — RemoteGitOperations (wraps SSH exec)
└── workspace-runtime/
    └── remote.ts                — RemoteWorkspaceRuntime + RemoteTerminalRuntime

packages/local-db/src/schema/
    schema.ts                    — add remote_machines table, projects.remoteMachineId
```

## Out of scope (future)

- Multiple remote machines
- Remote file browsing (open existing repo by path)
- Cold restore from remote scrollback files
- Auto-install agents on remote
- Web-based remote access (no Electron needed)
