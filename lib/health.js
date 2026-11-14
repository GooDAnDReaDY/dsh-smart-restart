// Health checks and environment inspection for dsh-smart-restart (#38, #56).

import { execFile, execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { promisify } from 'node:util'

import {
  composeChecks,
  ownerBelongsToUnit,
  parseCgroupUnit,
  parseListenPortsForPid,
  parsePortOwner,
  unitScopeFromCgroup,
  validateRestartPreflight,
} from './boot.js'
import { safeGet } from './chat-command.js'

const run = promisify(execFile)
const require = createRequire(import.meta.url)

export function versionOf(pkg, fallback = '0.1.1') {
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

export function readInstalledPackages(homeDir) {
  const candidatePaths = [
    join(homeDir, 'profiles/web/package.json'),
    join(homeDir, 'package.json'),
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

export function detectUnit() {
  try {
    return parseCgroupUnit(readFileSync('/proc/self/cgroup', 'utf8'))
  } catch {
    return ''
  }
}

export function resolveSafeUnit(configuredUnit, logger) {
  const detected = detectUnit()
  const configured = typeof configuredUnit === 'string' ? configuredUnit.trim() : ''
  if (!configured) return detected
  if (!/^[A-Za-z0-9@_.-]+\.service$/.test(configured)) {
    logger?.warn?.(`[smart-restart-guard] configured unit "${configured}" is not a valid systemd service name; using detected unit "${detected}"`)
    return detected
  }
  if (detected && configured !== detected) {
    logger?.warn?.(`[smart-restart-guard] configured unit "${configured}" does not match detected unit "${detected}"; refusing arbitrary unit restart and using detected unit`)
    return detected
  }
  return configured
}

export function listenPortsForOurUnit(unit) {
  try {
    const output = execFileSync('ss', ['-ltnp'], { timeout: 3000, encoding: 'utf8' })
    return parseListenPortsForPid(output, process.pid)
  } catch {
    return []
  }
}

export function createHealthChecker({
  ctx,
  live,
  unitName,
  safeSetTimeout,
  clearTimer,
  versionOfFn = versionOf,
  readJson,
  homeDir,
}) {
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

  async function checkServices() {
    const wanted = ['webServer', 'tools', 'agents']
    const missing = []
    for (const name of wanted) {
      try {
        const s = safeGet(ctx, name)
        if (!s) missing.push(name)
      } catch {
        missing.push(name)
      }
    }
    return {
      name: 'services',
      ok: missing.length === 0,
      detail: missing.length ? `missing service(s): ${missing.join(', ')}` : `core services injected (${wanted.join(', ')})`,
    }
  }

  function checkTools() {
    const expected = live().expectTools || []
    let names = []
    try {
      const service = ctx.get ? ctx.get('tools') : ctx.tools
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
    const ports = parseListenPortsForPid(output, process.pid)
    if (ports.length === 0) return { name: 'port', ok: true, skipped: true, detail: 'this process is not listening anywhere' }

    for (const port of ports) {
      const owner = parsePortOwner(output, port)
      if (owner && owner !== process.pid) {
        let ownerCgroup = ''
        try {
          ownerCgroup = readFileSync(`/proc/${owner}/cgroup`, 'utf8')
        } catch {
          ownerCgroup = ''
        }
        const portVerdict = ownerBelongsToUnit({ ownerCgroup, unit })
        if (!portVerdict.ok) {
          return { name: 'port', ok: false, detail: `port ${port} held by pid ${owner}: ${portVerdict.detail}` }
        }
      }
    }

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
    const plugin = versionOfFn('@goodandready/dsh-smart-restart', '0.1.1')
    const core = versionOfFn('@deepseek-ai/dsh', '')
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

  async function runPreflight(targetUnit, mode) {
    const configFiles = []
    const baseHome = typeof homeDir === 'function' ? homeDir() : homeDir
    const candidatePaths = [
      join(baseHome, 'cordis.patch.yml'),
      join(baseHome, 'cordis.yml'),
      join(baseHome, 'package.json'),
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

  return {
    probe,
    checkServices,
    checkTools,
    checkUnit,
    checkPort,
    checkVersions,
    healthCheck,
    runPreflight,
  }
}
