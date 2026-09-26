# Changelog

Notable changes to `@goodandready/dsh-smart-restart`.

## 0.1.1
- Settings precedence: `live()` now correctly merges saved `settingsScope` on top of defaults, ensuring configuration updates apply dynamically (#2).
- Systemd user unit restart: added `--user` flag to `systemctl restart` when running in a user cgroup slice (#3).
- Lifecycle cleanup: bound tool registrations and background timers to Cordis 4 `ctx.effect` with an explicit disposer to prevent leaks across host reloads (#6).
- Canonical slot registration: registered `settings.plugin.item` with `key: NS` and `locale: NS`, removed hardcoded CSS colors, and added snapshot status handling (#7).
- Updater contract: documented that the plugin is managed via DSH package manager (CLI/pnpm) and verifies compatibility on post-update restart (#8).
- Release sanitization: confirmed package allowlist in `package.json` keeps tests and internal design docs out of published artifacts (#9).

## 0.1.0
Fixed web client loader compatibility: the lazy CommonJS factory now defines and returns its exports, so DSH can load the settings card without a module is not defined error.

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
