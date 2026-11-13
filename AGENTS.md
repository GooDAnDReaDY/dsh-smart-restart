# AGENTS.md — @goodandready/dsh-smart-restart

Project-specific rules only. Root `/mnt/external/Project/DEV/AGENTS.md` still applies.

## Identity
- Package name: `@goodandready/dsh-smart-restart`
- Host plugin name: `dsh-smart-restart` (`export const name = 'dsh-smart-restart'`)
- WebUI settings namespace: `goodandready-smart-restart` (`export const NS = 'goodandready-smart-restart'`)
- Gitea repository: `goodandready/dsh-smart-restart`
- GitHub mirror: `GooDAnDReaDY/dsh-smart-restart`
- Agent git wrapper: `/home/vadim/.ssh/bin/git-antigravity`; never bare `git` for commit or push

## Layout & Worktrees
- Root checkout is read-only. All modifications happen strictly in `.worktrees/<branch>`
- Single DEV folder + single production profile (`dsh-web.service` on MiniAI)
- WebUI bundle: `lib/client.js` is self-contained and loaded via DSH ModuleLoader
- Server entry: `lib/index.js` manages lifecycle, agent tools, and WebServer endpoints

## Commands
```bash
npm test                 # Run all unit tests (node --test test/*.test.mjs)
npm run pack:check       # Verify file size budget (< 256 KiB) and packaging hygiene
npm run pretest          # Run pack:check and node --check on all lib/*.js files
```
- Tests must execute locally without live DSH harness and without external network connectivity
- Zero failures permitted in automated test suites

## Security & Architectural Constraints
- Zero-privilege restart: process termination (`kill`) relies on systemd `Restart=always`; never execute shell commands with `sudo` for default restart flow
- Path isolation: state directory is strictly restricted to `$DSH_HOME/.restart-guard` (`resolveSafeStateDir`), preventing directory traversal
- Loop guard: enforce rate limiting (`loopGuard`) within sliding time window (`windowMs`) to prevent restart loops
- Safe Cordis Context Resolution: optional services (`middleware`, `approval`, `logger`, `commands`) must be probed defensively via `safeGet(ctx, prop)` without triggering proxy traps
- Producer-Owned Message Source: report messages delivered to sessions must carry `source: { kind: 'plugin:dsh-smart-restart', ... }` (never catch-all `plugin`)
- Zero empty catches: all `catch` blocks must either log or explicitly bind `catch (err) { void err }` to satisfy preflight rules
- Packaging budget: all files in npm package must remain under 262144 bytes (`pack-check.mjs`)

## Publication Safety (MUST NOT)
- `AGENTS.md`, `index.md`, and `deploy.sh` are internal project documentation and MUST NEVER be published to npm or mirrored to public GitHub
- Exclusion is guaranteed by `package.json` `files` allowlist and `.gitattributes` (`export-ignore`)
- Do not use force flags (`--force`, `git push -f`, `npm publish --force`) under any circumstances
