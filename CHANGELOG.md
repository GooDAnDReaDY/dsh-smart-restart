# Changelog

## 0.1.8

### Fixed
- **DevDependencies upgraded to ^0.2.0-rc.2** (#25): `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-session`, and `@deepseek-ai/dsh-home-paths` bumped to `^0.2.0-rc.2`, aligning dev toolchain with modern core APIs while preserving peer compatibility with `^0.1.7-rc.2 || ^0.2.0-rc.1`.
- **Client settings form unavailable state handling** (#26): `RestartGuardCard` logs a warning when settings scope is missing, guards against null scope, and renders a localized unavailable notice (`unavailable`) instead of attempting unsaveable form interaction.
- **Core chevron down icon request with graceful SVG fallback** (#27): client queries `IconChevronDownOutline14` from `@deepseek-ai/dsh-client-ui-primitives` adhering to DSH design guidelines, rotating 180° when open, with an inline SVG fallback if the primitive is unavailable.
- **Cleaned up redundant title expression** (#28): eliminated dead ternary in client card header, cleanly referencing `t(title)`.
- **Locale registration cleanup in ctx.effect** (#29): locale bundles (`en`, `zh`) are now registered within `ctx.effect`, returning the unregistration disposer to prevent lingering locale state on plugin reload.
- **Theme design token alignment** (#30): replaced non-standard `--dsw-alias-label-error` with design token `var(--dsw-alias-state-error-primary)`.

## 0.1.7

### Fixed
- **Boot marker version detection & readBoot integration** (#18, #31): `readBoot()` now populates `dshVersion` (from options or `process.env.DSH_VERSION`) and `pluginVersion`, and is invoked when writing `marker.json` to record the exact runtime versions that produced the boot marker.
- **Post-restart report delivery for primary session** (#19): `resolveAgent()` now gracefully falls back to `ctx.agents.roots()[0]` or `ctx.agents.list()[0]` when `target: 'primary'` or when `sessionId` is empty, ensuring the restart verdict and resumed work are delivered.
- **Intent preservation without session ID** (#20): `intentState()` now recognizes intents with recorded `reason` or `resume` even if no caller `sessionId` was resolved, and cleans up `intent.json` post-delivery so stale intents do not linger.
- **Safe delivery retry ticks** (#21): wrapped timer ticks and agent delivery in `try/catch` and added error logging, preventing unhandled exceptions from terminating background timer loops.
- **Crash loop restart budget preservation** (#22): `history.json` now records boot timestamps only when an actual restart occurred (`boot.wasRestart === true`), preventing cold boots and plugin reloads from exhausting the crash loop restart budget.
- **Probe timeout cleanup** (#23): `probe()` health checks now register timers through `safeSetTimeout()` and reliably clear timeout handles on resolution, eliminating dangling timers in the event loop.

## 0.1.6

### Fixed
- **Settings unwrapping order (Unwrap → Validate → Unwrap)** (#24): apply() now unwraps rawConfig before Config() schema validation and unwraps the result, preventing Volatile box copy failures or fallbacks to schema defaults.
- **Unified settings namespace in client seat registration** (#12): plugins.item seat registration now uses the bare host-plane namespace id: NS (goodandready-smart-restart), matching cordis.patch.yml and preventing composite key mismatches.
- **Config form scope error logging** (#26): eliminated empty catch block during client-side config forms / settings scope resolution; errors are now logged via ctx.logger.warn.

## 0.1.4

### Fixed
- **Peer gate on DSH 0.2.0-rc.1** (#58): the bundle was skipped at profile startup because its `peerDependencies` excluded the running version.
- **Settings card served no form**: `NS` was the package name rather than the profile entry id, `Config` declared no `.volatile()` field, and `getConfig` handed out `Volatile` boxes. Both 0.1.7-rc.2 and 0.2.0 now serve and read the form.
- **A saved setting never took effect**: the host applied changes through `settings.register` and `scope.watch`, neither of which exists in either release. Changes are applied on `loader/volatile-update` now.
- **`settings.plugin.item` registration removed**: retired before DSH 0.1.7-rc.2, so it only registered the card a second time on a seat that no longer exists.

## 0.1.3

### Fixed
- **Peer gate on DSH 0.2.0-rc.1** (#58): the bundle was skipped at profile startup because its `peerDependencies` excluded the running version.
- **Settings card served no form**: `NS` was the package name rather than the profile entry id, `Config` declared no `.volatile()` field, and `getConfig` handed out `Volatile` boxes. Both 0.1.7-rc.2 and 0.2.0 now serve and read the form.
- **A saved setting never took effect**: the host applied changes through `settings.register` and `scope.watch`, neither of which exists in either release. Changes are applied on `loader/volatile-update` now.
- **`settings.plugin.item` registration removed**: retired before DSH 0.1.7-rc.2, so it only registered the card a second time on a seat that no longer exists.

## 0.1.2

### Fixed
- **Peer gate on DSH 0.2.0-rc.1** (#58): DSH skips a profile bundle whose `peerDependencies` exclude the running version, so this plugin was absent from the profile with no error in the UI. Every `@deepseek-ai/dsh-*` peer now names both the 0.1.7-rc.2 and 0.2.0-rc.1 lines, because semver does not admit a prerelease of the next minor into a range that does not name it.

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
