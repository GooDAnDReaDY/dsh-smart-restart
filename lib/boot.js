// Pure decisions of the restart guard: was this a restart, how long were we down, may we restart
// again, what do the checks add up to, and what does the report say.
//
// Nothing here touches the filesystem or spawns anything, so every rule can be tested without a
// harness, a service manager or a working copy.

/** How a boot marker looks. `pid` is the discriminator: a new process means a restart. */
export function readBoot(now = Date.now()) {
  return { pid: process.pid, bootAt: new Date(now).toISOString(), dshVersion: '' }
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
  if (!intent || typeof intent !== 'object' || !intent.sessionId) return { present: false, stale: false }
  const at = Date.parse(intent.at || '')
  const stale = Number.isFinite(at) ? now - at > ttlMs : true
  return { present: true, stale, sessionId: String(intent.sessionId), reason: intent.reason || '', resume: intent.resume || '' }
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
