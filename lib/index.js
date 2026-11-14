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
import { isAbsolute, join, relative, resolve } from 'node:path'

import Schema from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

import {
  buildReport,
  clampDelayMs,
  detectRestart,
  diffPackages,
  drainActiveAgents,
  formatPackageDiff,
  formatPreflightFailureReport,
  intentState,
  loopGuard,
  readBoot,
  resolveSafeStateDir,
  systemctlRestartArgs,
  unitScopeFromCgroup,
} from './boot.js'
import { registerChatCommand, safeGet } from './chat-command.js'
import {
  createHealthChecker,
  detectUnit,
  listenPortsForOurUnit,
  readInstalledPackages,
  resolveSafeUnit,
  versionOf,
} from './health.js'
import { registerRoutes } from './routes.js'
import { registerTools } from './tools.js'
import { executeChatRestartPipeline } from './pipeline.js'

export const name = 'dsh-smart-restart'

/**
 * Producer-owned message source for everything this plugin injects/delivers.
 *
 * DSH session format v4 (`dsh >= 0.1.7-alpha.1`) retired the catch-all
 * `{ kind: 'plugin', plugin: '…' }` source: v4 admission rejects it outright
 * (`format v4 message requires a producer-owned source kind`) across every
 * durable message slot, including `agent/inbox/spliced`.
 */
export const PRODUCER_SOURCE_KIND = `plugin:${name}`
export const RETIRED_PLUGIN_KIND = 'plugin'

// The settings namespace is the profile entry id from cordis.patch.yml, not the
// package name. DSH keys a served form by entry id, so a package-name namespace
// resolves to nothing. Must match NS in lib/client.js.
export const NS = 'goodandready-smart-restart'

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
  const logger = {
    warn: (...args) => {
      try {
        const l = safeGet(ctx, 'logger')
        if (typeof l?.warn === 'function') l.warn(...args)
      } catch (err) {
        void err
      }
    },
    info: (...args) => {
      try {
        const l = safeGet(ctx, 'logger')
        if (typeof l?.info === 'function') l.info(...args)
      } catch (err) {
        void err
      }
    },
    debug: (...args) => {
      try {
        const l = safeGet(ctx, 'logger')
        if (typeof l?.debug === 'function') l.debug(...args)
      } catch (err) {
        void err
      }
    },
  }
  let validatedConfig = {}
  try {
    validatedConfig = plainConfig(Config(plainConfig(rawConfig || {})))
  } catch (err) {
    logger.warn?.('[smart-restart-guard] invalid config provided, using defaults:', err && err.message)
    validatedConfig = plainConfig(Config({}))
  }
  const entryConfig = rawConfig || {}
  const live = () => plainConfig(entryConfig)

  if (typeof ctx.on === 'function') {
    try {
      ctx.on('loader/volatile-update', () => {
        void live()
      })
    } catch (err) {
      logger.warn?.('[smart-restart-guard] volatile-update subscription failed:', err && err.message)
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
        logger.warn?.('[smart-restart-guard] timer callback failed:', err && err.message)
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
        logger.warn?.(`[smart-restart-guard] stateDir "${raw}" escapes DSH_HOME via path traversal; falling back to default`)
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
      const clean = JSON.parse(JSON.stringify(value))
      writeFileSync(pathOf(file), `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600 })
      return true
    } catch (err) {
      logger.warn?.('[smart-restart-guard] cannot write', file, err && err.message)
      return false
    }
  }

  const unitName = () => resolveSafeUnit(live().unit, logger)

  // ------------------------------------------------------------------ health checks & preflight

  const healthChecker = createHealthChecker({
    ctx,
    live,
    unitName,
    safeSetTimeout,
    clearTimer,
    versionOfFn: versionOf,
    readJson,
    homeDir: home,
  })
  const { healthCheck, runPreflight } = healthChecker

  // ------------------------------------------------------------------ delivery

  function cleanPayload(value) {
    try {
      return JSON.parse(JSON.stringify(value))
    } catch {
      return {}
    }
  }

  function getAgents() {
    try {
      if (typeof ctx.agents?.list === 'function') return ctx.agents.list()
      if (typeof ctx.agents?.roots === 'function') return ctx.agents.roots()
    } catch {
      // ignore
    }
    return []
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
        logger.warn?.('[smart-restart-guard] resolveAgent get failed:', err && err.message)
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
      logger.warn?.('[smart-restart-guard] resolveAgent roots/list failed:', err && err.message)
    }
    return null
  }

  function deliverTo(sessionId, text) {
    try {
      const source = { kind: PRODUCER_SOURCE_KIND, form: 'notice', summary: text.split('\n')[0] }
      // Guard against regression to the retired kind: format v4 admission strictly rejects it (#51, #56)
      if (source.kind === RETIRED_PLUGIN_KIND) {
        throw new Error(`Cannot deliver with retired source kind "${RETIRED_PLUGIN_KIND}"`)
      }
      const message = createUserMessage({
        content: [{ type: 'text', text }],
        source,
      })
      const agent = resolveAgent(sessionId)
      if (agent && typeof agent.followup === 'function') {
        agent.followup(message)
        return true
      }
    } catch (err) {
      logger.warn?.('[smart-restart-guard] deliverTo error:', err && err.message)
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
        else logger.warn?.('[smart-restart-guard] could not deliver the report; no live session for', sessionId || '(primary)')
      } catch (err) {
        logger.warn?.('[smart-restart-guard] deliverWithWait tick error:', err && err.message)
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
    packages: readInstalledPackages(home()),
  })
  writeJson('marker.json', currentBoot)
  if (boot.wasRestart) {
    writeJson('history.json', [...(Array.isArray(history) ? history : []), Date.now()].slice(-50))
  }

  if (boot.wasRestart && live().enabled !== false) {
    const state = intentState(intent)
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

        if (state.present || intent) {
          try {
            rmSync(pathOf('intent.json'), { force: true })
          } catch (err) {
            logger.warn?.('[smart-restart-guard] failed to remove intent.json:', err && err.message)
          }
        }
        logger.info?.(`[smart-restart-guard] boot check: ${composed.verdict}`)
      } catch (err) {
        logger.warn?.('[smart-restart-guard] boot check failed:', err && err.message)
      }
    }, 1500)
  }

  // Pre-dispatch gate for host approval (#36)
  if (typeof ctx.on === 'function') {
    ctx.effect?.(() => {
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
        } catch (err) { logger.debug?.('[smart-restart-guard] dispose pre-execute failed:', err && err.message) }
      }
    })
  }

  // ------------------------------------------------------------------ state & lifecycle

  const disposers = []

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
  const getActiveRestart = () => activeRestart
  const setActiveRestart = (val) => { activeRestart = val }

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
          logger.warn?.(`[smart-restart-guard] refusing systemctl restart: invalid or unapproved unit "${unit}"`)
          return
        }
        const child = execFile('systemctl', restartArgs, { detached: true })
        child.unref?.()
      } else {
        process.kill(process.pid, 'SIGTERM')
      }
    } catch (err) {
      logger.warn?.('[smart-restart-guard] restart failed:', err && err.message)
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
      logger.warn?.('[smart-restart-guard] failed to remove intent.json on cancel:', err && err.message)
    }
    if (cancelledRecord.sessionId) {
      deliverTo(cancelledRecord.sessionId, `smart-restart: pending restart scheduled for ${new Date(cancelledRecord.at).toISOString()} was cancelled (${source}).`)
    }
    logger.info?.(`[smart-restart-guard] pending restart cancelled (${source})`)
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

  // ------------------------------------------------------------------ register modules

  registerTools(ctx, {
    live,
    cleanPayload,
    readJson,
    writeJson,
    unitName,
    previousMarker,
    getActiveRestart,
    setActiveRestart,
    loopGuard,
    cancelPendingRestart,
    callerSession,
    runPreflight,
    formatPreflightFailureReport,
    deliverTo,
    drainActiveAgents,
    getAgents,
    clampDelayMs,
    performRestart,
    activeTimers,
    safeGet,
    logger,
    disposers,
  })

  registerRoutes(ctx, {
    live,
    unitName,
    readJson,
    writeJson,
    cleanPayload,
    loopGuard,
    getActiveRestart,
    setActiveRestart,
    cancelPendingRestart,
    runPreflight,
    clampDelayMs,
    performRestart,
    activeTimers,
    disposers,
  })

  // Chat command /restart & middleware interceptor (#44)
  async function collectChecks(unit, mode) {
    const res = await healthCheck()
    return res.checks || []
  }

  const chatDisposer = registerChatCommand(ctx, {
    executeRestartPipeline: (options) => executeChatRestartPipeline(options, {
      live,
      unitName,
      runPreflight,
      formatPreflightFailureReport,
      loopGuard,
      readJson,
      writeJson,
      drainActiveAgents,
      getAgents,
      logger,
      cancelPendingRestart,
      clampDelayMs,
      activeTimers,
      setActiveRestart,
      performRestart,
    }),
    cancelPendingRestart,
    getRestartStatus: async () => {
      const mode = live().restartMode || 'kill'
      const unit = unitName()
      const checks = await collectChecks(unit, mode)
      const report = buildReport({ checks, intent: null })
      const guard = loopGuard(readJson('history.json') || [], { max: live().maxRestarts, windowMs: live().windowMs })
      const ports = listenPortsForOurUnit(unit)
      return {
        verdict: report.verdict,
        unit: unit || 'process',
        port: ports.length ? ports.join(', ') : 'unknown',
        guard,
        activeRestart: activeRestart ? {
          at: activeRestart.at,
          delayMs: activeRestart.delayMs,
          reason: activeRestart.reason,
        } : null,
      }
    },
    live,
  })
  if (typeof chatDisposer === 'function') disposers.push(chatDisposer)

  const cleanup = () => {
    clearAllTimers()
    for (const d of disposers) {
      try {
        d()
      } catch (err) {
        logger.warn?.('[smart-restart-guard] disposer error:', err && err.message)
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
