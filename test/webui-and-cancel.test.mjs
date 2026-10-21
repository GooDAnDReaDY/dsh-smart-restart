import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

test('dsh_restart_cancel cancels pending restart and cleans up intent (#43)', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-smart-restart-cancel-'))
  const registeredTools = []
  let deliveredNotice = null

  const callerAgent = {
    id: 's-caller',
    status: 'running',
    send: async (msg) => { deliveredNotice = msg },
  }

  const entryConfig = { enabled: true, stateDir, requireApproval: false, delayMs: 60000 }
  const mockCtx = {
    on: () => () => {},
    inject: () => {},
    tools: {
      register(def) {
        registeredTools.push(def)
        return () => {}
      },
    },
    agents: {
      get: () => callerAgent,
      roots: () => [callerAgent],
      list: () => [callerAgent],
    },
    logger: { warn: () => {}, info: () => {} },
    effect: () => {},
  }

  const cleanup = apply(mockCtx, entryConfig)
  const restartTool = registeredTools.find((t) => t.name === 'dsh_restart')
  const cancelTool = registeredTools.find((t) => t.name === 'dsh_restart_cancel')
  const statusTool = registeredTools.find((t) => t.name === 'dsh_restart_status')

  assert.ok(restartTool, 'dsh_restart must be registered')
  assert.ok(cancelTool, 'dsh_restart_cancel must be registered')
  assert.ok(statusTool, 'dsh_restart_status must be registered')

  // Step 1: Schedule a restart with 60s delay
  const res = await restartTool.execute(
    { confirm: true, reason: 'testing cancellation', delayMs: 60000 },
    { sessionId: 's-caller' },
  )
  assert.equal(res.ok, true)
  assert.equal(res.restarting, true)

  // Verify scheduled state in status
  const statusBefore = await statusTool.execute({})
  assert.ok(statusBefore.scheduled, 'status must report scheduled restart')
  assert.equal(statusBefore.scheduled.reason, 'testing cancellation')
  assert.ok(statusBefore.scheduled.remainingMs > 50000)

  // Verify intent.json exists
  const intentBefore = JSON.parse(await readFile(join(stateDir, 'intent.json'), 'utf8'))
  assert.equal(intentBefore.reason, 'testing cancellation')

  // Step 2: Cancel the restart
  const cancelRes = await cancelTool.execute({})
  assert.equal(cancelRes.ok, true)
  assert.equal(cancelRes.cancelled, true)
  assert.match(cancelRes.message, /successfully cancelled/)

  // Verify intent.json was removed
  let intentExists = true
  try {
    await readFile(join(stateDir, 'intent.json'), 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') intentExists = false
  }
  assert.equal(intentExists, false, 'intent.json must be removed on cancel')

  // Verify status no longer shows scheduled restart
  const statusAfter = await statusTool.execute({})
  assert.equal(statusAfter.scheduled, null)

  // Step 3: Repeated cancel returns cancelled: false without error
  const repeatCancel = await cancelTool.execute({})
  assert.equal(repeatCancel.ok, true)
  assert.equal(repeatCancel.cancelled, false)

  cleanup()
  await rm(stateDir, { recursive: true, force: true })
})

test('webServer routes expose status, safe restart, and cancellation (#42, #43)', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-smart-restart-routes-'))
  const registeredRoutes = new Map()

  const mockWebServer = {
    register(routeDef) {
      registeredRoutes.set(routeDef.path, routeDef)
      return () => { registeredRoutes.delete(routeDef.path) }
    },
  }

  const mockCtx = {
    on: () => () => {},
    inject(deps, fn) {
      if (deps.includes('webServer')) {
        fn({ webServer: mockWebServer })
      }
    },
    tools: { register: () => () => {} },
    agents: { get: () => null, roots: () => [], list: () => [] },
    logger: { warn: () => {}, info: () => {} },
    effect: () => {},
  }

  const entryConfig = { enabled: true, stateDir, requireApproval: false }
  const cleanup = apply(mockCtx, entryConfig)

  // Verify route handlers registered
  const statusRoute = registeredRoutes.get('/dsh-smart-restart/status')
  const restartRoute = registeredRoutes.get('/dsh-smart-restart/restart')
  const cancelRoute = registeredRoutes.get('/dsh-smart-restart/cancel')

  assert.ok(statusRoute, '/dsh-smart-restart/status route must be registered')
  assert.ok(restartRoute, '/dsh-smart-restart/restart route must be registered')
  assert.ok(cancelRoute, '/dsh-smart-restart/cancel route must be registered')

  // Helper to simulate request/response
  function createMockRes() {
    let statusCode = 200
    let body = ''
    const headers = {}
    return {
      setHeader: (k, v) => { headers[k] = v },
      set statusCode(val) { statusCode = val },
      get statusCode() { return statusCode },
      end: (val) => { body = val },
      get json() { return body ? JSON.parse(body) : null },
    }
  }

  function createMockReq(method, data = null) {
    const handlers = {}
    return {
      method,
      on: (event, handler) => { handlers[event] = handler },
      emit: (event, arg) => { if (handlers[event]) handlers[event](arg) },
    }
  }

  // 1. Test GET /dsh-smart-restart/status
  const res1 = createMockRes()
  await statusRoute.handler({ method: 'GET' }, res1)
  assert.equal(res1.statusCode, 200)
  assert.equal(res1.json.ok, true)
  assert.equal(res1.json.status.enabled, true)
  assert.equal(res1.json.status.scheduled, null)

  // 2. Test POST /dsh-smart-restart/restart with dryRun
  const resDry = createMockRes()
  const reqDry = createMockReq('POST')
  const promiseDry = restartRoute.handler(reqDry, resDry)
  reqDry.emit('data', JSON.stringify({ dryRun: true }))
  reqDry.emit('end')
  await promiseDry
  assert.equal(resDry.statusCode, 200)
  assert.equal(resDry.json.dryRun, true)
  assert.equal(resDry.json.preflight.ok, true)

  // 3. Test POST /dsh-smart-restart/restart scheduling a restart
  const resRestart = createMockRes()
  const reqRestart = createMockReq('POST')
  const promiseRestart = restartRoute.handler(reqRestart, resRestart)
  reqRestart.emit('data', JSON.stringify({ reason: 'WebUI test restart', delayMs: 45000 }))
  reqRestart.emit('end')
  await promiseRestart
  assert.equal(resRestart.statusCode, 200)
  assert.equal(resRestart.json.scheduled, true)
  assert.equal(resRestart.json.reason, 'WebUI test restart')

  // Status now shows scheduled restart
  const resStatus2 = createMockRes()
  await statusRoute.handler({ method: 'GET' }, resStatus2)
  assert.ok(resStatus2.json.status.scheduled)
  assert.equal(resStatus2.json.status.scheduled.reason, 'WebUI test restart')

  // 4. Test POST /dsh-smart-restart/cancel
  const resCancel = createMockRes()
  const reqCancel = createMockReq('POST')
  const promiseCancel = cancelRoute.handler(reqCancel, resCancel)
  reqCancel.emit('end')
  await promiseCancel
  assert.equal(resCancel.statusCode, 200)
  assert.equal(resCancel.json.cancelled, true)

  // Status after cancel has no scheduled restart
  const resStatus3 = createMockRes()
  await statusRoute.handler({ method: 'GET' }, resStatus3)
  assert.equal(resStatus3.json.status.scheduled, null)

  cleanup()
  await rm(stateDir, { recursive: true, force: true })
})
