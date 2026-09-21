# @goodandready/dsh-restart-guard

**A restart that is verified, not announced.** The agent restarts DeepSeek Harness, and when the
process comes back this plugin checks that everything is really up, reports the verdict into the
session that asked for the restart, and hands back what that session was doing.

## Why

A restart is the only operation that destroys the thing performing it. The existing answer to
that is a notice: "the service restarted at …". It leaves the two questions that matter open —
*is the harness actually healthy now*, and *what was I in the middle of* — and on a system unit
it needs either root or a polkit rule, because it calls `systemctl restart` from a detached shell
whose errors go to `/dev/null`: a refused restart looks exactly like a successful one.

This plugin closes both gaps and needs no privileges.

## Features

- **Restart without privileges.** The default mode terminates the harness process and lets systemd
  start it again (`Restart=always`). Nothing is called, nothing is spawned detached, no sudo, no
  polkit. `systemctl restart <unit>` remains as an alternative mode for deployments that already
  grant the right.
- **A health check after every boot.** The plugin inspects the composed services, the number of
  registered tools, the unit's `ActiveState`/`MainPID`/`NRestarts`, whether the listening port is
  owned by a process inside the unit's cgroup, and the versions of the plugin and the core. The
  outcome is a verdict — `ok`, or `degraded` with the list of checks that failed.
- **A report in the session that asked.** Before restarting, the plugin records an intent: which
  session, why, and what to continue. After the boot the intent and the verdict travel back to
  that session as a message, so the work resumes with the facts in hand instead of a guess. A
  session that comes up late is waited for, with a bound.
- **A loop guard.** More than three restarts inside ten minutes is refused with the reason, so a
  boot that keeps failing cannot be papered over by an agent restarting it forever.
- **Settings card** in the plugin list, with English and Chinese strings (Russian comes from
  `dsh-russian-lang`).

## Install

```bash
dsh plugin --profile <profile> add @goodandready/dsh-restart-guard
```

Requires a systemd-managed harness (`dsh-web.service` or any unit with `Restart=always`) for the
default mode; the unit is detected from the process cgroup, and can be set explicitly.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Whether the plugin registers its tools and checks a boot at all. |
| `restartMode` | `kill` | `kill` ends the process and lets systemd restart it (no privileges); `systemctl` runs `systemctl restart <unit>`. |
| `unit` | *(auto)* | The systemd unit to inspect and restart. Empty detects it from `/proc/self/cgroup`. |
| `delayMs` | `3000` | How long to wait before the process ends, so the tool's answer reaches the caller. |
| `target` | `requester` | Where the report goes: `requester` (the session that asked), `primary`, or a session id. |
| `stateDir` | `.restart-guard` | State directory under `$DSH_HOME`: boot marker, intent, last report. |
| `maxRestarts` | `3` | Refuse a restart after this many inside the window. |
| `windowMs` | `600000` | The loop-guard window. |
| `healthTimeoutMs` | `5000` | Timeout for a single health probe. |
| `expectTools` | `[]` | Tool names that must be registered after a boot, otherwise the verdict is degraded. |
| `toolEnabled` | `true` | Register `dsh_restart` / `dsh_restart_status`. |

## Tools

- `dsh_restart` — parameters `reason`, `resume`, `confirm`, `delayMs`. Records the intent, checks
  the loop guard, schedules the restart and returns a receipt. The session that called it is the
  one that receives the verdict afterwards.
- `dsh_restart_status` — last boot and downtime, the last health report, the pending intent, and
  how many restarts happened inside the window.

## What the report looks like

```
restart-guard: the harness restarted and the boot check passed.
- boot: 2026-09-21T20:41:12.004Z (was down 6.2s, pid 12345)
- ok services: webServer, tools, agents, settings
- ok tools: 61 registered
- ok unit: active/running, NRestarts 0
- ok port: 127.0.0.1:3080 owned by pid in system.slice/dsh-web.service
- ok versions: plugin 0.1.0, core 0.1.6-alpha.2
verdict: ok
resume: finish the release of dsh-github-ops 0.2.1 and tell the owner the result
```

## Limits

- The default mode relies on the service manager restarting the process (`Restart=always`); on a
  bare process started by hand there is nothing to bring it back, and the plugin says so instead
  of pretending.
- The kill mode loses the in-flight turn by design; the intent file is what makes the next turn
  meaningful.
- The port and cgroup checks are Linux-specific and degrade to "not checked" elsewhere.

## Development

```bash
npm test
```

## License

MIT © GooDAnDReaDY
