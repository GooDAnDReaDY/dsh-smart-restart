// Pure decisions of the restart guard: was this a restart, how long were we down, may we restart
// again, what do the checks add up to, and what does the report say.
//
// Nothing here touches the filesystem or spawns anything, so every rule can be tested without a
// harness, a service manager or a working copy.

import { isAbsolute, join, relative, resolve } from 'node:path'

/** Maximum 32-bit signed integer delay in ms to avoid setTimeout 1ms overflow clamping. */
export const MAX_DELAY_MS = 2147483647

/** Clamp delay in ms between 500 and 2^31 - 1 to prevent 32-bit setTimeout overflow. */
export function clampDelayMs(val, fallback = 3000) {
  const parsed = Number(val)
  if (parsed === Infinity || parsed > MAX_DELAY_MS) return MAX_DELAY_MS
  const base = Number.isFinite(parsed) && parsed > 0 ? parsed : (Number(fallback) || 3000)
  return Math.min(MAX_DELAY_MS, Math.max(500, Math.floor(base)))
}

/** Valid systemd service unit name format. */
export const UNIT_NAME_PATTERN = /^[A-Za-z0-9@_.-]+\.service$/

/**
 * Resolve state directory safely within baseHome to prevent path traversal (../)
 * while still permitting absolute paths provided explicitly by tests or system configuration.
 */
export function resolveSafeStateDir(custom, baseHome) {
  const root = resolve(baseHome || '/tmp')
  if (!custom || typeof custom !== 'string' || !custom.trim()) {
    return join(root, '.restart-guard')
  }
  const trimmed = custom.trim()
  if (isAbsolute(trimmed)) {
    return resolve(trimmed)
  }
  const resolved = resolve(root, trimmed)
  const rel = relative(root, resolved)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return join(root, '.restart-guard')
  }
  return resolved
}

/** How a boot marker looks. `pid` is the discriminator: a new process means a restart. */
export function readBoot(now = Date.now(), { dshVersion = '', pluginVersion = '', pid = (typeof process !== 'undefined' ? process.pid : 0) } = {}) {
  let resolvedDsh = dshVersion
  if (!resolvedDsh && typeof process !== 'undefined') {
    resolvedDsh = process.env?.DSH_VERSION || process.versions?.dsh || ''
  }
  return {
    pid,
    bootAt: new Date(now).toISOString(),
    pluginVersion: pluginVersion || '',
    dshVersion: resolvedDsh || '',
  }
}

/**
 * Compare the previous marker with this process.
 *
 * @returns {{wasRestart: boolean, firstBoot: boolean, downtimeMs: number|null, prevBootAt: string|null}}
 */
export function detectRestart(previous, currentPid = process.pid, now = Date.now()) {
  if (!previous || typeof previous !== 'object' || !previous.pid) {
    return { wasRestart: false, firstBoot: true, downtimeMs: null, prevBootAt: null }
  }
  if (Number(previous.pid) === Number(currentPid)) {
    return { wasRestart: false, firstBoot: false, downtimeMs: null, prevBootAt: previous.bootAt || null }
  }
  const prevMs = Date.parse(previous.bootAt || '')
  const downtimeMs = Number.isFinite(prevMs) ? Math.max(0, now - prevMs) : null
  return { wasRestart: true, firstBoot: false, downtimeMs, prevBootAt: previous.bootAt || null }
}

/**
 * May we restart again? A boot that keeps failing must not become an endless loop driven by an
 * agent, so the guard counts the restarts inside a window.
 */
export function loopGuard(history = [], { now = Date.now(), max = 3, windowMs = 600000 } = {}) {
  const stamps = (Array.isArray(history) ? history : [])
    .map((value) => (typeof value === 'number' ? value : Date.parse(value)))
    .filter((value) => Number.isFinite(value))
    .filter((value) => now - value < windowMs)
  return { allowed: stamps.length < max, count: stamps.length, max, windowMs, stamps }
}

/** The health verdict: every check carries its own state, so "ok" is never a guess. */
export function composeChecks(checks = []) {
  const list = (Array.isArray(checks) ? checks : []).filter(Boolean)
  const failed = list.filter((check) => check.ok !== true)
  const skipped = list.filter((check) => check.skipped === true)
  const verdict = failed.length === 0 ? 'ok' : 'degraded'
  return { verdict, checks: list, failed, skipped, count: list.length }
}

function line(check) {
  const mark = check.skipped ? '–' : check.ok ? 'ok' : 'FAIL'
  return `- ${mark} ${check.name}: ${check.detail || ''}`.trimEnd()
}

/** The message the session receives after a restart. Plain text on purpose: it is read, not parsed. */
export function buildReport({
  bootAt, downtimeMs, pid, checks, resume, reason, previousVersion, version,
} = {}) {
  const composed = composeChecks(checks)
  const down = Number.isFinite(downtimeMs) ? `${(downtimeMs / 1000).toFixed(1)}s` : 'unknown'
  const head = composed.verdict === 'ok'
    ? 'smart-restart: the harness restarted and the boot check passed.'
    : `smart-restart: the harness restarted but ${composed.failed.length} check(s) did not pass.`
  const lines = [
    head,
    `- boot: ${bootAt || new Date().toISOString()} (was down ${down}${pid ? `, pid ${pid}` : ''})`,
  ]
  if (reason) lines.push(`- reason recorded before the restart: ${reason}`)
  if (previousVersion && version && previousVersion !== version) {
    lines.push(`- version changed: ${previousVersion} -> ${version}`)
  }
  for (const check of composed.checks) lines.push(line(check))
  lines.push(`verdict: ${composed.verdict}`)
  if (composed.failed.length) {
    lines.push(`what to look at: ${composed.failed.map((c) => c.name).join(', ')}`)
  }
  if (resume) {
    lines.push(`resume: ${resume}`)
  } else {
    lines.push('resume: nothing was recorded before the restart — carry on with the current task.')
  }
  return lines.join('\n')
}

/** The unit name out of a cgroup line: `/system.slice/dsh-web.service` or a user slice. */
export function parseCgroupUnit(cgroupText) {
  // `$` does not match before a trailing newline in JavaScript, and /proc/self/cgroup ends with
  // one, so the value is trimmed before matching. A user slice nests several units
  // (`user@1000.service/app.slice/dsh-test-web.service`): the deepest one is the unit we run
  // under, so the LAST match wins, not the first.
  const value = String(cgroupText || '').trim()
  const matches = [...value.matchAll(/\/([A-Za-z0-9@_.-]+\.service)(?=\/|$)/g)]
  return matches.length ? matches[matches.length - 1][1] : ''
}

/** The pid listening on a port, out of `ss -ltnp` output. */
export function parsePortOwner(ssOutput, port = 3080) {
  const needle = `:${port}`
  for (const raw of String(ssOutput || '').split('\n')) {
    const row = raw.trim()
    if (!row.startsWith('LISTEN') || !row.includes(needle)) continue
    const pid = row.match(/pid=(\d+)/)
    if (pid) return Number(pid[1])
  }
  return 0
}

/** Whether the port owner lives inside the unit's own cgroup — the production incident in one line. */
export function ownerBelongsToUnit({ ownerCgroup, unit }) {
  if (!unit) return { ok: false, detail: 'the unit name is unknown, so the owner cannot be checked' }
  const cgroup = String(ownerCgroup || '')
  if (!cgroup) return { ok: false, detail: 'the owner process is gone' }
  const belongs = cgroup.includes(`${unit}`)
  return {
    ok: belongs,
    detail: belongs
      ? `the port owner runs inside ${unit}`
      : `the port is held by a process outside ${unit} (${cgroup.slice(0, 80)}) — a stray instance`,
  }
}

/** An intent older than its TTL is reported as stale instead of being presented as current work. */
export function intentState(intent, { now = Date.now(), ttlMs = 6 * 60 * 60 * 1000 } = {}) {
  if (!intent || typeof intent !== 'object') return { present: false, stale: false }
  const hasContent = Boolean(intent.reason || intent.resume || intent.sessionId)
  if (!hasContent) return { present: false, stale: false }
  const at = Date.parse(intent.at || '')
  const stale = Number.isFinite(at) ? now - at > ttlMs : true
  return {
    present: true,
    stale,
    sessionId: intent.sessionId ? String(intent.sessionId) : '',
    reason: intent.reason || '',
    resume: intent.resume || '',
  }
}

/**
 * Whether the unit lives in the user manager or the system one. A user slice nests the unit under
 * `user@<uid>.service`, and `systemctl show` without `--user` will not find it — which is exactly
 * how a perfectly healthy test harness was reported as "inactive/dead".
 */
export function unitScopeFromCgroup(cgroupText) {
  const value = String(cgroupText || '')
  return value.includes('/user.slice/') || value.includes('user@') ? 'user' : 'system'
}

/** The ports this very process is listening on, out of `ss -ltnp` output. */
export function parseListenPortsForPid(ssOutput, pid) {
  const wanted = `pid=${pid},`
  const ports = []
  for (const raw of String(ssOutput || '').split('\n')) {
    const row = raw.trim()
    if (!row.startsWith('LISTEN') || !row.includes(wanted)) continue
    const address = row.split(/\s+/)[3] || ''
    const port = Number((address.match(/:(\d+)$/) || [])[1] || 0)
    if (port) ports.push(port)
  }
  return ports
}

/** The systemctl arguments needed to restart a unit in user or system manager. */
export function systemctlRestartArgs(unit, scope = 'system', options = {}) {
  const allowedUnit = typeof options === 'string' ? options : options?.allowedUnit
  if (!unit || typeof unit !== 'string') return []
  const trimmed = unit.trim()
  if (!UNIT_NAME_PATTERN.test(trimmed)) return []
  if (allowedUnit && trimmed !== allowedUnit) return []
  return scope === 'user' ? ['--user', 'restart', trimmed] : ['restart', trimmed]
}

/** Validate basic YAML syntax for indentation tabs, unclosed quotes, and bracket balance. */
export function validateYamlSyntax(content) {
  if (typeof content !== 'string') return { valid: false, error: 'YAML content must be a string' }
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]
    const indentMatch = rawLine.match(/^[\t ]+/)
    if (indentMatch && indentMatch[0].includes('\t')) {
      return {
        valid: false,
        line: i + 1,
        error: `Tab characters are not allowed for YAML indentation at line ${i + 1}`,
      }
    }
  }

  const bracketStack = []
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (let c = 0; c < line.length; c++) {
      const ch = line[c]
      const prev = c > 0 ? line[c - 1] : ''
      if (ch === '\'' && !inDouble && prev !== '\\') {
        inSingle = !inSingle
      } else if (ch === '"' && !inSingle && prev !== '\\') {
        inDouble = !inDouble
      } else if (ch === '#' && !inSingle && !inDouble) {
        break
      } else if (!inSingle && !inDouble) {
        if (ch === '[' || ch === '{') bracketStack.push({ ch, line: i + 1 })
        else if (ch === ']') {
          const last = bracketStack.pop()
          if (!last || last.ch !== '[') {
            return { valid: false, line: i + 1, error: `Unmatched closing bracket ']' at line ${i + 1}` }
          }
        } else if (ch === '}') {
          const last = bracketStack.pop()
          if (!last || last.ch !== '{') {
            return { valid: false, line: i + 1, error: `Unmatched closing brace '}' at line ${i + 1}` }
          }
        }
      }
    }
  }

  if (bracketStack.length > 0) {
    const unclosed = bracketStack.pop()
    return {
      valid: false,
      line: unclosed.line,
      error: `Unclosed delimiter '${unclosed.ch}' opened at line ${unclosed.line}`,
    }
  }

  return { valid: true }
}

/**
 * Validate preflight configuration and environment before executing a restart (#38).
 */
export function validateRestartPreflight({
  configFiles = [],
  unit = '',
  restartMode = 'kill',
  portOwnerVerdict = null,
} = {}) {
  const checks = []

  for (const file of configFiles) {
    if (!file || typeof file !== 'object') continue
    const { path, content, type } = file
    const name = `config:${path || 'unknown'}`
    if (typeof content !== 'string') {
      checks.push({ name, ok: true, skipped: true, detail: 'file not loaded or absent' })
      continue
    }
    const resolvedType = type || (path && path.endsWith('.json') ? 'json' : (path && (path.endsWith('.yml') || path.endsWith('.yaml')) ? 'yaml' : 'json'))
    if (resolvedType === 'json') {
      try {
        JSON.parse(content)
        checks.push({ name, ok: true, detail: 'valid JSON syntax' })
      } catch (err) {
        checks.push({ name, ok: false, detail: `JSON parse error: ${err.message}` })
      }
    } else if (resolvedType === 'yaml') {
      const res = validateYamlSyntax(content)
      if (res.valid) {
        checks.push({ name, ok: true, detail: 'valid YAML syntax' })
      } else {
        checks.push({ name, ok: false, detail: `YAML syntax error: ${res.error}` })
      }
    }
  }

  if (restartMode === 'systemctl') {
    const isUnitValid = typeof unit === 'string' && UNIT_NAME_PATTERN.test(unit.trim())
    checks.push({
      name: 'unit',
      ok: isUnitValid,
      detail: isUnitValid ? `valid unit syntax (${unit})` : `invalid or missing unit name for systemctl mode: "${unit || ''}"`,
    })
  } else {
    checks.push({
      name: 'unit',
      ok: true,
      skipped: true,
      detail: 'restart mode is kill, unit not required',
    })
  }

  if (portOwnerVerdict) {
    checks.push({
      name: 'port',
      ok: portOwnerVerdict.ok !== false,
      skipped: portOwnerVerdict.skipped === true,
      detail: portOwnerVerdict.detail || (portOwnerVerdict.ok ? 'ports verified' : 'port conflict detected'),
    })
  }

  const failed = checks.filter((c) => c.ok !== true)
  const ok = failed.length === 0
  const verdict = ok ? 'passed' : 'failed'
  const error = failed.length > 0 ? failed.map((c) => `${c.name}: ${c.detail}`).join('; ') : undefined

  return {
    ok,
    verdict,
    checks,
    failed,
    error,
  }
}

/** Format preflight failure into an alert report for chat delivery (#38). */
export function formatPreflightFailureReport(preflight) {
  const lines = [
    'smart-restart: pre-flight validation failed. Restart was aborted to prevent service downtime.',
  ]
  if (preflight && Array.isArray(preflight.checks)) {
    for (const c of preflight.checks) {
      if (c.ok === false) {
        lines.push(`- FAIL ${c.name}: ${c.detail}`)
      } else if (c.ok === true && !c.skipped) {
        lines.push(`- ok ${c.name}: ${c.detail}`)
      }
    }
  }
  lines.push('action: fix the configuration or service conflict before restarting.')
  return lines.join('\n')
}

/** Count active agents excluding the caller session (#39). */
export function countActiveAgents(agentsList = [], callerSessionId = '') {
  if (!Array.isArray(agentsList)) return 0
  const caller = callerSessionId ? String(callerSessionId) : ''
  return agentsList.filter((agent) => {
    if (!agent || typeof agent !== 'object') return false
    const id = String(agent.id || agent.session || agent.sessionId || '')
    if (caller && id === caller) return false
    const status = String(agent.status || '').toLowerCase()
    if (status === 'running' || status === 'busy' || status === 'active' || agent.running === true || agent.busy === true) {
      return true
    }
    return false
  }).length
}

/** Wait for active agents to drain before proceeding with restart (#39). */
export async function drainActiveAgents(getAgentsList, callerSessionId = '', timeoutMs = 15000, pollIntervalMs = 250) {
  const start = Date.now()
  let active = 0
  while (true) {
    const list = typeof getAgentsList === 'function' ? (getAgentsList() || []) : (Array.isArray(getAgentsList) ? getAgentsList : [])
    active = countActiveAgents(list, callerSessionId)
    if (active === 0) {
      return { drained: true, waitedMs: Date.now() - start, activeCount: 0 }
    }
    if (Date.now() - start >= timeoutMs) {
      return { drained: false, waitedMs: Date.now() - start, activeCount: active }
    }
    const step = Math.min(pollIntervalMs, Math.max(10, timeoutMs - (Date.now() - start)))
    await new Promise((resolve) => setTimeout(resolve, step))
  }
}
