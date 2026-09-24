# @goodandready/dsh-smart-restart
<div align="center">
<h3>A restart that is verified, not announced.</h3>
<p align="center"><a href="https://www.npmjs.com/package/@goodandready/dsh-smart-restart">npm</a> · <a href="LICENSE">MIT</a> · <a href="https://github.com/topics/dsh-plugin">DSH plugin</a></p>
<p align="center"><a href="https://goodandready.app/">DSH Hub — goodandready.app</a></p>
<p align="center"><a href="README.md"><b>English</b></a> • <a href="README.zh.md">中文</a> • <a href="README.ru.md">Русский</a></p>
<table align="center"><tr><td align="center">
⭐ <strong>If you like this plugin, please star it on GitHub</strong> — it shows that the plugin is useful and supports continued development.
<br><br>
🐛 <strong>If you find a bug or want to request a feature</strong>, open a GitHub issue in any language.
</td></tr></table>
</div>


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

## Architecture

~~~mermaid
graph LR
  A[DSH web profile] --> B[Host plugin]
  B --> C[Restart intent and guard]
  C --> D[Service manager restarts DSH]
  D --> E[Next-process health checks]
  E --> F[Report to requesting session]
  A --> G[Client module loader]
  G --> H[Settings card]
  H --> B
~~~

The browser half is registered as a lazy CommonJS factory with the DSH client loader. The factory returns its apply and inject exports; the host half owns restart tools, health checks, and the report.

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

## Module breakdown

- lib/index.js is the Cordis host entry: settings, restart/status tools, boot checks, and delivery of the post-restart report.
- lib/boot.js contains pure restart detection, loop guard, cgroup/port checks, verdict composition, and report formatting.
- lib/client.js registers the browser settings card through DSH's lazy client-module loader; its factory returns the CommonJS export object.
- cordis.patch.yml inserts the package into the selected web profile.

## Install

```bash
dsh plugin --profile <profile> add @goodandready/dsh-smart-restart
```

Requires a systemd-managed harness (`dsh-web.service` or any unit with `Restart=always`) for the
default mode; the unit is detected from the process cgroup, and can be set explicitly.

## Settings

| Setting | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Whether the plugin registers its tools and checks a boot at all. |
| `restartMode` | string | `kill` | `kill` ends the process and lets systemd restart it (no privileges); `systemctl` runs `systemctl restart <unit>`. |
| `unit` | string | empty (auto) | The systemd unit to inspect and restart. Empty detects it from `/proc/self/cgroup`. |
| `delayMs` | number | `3000` | How long to wait before the process ends, so the tool's answer reaches the caller. |
| `target` | string | `requester` | Where the report goes: `requester` (the session that asked), `primary`, or a session id. |
| `stateDir` | string | `.restart-guard` | State directory under `$DSH_HOME`: boot marker, intent, last report, and history. |
| `maxRestarts` | number | `3` | Refuse a restart after this many inside the window. |
| `windowMs` | number | `600000` | The loop-guard window in milliseconds. |
| `timeoutMs` | number | `5000` | Timeout for each individual health probe. |
| `expectTools` | string[] | `[]` | Tool names that must be registered after a boot, otherwise the verdict is degraded. |
| `toolEnabled` | boolean | `true` | Register `dsh_restart` / `dsh_restart_status`. |

## Tools

- `dsh_restart` — parameters `reason`, `resume`, `confirm`, `delayMs`. Records the intent, checks
  the loop guard, schedules the restart and returns a receipt. The session that called it is the
  one that receives the verdict afterwards.
- `dsh_restart_status` — last boot and downtime, the last health report, the pending intent, and
  how many restarts happened inside the window.

## What the report looks like

```
smart-restart: the harness restarted and the boot check passed.
- boot: <boot timestamp> (was down 6.2s, pid 12345)
- ok services: webServer, tools, agents, settings
- ok tools: 61 registered
- ok unit: active/running, NRestarts 0
- ok port: 127.0.0.1:<port> owned by pid in system.slice/dsh-web.service
- ok versions: plugin 0.1.0, core <core-version>
verdict: ok
resume: continue the recorded task and report the result
```

## Limits

- The default mode relies on the service manager restarting the process (`Restart=always`); on a
  bare process started by hand there is nothing to bring it back, and the plugin says so instead
  of pretending.
- The kill mode loses the in-flight turn by design; the intent file is what makes the next turn
  meaningful.
- The port and cgroup checks are Linux-specific and degrade to "not checked" elsewhere.

## Troubleshooting

- If DSH reports that the plugin client failed to import with module is not defined, use a release whose lazy client factory defines and returns its CommonJS exports, then reload the DSH web profile.
- Host-side tools may load while the browser settings card fails; check client-module boot errors separately.

## Development

```bash
npm test
```

## License

MIT © GooDAnDReaDY
