# Changelog

## 0.1.13

### Features
- **Direct chat command for safe DSH restart without SSH** (#44): Added slash command `/restart` (and aliases `!restart`, `/dsh-restart`) for instant restart directly from conversation without opening terminal or SSH. Dual-path architecture: registered via `@deepseek-ai/dsh-commands` and backed by a resilient fallback chat middleware. Supports interactive confirmation prompts (`/restart --confirm`, `-y`), simulation mode (`/restart --dry-run`), custom delay (`/restart --delay=10s`), reason tags (`/restart --reason="..."`), cancellation (`/restart cancel`, `/cancel-restart`), and instant health inspection (`/restart status`). The calling chat session is automatically captured as the post-boot delivery target, and the post-restart health verdict and package diff report are delivered right back into the same conversation.

## 0.1.12

### Features
- **Interactive reliability dashboard & safe restart in WebUI** (#42): `RestartGuardCard` now embeds an interactive health dashboard. Displays live verdict status badges (`Healthy`, `Degraded`, `Loop guard active`), breakdown pills for individual checks (core services, systemd unit, port, version), and a collapsible recent restarts history table with timestamps, downtime durations, and reasons. Includes an interactive "Safe Restart" action with preflight validation, customizable delay, and confirmation dialog.
- **Grace period countdown banner & restart cancellation** (#43): When a restart is scheduled with a delay, WebUI displays a live countdown banner showing remaining seconds, reason, and an emergency "Cancel Restart" button. Adds HTTP endpoint `POST /dsh-smart-restart/cancel` and agent tool `dsh_restart_cancel` to immediately clear pending restart timers, delete `intent.json`, notify calling sessions, and prevent unexpected harness termination.

## 0.1.11

### Features
- **Rich situational snapshot on restart** (#40): `dsh_restart` now accepts an optional structured `context` object capturing active working state (`cwd`, `branch`, `worktree`, `files`, `tasks`, `memoryTag`, plus arbitrary extra keys). Defaults `cwd` to `process.cwd()` when omitted. Context is persisted into `intent.json` across restarts, reported in post-boot agent notifications under `- context: ...`, and exposed through `dsh_restart_status` tool for immediate resumption of work without manual reorientation.
- **Diff attribution between boots** (#41): `marker.json` now records an inventory snapshot of installed packages (`dependencies` and `devDependencies` from `package.json` / profile configs). On boot, `diffPackages()` calculates packages added, removed, or upgraded since the previous marker. Package changes are attributed in `last-report.json`, exposed via `dsh_restart_status.lastDiff`, and formatted into the post-boot report under `- changes: ...`.

## 0.1.10

### Features
- **Pre-flight configuration and environment validation before restart** (#38): `dsh_restart` now validates `package.json` (JSON syntax) and `cordis.patch.yml` / `cordis.yml` (YAML tab indentation & delimiter balance via `validateYamlSyntax`), systemd unit syntax, and network port conflicts before initiating restart. If any check fails, the restart is aborted, and an actionable diagnostic alert is delivered directly to the chat session via `deliverTo(sessionId, failureMessage)`. Added `dryRun: true` parameter to simulate preflight checks without restarting.
- **Graceful drain guard for active agent tasks** (#39): `dsh_restart` now inspects running agent turns in `ctx.agents` via `countActiveAgents(agents, callerSessionId)` and waits for in-flight tasks to finish before terminating the harness (`drainActiveAgents`). Configurable via `drainTimeoutMs` (default `15000` ms) in plugin config and the WebUI settings card. Drain metrics (`drained`, `waitedMs`, `activeCount`) are recorded into `intent.json` and reported in the tool response.

## 0.1.9

### Security
- **Host approval primitive for harness restart** (#36): `dsh_restart` tool no longer treats `{ confirm: true }` from the calling LLM agent as final authorization to restart the harness. Added `requireApproval: Schema.boolean().default(true).volatile()` to config and registered a `tools/pre-execute` waterfall hook returning `{ kind: 'ask', reason: ... }`. Host approval is requested via `ctx.approval.request()` before triggering `systemctl` or process signals.
- **Systemd unit name validation & detection check** (#36): `systemctlRestartArgs` now enforces strict unit name syntax matching `/^[A-Za-z0-9@_.-]+\.service$/` and validates configured units against the running unit detected from `/proc/self/cgroup` (`allowedUnit`). Invalid or unauthorized unit specifications fail closed.
