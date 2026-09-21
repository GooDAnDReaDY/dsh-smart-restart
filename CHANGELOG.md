# Changelog

Notable changes to `@goodandready/dsh-restart-guard`.

## 0.1.0

First release: a restart that is verified instead of announced.

- `dsh_restart` restarts the harness **without privileges**: the host terminates its own process
  and systemd brings the service back (`Restart=always`), so no `systemctl`, sudo or polkit rule
  is needed. `systemctl restart <unit>` stays available as an alternative mode;
- after the boot the plugin runs a **health check** and forms a verdict: harness services present,
  the number of registered tools (and, when configured, required names), the unit's state and
  restart counter, whether the port is owned by a process inside the unit's cgroup (the lesson of
  a production incident where a stray process held the port while the unit looped), and the
  versions of the plugin and the core;
- the **report goes to the session that asked**: what restarted, when, how long it was down, the
  verdict with every check, and the line "resume: …" taken from the intent recorded before the
  restart. A session that comes up late is waited for, bounded;
- `dsh_restart_status` shows the last boot, the last report, the pending intent and how many
  restarts happened inside the window;
- a **loop guard** refuses more than three restarts in ten minutes, so a broken boot cannot turn
  into an endless cycle driven by an agent.
