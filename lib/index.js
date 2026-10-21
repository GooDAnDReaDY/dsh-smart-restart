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
import { isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

import {
  buildReport,
  clampDelayMs,
  composeChecks,
  countActiveAgents,
  detectRestart,
  diffPackages,
  drainActiveAgents,
  formatPackageDiff,
  formatPreflightFailureReport,
  intentState,
  loopGuard,
  ownerBelongsToUnit,
  parseCgroupUnit,
  parseListenPortsForPid,
  readBoot,
  resolveSafeStateDir,
  systemctlRestartArgs,
  unitScopeFromCgroup,
  validateRestartPreflight,
} from './boot.js'

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
  drainTimeoutMs: Schema.number().default(15000)
    .volatile().description('How long in milliseconds to wait for active agent turns to finish before restarting.'),
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
  requireApproval: Schema.boolean().default(true)
    .volatile().description('Require human operator approval through host approval seam before executing harness restart.'),
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
    validatedConfig = plainConfig(Config(plainConfig(rawConfig || {})))
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
      try {
        fn()
      } catch (err) {
        ctx.logger?.warn?.('[smart-restart-guard] timer callback failed:', err && err.message)
      }
    }, ms)
    activeTimers.add(timerId)
    return timerId
  }
  const clearTimer = (timerId) => {
    if (timerId) {
      clearTimeout(timerId)
      activeTimers.delete(timerId)
    }
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
  const stateDir = () => {
    const raw = live().stateDir
    const safe = resolveSafeStateDir(raw, home())
    if (raw && !isAbsolute(raw)) {
      const target = resolve(home(), raw)
      const rel = relative(home(), target)
      if (rel.startsWith('..') || isAbsolute(rel)) {
        ctx.logger?.warn?.(`[smart-restart-guard] stateDir "${raw}" escapes DSH_HOME via path traversal; falling back to default`)
      }
    }
    return safe
  }
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

  function readInstalledPackages() {
    const candidatePaths = [
      join(home(), 'profiles/web/package.json'),
      join(home(), 'package.json'),
      join(process.cwd(), 'package.json'),
    ]
    for (const p of candidatePaths) {
      try {
        const data = JSON.parse(readFileSync(p, 'utf8'))
        const deps = { ...(data.dependencies || {}), ...(data.devDependencies || {}) }
        if (Object.keys(deps).length > 0) return deps
      } catch {
        // try next
      }
    }
    return {}
  }

  /** The unit this process runs under, read from our own cgroup. */
  function detectUnit() {
    try {
      return parseCgroupUnit(readFileSync('/proc/self/cgroup', 'utf8'))
    } catch {
      return ''
    }
  }

  function resolveSafeUnit() {
    const detected = detectUnit()
    const configured = typeof live().unit === 'string' ? live().unit.trim() : ''
    if (!configured) return detected
    if (!/^[A-Za-z0-9@_.-]+\.service$/.test(configured)) {
      ctx.logger?.warn?.(`[smart-restart-guard] configured unit "${configured}" is not a valid systemd service name; using detected unit "${detected}"`)
      return detected
    }
    if (detected && configured !== detected) {
      ctx.logger?.warn?.(`[smart-restart-guard] configured unit "${configured}" does not match detected unit "${detected}"; refusing arbitrary unit restart and using detected unit`)
      return detected
    }
    return configured
  }

  const unitName = () => resolveSafeUnit()

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
    let timerId = null
    try {
      const timeoutPromise = new Promise((_resolve, reject) => {
        timerId = safeSetTimeout(() => reject(new Error('timed out')), live().timeoutMs || 5000)
      })
      const value = await Promise.race([fn(), timeoutPromise])
      return value || { name, ok: true, detail: 'ok' }
    } catch (err) {
      return { name, ok: false, detail: String((err && err.message) || err) }
    } finally {
      if (timerId) clearTimer(timerId)
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

  // ------------------------------------------------------------------ preflight & drain

  function getAgents() {
    try {
      if (typeof ctx.agents?.list === 'function') return ctx.agents.list()
      if (typeof ctx.agents?.roots === 'function') return ctx.agents.roots()
    } catch {
      // ignore
    }
    return []
  }

  async function runPreflight(targetUnit, mode) {
    const configFiles = []
    const candidatePaths = [
      join(home(), 'cordis.patch.yml'),
      join(home(), 'cordis.yml'),
      join(home(), 'package.json'),
      join(process.cwd(), 'cordis.patch.yml'),
      join(process.cwd(), 'cordis.yml'),
      join(process.cwd(), 'package.json'),
    ]
    const seen = new Set()
    for (const p of candidatePaths) {
      if (seen.has(p)) continue
      seen.add(p)
      try {
        const content = readFileSync(p, 'utf8')
        configFiles.push({ path: p, content })
      } catch {
        // file not present or not readable; skipped in validator
      }
    }
    let portVerdict = null
    try {
      portVerdict = await checkPort()
    } catch {
      portVerdict = null
    }
    return validateRestartPreflight({
      configFiles,
      unit: targetUnit,
      restartMode: mode,
      portOwnerVerdict: portVerdict,
    })
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

  function resolveAgent(sessionId) {
    if (sessionId) {
      try {
        const found = ctx.agents?.get?.(SessionId(sessionId))
        if (found) return found
      } catch (err) {
        ctx.logger?.warn?.('[smart-restart-guard] resolveAgent get failed:', err && err.message)
      }
    }
    try {
      if (typeof ctx.agents?.roots === 'function') {
        const root = ctx.agents.roots()[0]
        if (root) return root
      }
      if (typeof ctx.agents?.list === 'function') {
        const first = ctx.agents.list()[0]
        if (first) return first
      }
    } catch (err) {
      ctx.logger?.warn?.('[smart-restart-guard] resolveAgent roots/list failed:', err && err.message)
    }
    return null
  }

  function deliverTo(sessionId, text) {
    try {
      const message = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: name, form: 'notice', summary: text.split('\n')[0] },
      })
      const agent = resolveAgent(sessionId)
      if (agent && typeof agent.followup === 'function') {
        agent.followup(message)
        return true
      }
    } catch (err) {
      ctx.logger?.warn?.('[smart-restart-guard] deliverTo error:', err && err.message)
    }
    return false
  }

  /** The session that asked may come up late; wait for it, but not forever. */
  function deliverWithWait(sessionId, text, attempts = 30) {
    let left = attempts
    const tick = () => {
      try {
        if (deliverTo(sessionId, text)) return
        left -= 1
        if (left > 0) safeSetTimeout(tick, 1000)
        else ctx.logger?.warn?.('[smart-restart-guard] could not deliver the report; no live session for', sessionId || '(primary)')
      } catch (err) {
        ctx.logger?.warn?.('[smart-restart-guard] deliverWithWait tick error:', err && err.message)
      }
    }
    tick()
  }

  // ------------------------------------------------------------------ boot

  const previousMarker = readJson('marker.json')
  const boot = detectRestart(previousMarker)
  const intent = readJson('intent.json')
  const history = readJson('history.json') || []
  const currentBoot = readBoot(Date.now(), {
    pluginVersion: versionOf('@goodandready/dsh-smart-restart', '0.1.1'),
    dshVersion: versionOf('@deepseek-ai/dsh', ''),
    packages: readInstalledPackages(),
  })
  writeJson('marker.json', currentBoot)
  if (boot.wasRestart) {
    writeJson('history.json', [...(Array.isArray(history) ? history : []), Date.now()].slice(-50))
  }

  if (boot.wasRestart && live().enabled !== false) {
    const state = intentState(intent)
    // Give the composition a moment to settle before judging it.
    safeSetTimeout(async () => {
      try {
        const composed = await healthCheck()
        const diff = diffPackages(previousMarker?.packages, currentBoot.packages)
        const diffFormatted = formatPackageDiff(diff)
        const report = buildReport({
          bootAt: new Date().toISOString(),
          downtimeMs: boot.downtimeMs,
          pid: process.pid,
          checks: composed.checks,
          resume: state.present && !state.stale ? state.resume : state.present ? `${state.resume} (recorded at ${intent.at}, may be stale)` : '',
          reason: state.present ? state.reason : '',
          context: state.present && !state.stale ? state.context : null,
          diff: diffFormatted,
          previousVersion: previousMarker?.pluginVersion || '',
          version: versionOf('@goodandready/dsh-smart-restart', '0.1.1'),
        })
        writeJson('last-report.json', {
          at: new Date().toISOString(),
          verdict: composed.verdict,
          report,
          checks: composed.checks,
          context: (state.present && !state.stale && state.context) ? state.context : undefined,
          diff: diff.hasChanges ? diff : undefined,
        })
        const sessionId = targetSession(state)
        if (sessionId) deliverWithWait(sessionId, report)
        else deliverWithWait('', report)

        // The intent has been handed back; keep it only as a record.
        if (state.present || intent) {
          try {
            rmSync(pathOf('intent.json'), { force: true })
          } catch (err) {
            ctx.logger?.warn?.('[smart-restart-guard] failed to remove intent.json:', err && err.message)
          }
        }
        ctx.logger?.info?.(`[smart-restart-guard] boot check: ${composed.verdict}`)
      } catch (err) {
        ctx.logger?.warn?.('[smart-restart-guard] boot check failed:', err && err.message)
      }
    }, 1500)
  }

  // Pre-dispatch gate for host approval (#36)
  if (typeof ctx.on === 'function') {
    ctx.effect(() => {
      const off = ctx.on('tools/pre-execute', async (exec, next) => {
        if (exec && exec.name === 'dsh_restart' && live().requireApproval !== false) {
          const reason = (exec.arguments && exec.arguments.reason) || 'DeepSeek Harness restart requested'
          return {
            kind: 'ask',
            reason: `DeepSeek Harness restart: ${reason}`,
          }
        }
        return typeof next === 'function' ? next() : { kind: 'allow' }
      }, { prepend: true })
      return () => {
        try {
          if (typeof off === 'function') off()
          else if (off && typeof off.dispose === 'function') off.dispose()
        } catch (err) { ctx.logger?.debug?.('[smart-restart-guard] dispose pre-execute failed:', err && err.message) }
      }
    })
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

  let activeRestart = null

  function performRestart(mode = live().restartMode, unit = unitName()) {
    try {
      if (mode === 'systemctl') {
        let cgroupText = ''
        try {
          cgroupText = readFileSync('/proc/self/cgroup', 'utf8')
        } catch {
          // ignore
        }
        const scope = unitScopeFromCgroup(cgroupText)
        const restartArgs = systemctlRestartArgs(unit, scope, { allowedUnit: detectUnit() || unit })
        if (!restartArgs.length) {
          ctx.logger?.warn?.(`[smart-restart-guard] refusing systemctl restart: invalid or unapproved unit "${unit}"`)
          return
        }
        const child = execFile('systemctl', restartArgs, { detached: true })
        child.unref?.()
      } else {
        process.kill(process.pid, 'SIGTERM')
      }
    } catch (err) {
      ctx.logger?.warn?.('[smart-restart-guard] restart failed:', err && err.message)
    }
  }

  function cancelPendingRestart(source = 'manual') {
    if (!activeRestart) {
      return { ok: true, cancelled: false, message: 'No restart is currently pending.' }
    }
    if (activeRestart.timeoutId) {
      clearTimeout(activeRestart.timeoutId)
      activeTimers.delete(activeRestart.timeoutId)
    }
    const cancelledRecord = { ...activeRestart }
    activeRestart = null
    try {
      rmSync(pathOf('intent.json'), { force: true })
    } catch (err) {
      ctx.logger?.warn?.('[smart-restart-guard] failed to remove intent.json on cancel:', err && err.message)
    }
    if (cancelledRecord.sessionId) {
      deliverTo(cancelledRecord.sessionId, `smart-restart: pending restart scheduled for ${new Date(cancelledRecord.at).toISOString()} was cancelled (${source}).`)
    }
    ctx.logger?.info?.(`[smart-restart-guard] pending restart cancelled (${source})`)
    return {
      ok: true,
      cancelled: true,
      message: `Pending restart scheduled for ${new Date(cancelledRecord.at).toISOString()} was successfully cancelled.`,
      cancelledRecord: {
        scheduledAt: cancelledRecord.scheduledAt,
        at: cancelledRecord.at,
        delayMs: cancelledRecord.delayMs,
        reason: cancelledRecord.reason,
      },
    }
  }

  if (live().toolEnabled !== false) {
    tool(
      'dsh_restart_status',
      'Read-only view of the restart guard: the last boot and its downtime, the last health report, a pending intent (what to continue after a restart), diff of installed packages, pending scheduled restart, and how many restarts happened inside the window.',
      {},
      async () => cleanPayload({
        enabled: live().enabled !== false,
        mode: live().restartMode,
        unit: unitName(),
        unitSource: live().unit ? 'settings' : 'detected from /proc/self/cgroup',
        lastBoot: readJson('marker.json'),
        previousBoot: previousMarker,
        lastReport: readJson('last-report.json'),
        lastDiff: readJson('last-report.json')?.diff || null,
        pendingIntent: readJson('intent.json'),
        scheduled: activeRestart ? {
          scheduledAt: activeRestart.scheduledAt,
          at: activeRestart.at,
          delayMs: activeRestart.delayMs,
          remainingMs: Math.max(0, activeRestart.at - Date.now()),
          reason: activeRestart.reason,
        } : null,
        restartsInWindow: loopGuard(readJson('history.json') || [], { max: live().maxRestarts, windowMs: live().windowMs }),
      }),
    )

    tool(
      'dsh_restart_cancel',
      'Cancel a pending scheduled restart before its delay expires. Clears the timer, deletes intent.json, and prevents the harness from restarting.',
      {},
      async () => cleanPayload(cancelPendingRestart('agent-tool')),
    )

    tool(
      'dsh_restart',
      'Restart the harness and have it verified: the guard records why and what to continue, ends the process (systemd brings the service back, no privileges needed) or runs systemctl restart, and after the boot sends this session a health report with the verdict, package diff, and the context.',
      {
        reason: { type: 'string', description: 'Why the restart is needed; it is recorded and shown in the report.' },
        resume: { type: 'string', description: 'What to continue after the boot; it comes back in the report.' },
        context: {
          type: 'object',
          description: 'Structured situational context for resuming work after restart (cwd, branch, worktree, files, tasks, memoryTag).',
          additionalProperties: true,
        },
        delayMs: { type: 'number', description: 'How long to wait before the process ends (default from settings).' },
        confirm: { type: 'boolean', description: 'Must be true: the restart ends this process.' },
        dryRun: { type: 'boolean', description: 'Run preflight validation checks without initiating restart.' },
      },
      async (args, execution) => {
        if (args.confirm !== true && args.dryRun !== true) return cleanPayload({ ok: false, error: 'refusing to restart without confirm: true' })
        if (live().enabled === false) return cleanPayload({ ok: false, error: 'the restart guard is disabled in settings' })
        if (!args.dryRun && live().requireApproval !== false && !execution?.approved) {
          const approval = (typeof ctx.get === 'function' ? ctx.get('approval') : null) || ctx.approval
          if (approval && typeof approval.request === 'function') {
            const outcome = await approval.request({
              agent: execution?.agent,
              toolName: 'dsh_restart',
              callId: execution?.callId,
              reason: args.reason || 'DeepSeek Harness restart requested',
              signal: execution?.signal,
            })
            if (outcome !== 'allowed-once') {
              return cleanPayload({
                ok: false,
                error: `restart was rejected or cancelled by operator (outcome: ${outcome || 'denied'})`,
              })
            }
          }
        }
        if (!args.dryRun) {
          const guard = loopGuard(readJson('history.json') || [], { max: live().maxRestarts, windowMs: live().windowMs })
          if (!guard.allowed) {
            return cleanPayload({
              ok: false,
              error: `refusing: ${guard.count} restart(s) inside the window (${Math.round(guard.windowMs / 60000)} min) — fix the cause first`,
              restartsInWindow: guard,
            })
          }
        }
        const unit = unitName()
        const mode = live().restartMode === 'systemctl' ? 'systemctl' : 'kill'
        if (mode === 'systemctl' && !unit) return cleanPayload({ ok: false, error: 'no systemd unit: set unit in the settings or use restartMode "kill"' })

        const sessionId = callerSession(execution)

        // Preflight validation (#38)
        const preflight = await runPreflight(unit, mode)
        if (!preflight.ok) {
          const failureMsg = formatPreflightFailureReport(preflight)
          if (sessionId) deliverTo(sessionId, failureMsg)
          return cleanPayload({
            ok: false,
            error: `preflight validation failed: ${preflight.error}`,
            preflight,
          })
        }

        if (args.dryRun === true) {
          return cleanPayload({
            ok: true,
            dryRun: true,
            preflight,
            note: 'preflight validation passed; restart simulated',
          })
        }

        // Graceful drain of active agent tasks (#39)
        const drain = await drainActiveAgents(
          getAgents,
          sessionId,
          live().drainTimeoutMs ?? 15000,
          250,
        )
        if (!drain.drained) {
          ctx.logger?.warn?.(`[smart-restart-guard] drain timed out with ${drain.activeCount} active agent(s) remaining after ${drain.waitedMs}ms; proceeding with restart`)
        }

        // Rich Situational Snapshot (#40)
        let context = null
        if (args.context && typeof args.context === 'object') {
          context = cleanPayload(args.context)
          if (!context.cwd && typeof process.cwd === 'function') {
            try {
              context.cwd = process.cwd()
            } catch {
              // best effort fallback
            }
          }
        }

        const delay = clampDelayMs(args.delayMs || live().delayMs, 3000)
        writeJson('intent.json', {
          at: new Date().toISOString(),
          sessionId,
          reason: String(args.reason || ''),
          resume: String(args.resume || ''),
          context: context || undefined,
          mode,
          unit,
          delayMs: delay,
          drain: {
            drained: drain.drained,
            waitedMs: drain.waitedMs,
            activeCount: drain.activeCount,
          },
        })
        const scheduledRecord = {
          scheduledAt: Date.now(),
          at: Date.now() + delay,
          delayMs: delay,
          reason: String(args.reason || ''),
          sessionId,
          mode,
          unit,
          timeoutId: null,
        }

        const timer = setTimeout(() => {
          activeTimers.delete(timer)
          activeRestart = null
          performRestart(mode, unit)
        }, delay)
        activeTimers.add(timer)
        scheduledRecord.timeoutId = timer
        activeRestart = scheduledRecord
        return cleanPayload({
          ok: true,
          restarting: true,
          mode,
          unit: unit || '(none)',
          delayMs: delay,
          sessionId,
          context: context || undefined,
          preflight: { verdict: 'passed' },
          drain: {
            drained: drain.drained,
            waitedMs: drain.waitedMs,
          },
          note: 'the report will come back to this session after the boot',
        })
      },
    )
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (sctx) => {
      const server = sctx.get ? (sctx.get('webServer') ?? sctx.webServer) : sctx.webServer
      if (!server || typeof server.register !== 'function') return

      function writeJsonResponse(res, statusCode, body) {
        if (typeof res.setHeader === 'function') res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.statusCode = statusCode
        res.end(JSON.stringify(body))
      }

      function readRequestBody(req) {
        return new Promise((resolve, reject) => {
          let val = ''
          req.on('data', (chunk) => { val += chunk })
          req.on('end', () => {
            try {
              resolve(val ? JSON.parse(val) : {})
            } catch (err) {
              reject(err)
            }
          })
          req.on('error', reject)
        })
      }

      function isTrustedRequest(req) {
        if (!req || !req.headers) return true
        const site = req.headers['sec-fetch-site']
        if (site !== undefined && site && site !== 'same-origin' && site !== 'none') return false
        const host = req.headers.host || ''
        const origin = req.headers.origin
        if (origin) {
          try {
            const parsed = new URL(origin)
            if (parsed.host && host && parsed.host !== host) return false
          } catch {
            return false
          }
        }
        const remoteAddress = req?.socket?.remoteAddress || req?.connection?.remoteAddress || ''
        const isLoopback = remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1' || remoteAddress.startsWith('127.')
        if (remoteAddress && !isLoopback && !origin) return false
        return true
      }

      const regGet = server.register({
        kind: 'exact',
        path: '/dsh-smart-restart/status',
        handler: async (req, res) => {
          if (req.method !== 'GET') return writeJsonResponse(res, 405, { ok: false, error: 'GET only' })
          const lastReport = readJson('last-report.json')
          const history = (readJson('history.json') || []).slice(-10)
          const guard = loopGuard(readJson('history.json') || [], { max: live().maxRestarts, windowMs: live().windowMs })
          const status = cleanPayload({
            enabled: live().enabled !== false,
            mode: live().restartMode,
            unit: unitName(),
            unitSource: live().unit ? 'settings' : 'detected from /proc/self/cgroup',
            verdict: guard.allowed === false ? 'loop-guard' : (lastReport?.verdict || 'ok'),
            checks: lastReport?.checks || [],
            lastBoot: readJson('marker.json'),
            lastReport,
            lastDiff: lastReport?.diff || null,
            history,
            scheduled: activeRestart ? {
              scheduledAt: activeRestart.scheduledAt,
              at: activeRestart.at,
              delayMs: activeRestart.delayMs,
              remainingMs: Math.max(0, activeRestart.at - Date.now()),
              reason: activeRestart.reason,
            } : null,
            restartsInWindow: guard,
          })
          return writeJsonResponse(res, 200, { ok: true, status })
        },
      })
      if (typeof regGet === 'function') disposers.push(regGet)

      const regRestart = server.register({
        kind: 'exact',
        path: '/dsh-smart-restart/restart',
        handler: async (req, res) => {
          if (req.method !== 'POST') return writeJsonResponse(res, 405, { ok: false, error: 'POST only' })
          if (!isTrustedRequest(req)) return writeJsonResponse(res, 403, { ok: false, error: 'Forbidden' })
          const body = await readRequestBody(req).catch(() => ({}))
          const unit = unitName()
          const mode = live().restartMode || 'kill'
          const delay = clampDelayMs(typeof body.delayMs === 'number' ? body.delayMs : 5000, 3000)
          const reason = typeof body.reason === 'string' ? body.reason.trim() : 'Safe restart requested from WebUI'

          const preflight = await runPreflight(unit, mode)
          if (!preflight.ok) {
            return writeJsonResponse(res, 400, { ok: false, error: `preflight validation failed: ${preflight.error}`, preflight })
          }
          if (body.dryRun === true) {
            return writeJsonResponse(res, 200, { ok: true, dryRun: true, preflight, note: 'preflight passed; restart simulated' })
          }

          if (activeRestart) {
            cancelPendingRestart('rescheduled-by-webui')
          }

          writeJson('intent.json', {
            at: new Date().toISOString(),
            reason,
            resume: 'resumed after WebUI safe restart',
            source: 'webui',
            mode,
            unit,
            delayMs: delay,
          })

          const scheduledRecord = {
            scheduledAt: Date.now(),
            at: Date.now() + delay,
            delayMs: delay,
            reason,
            mode,
            unit,
            sessionId: '',
            timeoutId: null,
          }

          const timer = setTimeout(() => {
            activeTimers.delete(timer)
            activeRestart = null
            performRestart(mode, unit)
          }, delay)
          activeTimers.add(timer)
          scheduledRecord.timeoutId = timer
          activeRestart = scheduledRecord

          return writeJsonResponse(res, 200, {
            ok: true,
            scheduled: true,
            at: scheduledRecord.at,
            delayMs: delay,
            reason,
            preflight,
          })
        },
      })
      if (typeof regRestart === 'function') disposers.push(regRestart)

      const regCancel = server.register({
        kind: 'exact',
        path: '/dsh-smart-restart/cancel',
        handler: async (req, res) => {
          if (req.method !== 'POST') return writeJsonResponse(res, 405, { ok: false, error: 'POST only' })
          if (!isTrustedRequest(req)) return writeJsonResponse(res, 403, { ok: false, error: 'Forbidden' })
          const result = cancelPendingRestart('webui-cancel')
          return writeJsonResponse(res, 200, result)
        },
      })
      if (typeof regCancel === 'function') disposers.push(regCancel)
    })
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
