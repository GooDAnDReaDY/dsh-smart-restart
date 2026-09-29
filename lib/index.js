// dsh-restart-guard — host half.
//
// A restart destroys the process performing it, so the operation cannot be verified by the thing
// that asked for it — unless the verification happens in the NEXT process. That is what this
// plugin does: it records why the restart was asked for, terminates the process (systemd brings
// the service back because Restart=always, so no privileges are needed), and after the boot it
// checks the harness, forms a verdict, and delivers both to the session that asked.
//
// Nothing here spawns a detached shell to restart: the default mode ends this process and lets
// the service manager do its job.

import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { promisify } from 'node:util'

import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

import { buildReport, composeChecks, detectRestart, intentState, loopGuard, ownerBelongsToUnit, parseCgroupUnit, parseListenPortsForPid, systemctlRestartArgs, unitScopeFromCgroup } from './boot.js'

export const name = 'dsh-smart-restart'

// The settings namespace is the profile entry id from cordis.patch.yml, not the
// package name. DSH keys a served form by entry id, so a package-name namespace
// resolves to nothing. Must match NS in lib/client.js.
export const NS = 'goodandready-smart-restart'

const run = promisify(execFile)
const require = createRequire(import.meta.url)

export const Config = Schema.object({
  enabled: Schema.boolean().default(true)
    .volatile().description('Register the tools, check every boot, and report the verdict to the session that asked.'),
  restartMode: Schema.string().default('kill')
    .volatile().description('"kill" ends the process and lets systemd restart the service (no privileges); "systemctl" runs systemctl restart <unit>.'),
  unit: Schema.string().default('')
    .volatile().description('systemd unit to inspect and restart. Empty detects it from /proc/self/cgroup.'),
  delayMs: Schema.number().default(3000)
    .volatile().description('How long to wait before the process ends, so the answer reaches the caller first.'),
  target: Schema.string().default('requester')
    .volatile().description('Where the post-restart report goes: "requester" (the session that asked), "primary", or a session id.'),
  stateDir: Schema.string().default('.restart-guard')
    .volatile().description('State directory under $DSH_HOME: boot marker, intent, last report, history.'),
  maxRestarts: Schema.number().default(3)
    .volatile().description('Refuse a restart after this many inside the window, so a broken boot cannot loop forever.'),
  windowMs: Schema.number().default(600000)
    .volatile().description('The loop-guard window in milliseconds.'),
  timeoutMs: Schema.number().default(5000)
    .volatile().description('Timeout for a single health probe.'),
  expectTools: Schema.array(Schema.string()).default([])
    .volatile().description('Tool names that must be registered after a boot; a missing one makes the verdict degraded.'),
  toolEnabled: Schema.boolean().default(true)
    .volatile().description('Register dsh_restart and dsh_restart_status.'),
})

// DSH serves a namespace's settings form from the volatile fields of its profile
// entry schema, and a volatile field holds a Volatile box rather than its value.
// Unwrap before any caller reads one, and read lazily: the Loader mutates the
// boxes in place and re-announces them with loader/volatile-update.
export function plainConfig(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(plainConfig)
  if (typeof value.get === 'function') return plainConfig(value.get())
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plainConfig(v)]))
}

export function apply(ctx, rawConfig) {
  let validatedConfig = {}
  try {
    validatedConfig = plainConfig(Config(rawConfig || {}))
  } catch (err) {
    ctx.logger?.warn?.('[smart-restart-guard] invalid config provided, using defaults:', err && err.message)
    validatedConfig = plainConfig(Config({}))
  }
  // DSH hands the plugin the entry config, and the Loader mutates THAT object in
  // place when it re-merges volatile profile entries. A copy parsed at boot keeps
  // the values it captured and never sees a later card save, so live() must read the
  // entry object itself and unwrap on each access. validatedConfig stays for the
  // boot-time defaults only.
  const entryConfig = rawConfig || {}
  const config = validatedConfig
  const live = () => plainConfig(entryConfig)

  // settings.register exists in neither DSH 0.1.7-rc.2 nor 0.2.0, so the scope it
  // used to hand back could never exist. live() above reads the entry config
  // directly; this hook keeps the dependency explicit. Before the fix a card save
  // changed nothing at runtime.
  if (typeof ctx.on === 'function') {
    try {
      ctx.on('loader/volatile-update', () => {
        void live()
      })
    } catch (err) {
      ctx.logger?.warn?.('[smart-restart-guard] volatile-update subscription failed:', err && err.message)
    }
  }

  const activeTimers = new Set()
  const safeSetTimeout = (fn, ms) => {
    let timerId = null
    timerId = setTimeout(() => {
      activeTimers.delete(timerId)
      fn()
    }, ms)
    activeTimers.add(timerId)
    return timerId
  }
  const clearAllTimers = () => {
    for (const timerId of activeTimers) {
      clearTimeout(timerId)
    }
    activeTimers.clear()
  }
  const home = () => {
    try {
      return resolveDshHome()
    } catch {
      return process.env.DSH_HOME || join(process.env.HOME || '/root', '.dsh')
    }
  }
  const stateDir = () => join(home(), live().stateDir || '.restart-guard')
  const pathOf = (file) => join(stateDir(), file)

  function readJson(file) {
    try {
      return JSON.parse(readFileSync(pathOf(file), 'utf8'))
    } catch {
      return null
    }
  }

  function writeJson(file, value) {
    try {
      mkdirSync(stateDir(), { recursive: true })
      // A result must survive JSON without losing anything: one undefined drops the whole answer.
      const clean = JSON.parse(JSON.stringify(value))
      writeFileSync(pathOf(file), `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600 })
      return true
    } catch (err) {
      ctx.logger?.warn?.('[smart-restart-guard] cannot write', file, err && err.message)
      return false
    }
  }

  /** The unit this process runs under, read from our own cgroup. */
  function detectUnit() {
    try {
      return parseCgroupUnit(readFileSync('/proc/self/cgroup', 'utf8'))
    } catch {
      return ''
    }
  }

  const unitName = () => live().unit || detectUnit()

  function versionOf(pkg, fallback = '0.1.1') {
    if (pkg === '@goodandready/dsh-smart-restart') {
      try {
        return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || fallback
      } catch {
        return fallback
      }
    }
    try {
      return require(`${pkg}/package.json`).version || fallback
    } catch {
      return fallback
    }
  }

  async function probe(name, fn) {
    try {
      const value = await Promise.race([
        fn(),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('timed out')), live().timeoutMs || 5000)),
      ])
      return value || { name, ok: true, detail: 'ok' }
    } catch (err) {
      return { name, ok: false, detail: String((err && err.message) || err) }
    }
  }

  // ------------------------------------------------------------------ health checks

  async function checkServices() {
    const wanted = ['webServer', 'tools', 'agents']
    const present = wanted.filter((service) => {
      try {
        return Boolean(ctx.get(service))
      } catch {
        return false
      }
    })
    const missing = wanted.filter((service) => !present.includes(service))
    return {
      name: 'services',
      ok: missing.length === 0,
      detail: missing.length ? `missing: ${missing.join(', ')}` : present.join(', '),
    }
  }

  async function checkTools() {
    const expected = live().expectTools || []
    let names = []
    try {
      const service = ctx.get('tools')
      const listed = service && typeof service.list === 'function' ? service.list() : null
      if (Array.isArray(listed)) names = listed.map((entry) => (typeof entry === 'string' ? entry : entry && entry.name)).filter(Boolean)
    } catch {
      names = []
    }
    if (names.length === 0 && expected.length === 0) {
      return { name: 'tools', ok: true, skipped: true, detail: 'the tool registry does not expose a list here' }
    }
    const missing = expected.filter((tool) => !names.includes(tool))
    return {
      name: 'tools',
      ok: missing.length === 0,
      detail: names.length ? `${names.length} registered${missing.length ? `, missing: ${missing.join(', ')}` : ''}` : `missing: ${missing.join(', ')}`,
    }
  }

  async function checkUnit() {
    const unit = unitName()
    if (!unit) return { name: 'unit', ok: false, detail: 'no systemd unit could be detected' }
    // A user unit lives in the user manager: `systemctl show` without `--user` reports it as
    // inactive, which would turn a healthy boot into a false alarm.
    let cgroupText = ''
    try {
      cgroupText = readFileSync('/proc/self/cgroup', 'utf8')
    } catch {
      cgroupText = ''
    }
    const args = unitScopeFromCgroup(cgroupText) === 'user'
      ? ['--user', 'show', unit, '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID', '-p', 'NRestarts']
      : ['show', unit, '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID', '-p', 'NRestarts']
    const { stdout } = await run('systemctl', args, { timeout: live().timeoutMs || 5000 })
    const value = (key) => (String(stdout).match(new RegExp(`^${key}=(.*)$`, 'm')) || [])[1] || ''
    const state = value('ActiveState')
    const sub = value('SubState')
    const restarts = Number(value('NRestarts') || 0)
    const ok = state === 'active' && restarts <= 1
    return {
      name: 'unit',
      ok,
      detail: `${state}/${sub}, MainPID ${value('MainPID') || '?'}, NRestarts ${restarts}${ok ? '' : ' — the service is not settled'}`,
    }
  }

  async function checkPort() {
    const unit = unitName()
    if (!unit) return { name: 'port', ok: true, skipped: true, detail: 'no unit, nothing to compare against' }
    let output = ''
    try {
      const result = await run('ss', ['-ltnp'], { timeout: live().timeoutMs || 5000 })
      output = result.stdout
    } catch {
      return { name: 'port', ok: true, skipped: true, detail: 'ss is unavailable here' }
    }
    // No hardcoded port: the question is whether the port WE serve is held by a process inside
    // our own unit, so the ports are read from our own pid.
    const ports = parseListenPortsForPid(output, process.pid)
    if (ports.length === 0) return { name: 'port', ok: true, skipped: true, detail: 'this process is not listening anywhere' }
    let cgroup = ''
    try {
      cgroup = readFileSync(`/proc/${process.pid}/cgroup`, 'utf8')
    } catch {
      cgroup = ''
    }
    const verdict = ownerBelongsToUnit({ ownerCgroup: cgroup, unit })
    return { name: 'port', ok: verdict.ok, detail: `port(s) ${ports.join(', ')} held by pid ${process.pid}: ${verdict.detail}` }
  }

  function checkVersions() {
    const plugin = versionOf('@goodandready/dsh-smart-restart', '0.1.1')
    const core = versionOf('@deepseek-ai/dsh', '')
    const previous = readJson('marker.json')?.pluginVersion || ''
    return {
      name: 'versions',
      ok: true,
      detail: `plugin ${plugin}${core ? `, core ${core}` : ''}${previous && previous !== plugin ? ` (was ${previous})` : ''}`,
    }
  }

  async function healthCheck() {
    const checks = await Promise.all([
      probe('services', checkServices),
      probe('tools', checkTools),
      probe('unit', checkUnit),
      probe('port', checkPort),
      probe('versions', checkVersions),
    ])
    return composeChecks(checks)
  }

  // ------------------------------------------------------------------ delivery

  function cleanPayload(value) {
    try {
      return JSON.parse(JSON.stringify(value))
    } catch {
      return {}
    }
  }

  function targetSession(intent) {
    const mode = live().target || 'requester'
    if (mode === 'requester') return intent?.sessionId || ''
    if (mode === 'primary') return ''
    return mode
  }

  function deliverTo(sessionId, text) {
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: name, form: 'notice', summary: text.split('\n')[0] },
    })
    const agent = sessionId ? ctx.agents.get(SessionId(sessionId)) : null
    if (agent) {
      agent.followup(message)
      return true
    }
    return false
  }

  /** The session that asked may come up late; wait for it, but not forever. */
  function deliverWithWait(sessionId, text, attempts = 30) {
    let left = attempts
    const tick = () => {
      if (deliverTo(sessionId, text)) return
      left -= 1
      if (left > 0) safeSetTimeout(tick, 1000)
      else ctx.logger?.warn?.('[smart-restart-guard] could not deliver the report; no live session for', sessionId || '(primary)')
    }
    tick()
  }

  // ------------------------------------------------------------------ boot

  const previousMarker = readJson('marker.json')
  const boot = detectRestart(previousMarker)
  const intent = readJson('intent.json')
  const history = readJson('history.json') || []
  writeJson('marker.json', {
    pid: process.pid,
    bootAt: new Date().toISOString(),
    pluginVersion: versionOf('@goodandready/dsh-smart-restart', '0.1.1'),
    dshVersion: versionOf('@deepseek-ai/dsh', ''),
  })
  writeJson('history.json', [...(Array.isArray(history) ? history : []), Date.now()].slice(-50))

  if (boot.wasRestart && live().enabled !== false) {
    const state = intentState(intent)
    // Give the composition a moment to settle before judging it.
    safeSetTimeout(async () => {
      try {
        const composed = await healthCheck()
        const report = buildReport({
          bootAt: new Date().toISOString(),
          downtimeMs: boot.downtimeMs,
          pid: process.pid,
          checks: composed.checks,
          resume: state.present && !state.stale ? state.resume : state.present ? `${state.resume} (recorded at ${intent.at}, may be stale)` : '',
          reason: state.present ? state.reason : '',
          previousVersion: previousMarker?.pluginVersion || '',
          version: versionOf('@goodandready/dsh-smart-restart', '0.1.1'),
        })
        writeJson('last-report.json', { at: new Date().toISOString(), verdict: composed.verdict, report, checks: composed.checks })
        const sessionId = targetSession(state)
        if (sessionId) deliverWithWait(sessionId, report)
        else deliverWithWait('', report)
        // The intent has been handed back; keep it only as a record.
        if (state.present) rmSync(pathOf('intent.json'), { force: true })
        ctx.logger?.info?.(`[smart-restart-guard] boot check: ${composed.verdict}`)
      } catch (err) {
        ctx.logger?.warn?.('[smart-restart-guard] boot check failed:', err && err.message)
      }
    }, 1500)
  }

  // ------------------------------------------------------------------ tools

  const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true }

  const disposers = []

  function tool(toolName, description, parameters, execute) {
    const definition = defineTool({
      name: toolName,
      description,
      parameters,
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
      },
      execute,
    })
    try {
      const reg = ctx.tools.register(definition)
      if (typeof reg === 'function') disposers.push(reg)
      else if (reg && typeof reg.dispose === 'function') disposers.push(() => reg.dispose())
      return reg
    } catch (err) {
      if (!/is already registered/.test(String((err && err.message) || err))) throw err
      ctx.logger?.warn?.(`[smart-restart-guard] tool "${toolName}" is already provided by another plugin; skipping it`)
      return null
    }
  }

  function callerSession(execution) {
    try {
      if (execution && typeof execution.sessionId === 'string' && execution.sessionId) return execution.sessionId
      const agent = execution && execution.agent
      if (typeof agent === 'string') return agent
      if (agent && agent.session && typeof agent.session === 'string') return agent.session
      if (agent && agent.id) return String(agent.id)
    } catch {
      // fall through
    }
    return ''
  }

  if (live().toolEnabled !== false) {
    tool(
      'dsh_restart_status',
      'Read-only view of the restart guard: the last boot and its downtime, the last health report, a pending intent (what to continue after a restart), and how many restarts happened inside the window.',
      {},
      async () => cleanPayload({
        enabled: live().enabled !== false,
        mode: live().restartMode,
        unit: unitName(),
        unitSource: live().unit ? 'settings' : 'detected from /proc/self/cgroup',
        lastBoot: readJson('marker.json'),
        previousBoot: previousMarker,
        lastReport: readJson('last-report.json'),
        pendingIntent: readJson('intent.json'),
        restartsInWindow: loopGuard(readJson('history.json') || [], { max: live().maxRestarts, windowMs: live().windowMs }),
      }),
    )

    tool(
      'dsh_restart',
      'Restart the harness and have it verified: the guard records why and what to continue, ends the process (systemd brings the service back, no privileges needed) or runs systemctl restart, and after the boot sends this session a health report with the verdict and the intent.',
      {
        reason: { type: 'string', description: 'Why the restart is needed; it is recorded and shown in the report.' },
        resume: { type: 'string', description: 'What to continue after the boot; it comes back in the report.' },
        delayMs: { type: 'number', description: 'How long to wait before the process ends (default from settings).' },
        confirm: { type: 'boolean', description: 'Must be true: the restart ends this process.' },
      },
      async (args, execution) => {
        if (args.confirm !== true) return cleanPayload({ ok: false, error: 'refusing to restart without confirm: true' })
        if (live().enabled === false) return cleanPayload({ ok: false, error: 'the restart guard is disabled in settings' })
        const guard = loopGuard(readJson('history.json') || [], { max: live().maxRestarts, windowMs: live().windowMs })
        if (!guard.allowed) {
          return cleanPayload({
            ok: false,
            error: `refusing: ${guard.count} restart(s) inside the window (${Math.round(guard.windowMs / 60000)} min) — fix the cause first`,
            restartsInWindow: guard,
          })
        }
        const unit = unitName()
        const mode = live().restartMode === 'systemctl' ? 'systemctl' : 'kill'
        if (mode === 'systemctl' && !unit) return cleanPayload({ ok: false, error: 'no systemd unit: set unit in the settings or use restartMode "kill"' })
        const delay = Math.max(500, Number(args.delayMs) || live().delayMs || 3000)
        const sessionId = callerSession(execution)
        writeJson('intent.json', {
          at: new Date().toISOString(),
          sessionId,
          reason: String(args.reason || ''),
          resume: String(args.resume || ''),
          mode,
          unit,
          delayMs: delay,
        })
        safeSetTimeout(() => {
          try {
            if (mode === 'systemctl') {
              let cgroupText = ''
              try {
                cgroupText = readFileSync('/proc/self/cgroup', 'utf8')
              } catch {
                cgroupText = ''
              }
              const scope = unitScopeFromCgroup(cgroupText)
              const restartArgs = systemctlRestartArgs(unit, scope)
              // Detached on purpose: it must outlive the process it restarts.
              const child = execFile('systemctl', restartArgs, { detached: true })
              child.unref?.()
            } else {
              // The process ends; systemd starts it again because Restart=always.
              process.kill(process.pid, 'SIGTERM')
            }
          } catch (err) {
            ctx.logger?.warn?.('[smart-restart-guard] restart failed:', err && err.message)
          }
        }, delay)
        return cleanPayload({
          ok: true,
          restarting: true,
          mode,
          unit: unit || '(none)',
          delayMs: delay,
          sessionId,
          note: 'the report will come back to this session after the boot',
        })
      },
    )
  }

  const cleanup = () => {
    clearAllTimers()
    for (const d of disposers) {
      try {
        d()
      } catch (err) {
        ctx.logger?.warn?.('[smart-restart-guard] disposer error:', err && err.message)
      }
    }
    disposers.length = 0
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => cleanup)
  }

  return cleanup
}

export const inject = ['tools', 'agents', 'settings']
