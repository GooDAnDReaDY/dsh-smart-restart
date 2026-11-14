// WebServer HTTP routes for dsh-smart-restart (#42, #43, #56).

export function writeJsonResponse(res, statusCode, body) {
  if (typeof res.setHeader === 'function') res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.statusCode = statusCode
  res.end(JSON.stringify(body))
}

export function readRequestBody(req) {
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

export function isTrustedRequest(req) {
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

export function registerRoutes(ctx, {
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
}) {
  if (typeof ctx.inject !== 'function') return

  ctx.inject(['webServer'], (sctx) => {
    const server = sctx.get ? (sctx.get('webServer') ?? sctx.webServer) : sctx.webServer
    if (!server || typeof server.register !== 'function') return

    const regGet = server.register({
      kind: 'exact',
      path: '/dsh-smart-restart/status',
      handler: async (req, res) => {
        if (req.method !== 'GET') return writeJsonResponse(res, 405, { ok: false, error: 'GET only' })
        const lastReport = readJson('last-report.json')
        const history = (readJson('history.json') || []).slice(-10)
        const guard = loopGuard(readJson('history.json') || [], { max: live().maxRestarts, windowMs: live().windowMs })
        const activeRestart = getActiveRestart()
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

        if (getActiveRestart()) {
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
          setActiveRestart(null)
          performRestart(mode, unit)
        }, delay)
        activeTimers.add(timer)
        scheduledRecord.timeoutId = timer
        setActiveRestart(scheduledRecord)

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
