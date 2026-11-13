# dsh-smart-restart

Current release line: **0.1.x** (verified zero-privilege restart, health verification, post-boot diff attribution, and WebUI dashboard for DeepSeek Harness).

## Purpose
Verified restart manager for DeepSeek Harness (DSH):
- **Zero-privilege restart**: Terminates process and lets systemd bring the service back (`Restart=always`).
- **Post-boot verification**: Probes listening ports, systemd unit health, core services, and package diff in the next process.
- **Report delivery**: Delivers structured health verdict and context snapshot directly to the agent session that requested the restart.
- **Direct chat command**: Provides `/restart` (and `!restart`, `/dsh-restart`, `/cancel-restart`) with arguments for confirm, dry-run, delay, and reason.
- **Interactive WebUI dashboard**: Embeds health badges, port status, and restart history in the plugin settings card (`RestartGuardCard`).
- **Grace period & emergency cancel**: Supports configurable delay with live countdown banner and emergency cancellation (`POST /dsh-smart-restart/cancel` and `dsh_restart_cancel`).

## Status
- Package: `@goodandready/dsh-smart-restart`
- Version: see `package.json`
- Verified: `npm test` (all unit test suites pass, 0 fail)

## Paths
- DEV root: `/mnt/external/Project/DEV/dhsplugins/dsh-smart-restart`
- Worktrees: `.worktrees/<branch>` only; DEV root checkout is read-only
- Gitea: `goodandready/dsh-smart-restart` (internal source of truth)
- GitHub: `GooDAnDReaDY/dsh-smart-restart` (sanitized public product mirror only)
- Production service: `dsh-web.service` on MiniAI (`192.168.1.111`), port 3080

## Entry Points
- Server entry: `lib/index.js` (Cordis plugin `apply`, tools `dsh_restart`, `dsh_restart_status`, `dsh_restart_cancel`, HTTP routes)
- Client entry: `lib/client.js` (Browser bundle for DSH `window.__ModuleLoader__.load()`, `RestartGuardCard`)
- Bundle patch: `cordis.patch.yml`

## Modules
- `lib/boot.js` — Boot marker recording, process listening port detection, cgroup parsing, package diff calculation, preflight checks, report formatting
- `lib/chat-command.js` — Chat command `/restart` registration, arguments parser, fallback chat middleware, safe Cordis proxy getter (`safeGet`)
- `lib/client.js` — WebUI dashboard card, status badges, recent restarts table, grace period countdown banner, cancel button
- `lib/index.js` — Cordis plugin lifecycle, agent tools registration, approval interception, post-boot delivery loop, HTTP webServer routes
- `scripts/pack-check.mjs` — Artifact hygiene and package size validation (< 256 KiB limit, no stray `.tgz` in root)
- `deploy.sh` — Canonical deployment and quality gate verification runner

## Commands
```bash
npm test                 # Run all automated unit tests
npm run pack:check       # Verify file size budget (< 256 KiB) and packaging cleanliness
npm run pretest          # Run pack:check and node --check on all lib/*.js files
./deploy.sh              # Run pre-deploy verification
```
