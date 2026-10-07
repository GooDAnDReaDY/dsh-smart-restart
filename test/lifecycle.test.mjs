import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { apply } from '../lib/index.js'

test('live() reads the entry config, so a card save reaches the running guard', async () => {
  let settingsCallback
  const registeredTools = []
  let effectDisposer
  let toolDisposed = false

  // The settings service as DSH 0.1.7-rc.2 and 0.2.0 both ship it: no register().
  // The Loader re-merges the SAME entry config object in place and announces it
  // with loader/volatile-update — that is why live() reads the config apply() got,
  // rather than a separate stored-settings object.
  let onVolatileUpdate = null
  // An isolated state dir: the guard persists a restart history, and reusing the
  // default one let history leak between runs until the window limit refused every
  // restart. A test that passes once and fails the next time is not a test.
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-smart-restart-'))
  const entryConfig = {
    enabled: false, restartMode: 'systemctl', delayMs: 7000, stateDir,
    windowMs: 600000, maxRestarts: 50,
  }

  const mockCtx = {
    on(event, handler) {
      if (event === 'loader/volatile-update') onVolatileUpdate = handler
      return () => {}
    },
    inject(deps, cb) {
      if (deps.includes('settings')) {
        settingsCallback = cb
        cb({
          settings: {
            // If this plugin ever calls register(), it does not exist in either
            // release, so the mock must fail loudly rather than paper over it.
            register() { throw new Error('settings.register does not exist on DSH 0.1.7 or 0.2.0') }
          }
        })
      }
    },
    tools: {
      register(def) {
        registeredTools.push(def)
        return () => {
          toolDisposed = true
        }
      }
    },
    agents: {
      get: () => null
    },
    logger: {
      warn: () => {},
      info: () => {}
    },
    effect(fn) {
      effectDisposer = fn()
    }
  }

  const cleanup = apply(mockCtx, entryConfig)

  assert.equal(typeof cleanup, 'function')
  assert.equal(typeof effectDisposer, 'function')

  const restartTool = registeredTools.find((t) => t.name === 'dsh_restart')
  assert.ok(restartTool, 'dsh_restart tool should be registered')

  // Tool execution when enabled: false in scope
  const restartResult = await restartTool.execute({ confirm: true }, { sessionId: 's1' })
  assert.equal(restartResult.ok, false)
  assert.match(restartResult.error, /disabled in settings/)

  // Enable and switch mode, then announce the way the Loader does after re-merging
  // the volatile entry config.
  entryConfig.enabled = true
  entryConfig.unit = 'my-test.service'
  entryConfig.maxRestarts = 100
  assert.equal(typeof onVolatileUpdate, 'function', 'host must listen for loader/volatile-update')
  onVolatileUpdate()
  const restartAllowed = await restartTool.execute({ confirm: true }, { sessionId: 's1' })
  assert.equal(restartAllowed.ok, true)
  assert.equal(restartAllowed.restarting, true)
  assert.equal(restartAllowed.mode, 'systemctl')

  // Disposing cleans up tools and active timers
  cleanup()
  assert.equal(toolDisposed, true)
  await rm(stateDir, { recursive: true, force: true })
})

test('client slots register the live seats and not the retired one', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let entry
  const window = {
    __ModuleLoader__: {
      load(val) {
        entry = val
      }
    }
  }
  runInNewContext(source, { window })

  const pluginExports = entry.factory((id) => (id === 'react' ? {} : undefined))
  const registeredSlots = []

  const mockClientCtx = {
    locale: {
      register: () => {},
      bind: () => (k) => k
    },
    slots: {
      inject(seat, cb) {
        cb()
      },
      register(slotEntry, component) {
        registeredSlots.push({ slotEntry, component })
      }
    }
  }

  pluginExports.apply(mockClientCtx)

  // settings.plugin.item was retired before DSH 0.1.7-rc.2: one occurrence in the
  // whole 0.1.7-rc.2 tree against 54 of plugins.item. The card now sits on the
  // two seats both releases ship, and the namespace is the profile entry id
  // (goodandready-smart-restart), not the package name.
  const seats = registeredSlots.map((s) => s.slotEntry.name)
  assert.ok(seats.includes('plugins.item'), 'plugins.item should be registered')
  assert.ok(!seats.includes('settings.plugin.item'), 'the retired seat must not be registered')

  const rowSlot = registeredSlots.find((s) => s.slotEntry.name === 'plugins.row.config')
  assert.ok(rowSlot, 'plugins.row.config should be registered')
  assert.equal(rowSlot.slotEntry.key, 'goodandready-smart-restart', 'namespace is the profile entry id')
  assert.equal(rowSlot.slotEntry.locale, 'goodandready-smart-restart')
})

test('cold boot preserves restart budget and does not record in history.json', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-smart-restart-cold-'))
  const entryConfig = {
    enabled: true, stateDir,
  }
  const mockCtx = {
    on: () => () => {},
    inject: () => {},
    tools: { register: () => () => {} },
    agents: { get: () => null },
    logger: { warn: () => {}, info: () => {} },
    effect: () => {},
  }
  const cleanup = apply(mockCtx, entryConfig)
  cleanup()

  let historyExists = true
  try {
    await readFile(join(stateDir, 'history.json'), 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') historyExists = false
  }
  assert.equal(historyExists, false, 'cold boot must not append to history.json')

  const marker = JSON.parse(await readFile(join(stateDir, 'marker.json'), 'utf8'))
  assert.equal(typeof marker.bootAt, 'string')
  assert.equal(marker.pid, process.pid)
  assert.ok(marker.pluginVersion)

  await rm(stateDir, { recursive: true, force: true })
})

test('restart boot records in history.json and delivers report to primary agent if sessionId is empty', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-smart-restart-restart-'))
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(stateDir, 'marker.json'), JSON.stringify({ pid: 1, bootAt: new Date(Date.now() - 5000).toISOString() }))
  await writeFile(join(stateDir, 'intent.json'), JSON.stringify({ at: new Date().toISOString(), reason: 'upgraded', resume: 'continue job' }))

  let followedUpMessage = null
  const primaryAgent = {
    followup(msg) {
      followedUpMessage = msg
    }
  }

  const entryConfig = {
    enabled: true, stateDir, target: 'primary',
  }
  const mockCtx = {
    on: () => () => {},
    inject: () => {},
    tools: { register: () => () => {} },
    agents: {
      get: () => null,
      roots: () => [primaryAgent],
    },
    logger: { warn: () => {}, info: () => {} },
    effect: () => {},
  }

  const cleanup = apply(mockCtx, entryConfig)

  const history = JSON.parse(await readFile(join(stateDir, 'history.json'), 'utf8'))
  assert.equal(Array.isArray(history), true)
  assert.equal(history.length, 1)

  await new Promise((resolve) => setTimeout(resolve, 1800))

  assert.ok(followedUpMessage, 'report must be delivered to primary agent')
  assert.match(followedUpMessage.content[0].text, /upgraded/)
  assert.match(followedUpMessage.content[0].text, /continue job/)

  cleanup()
  await rm(stateDir, { recursive: true, force: true })
})

test('health checks with probe do not leak timers', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-smart-restart-probe-'))
  const entryConfig = { enabled: true, stateDir }
  const mockCtx = {
    on: () => () => {},
    inject: () => {},
    tools: { register: () => () => {} },
    agents: { get: () => null, roots: () => [] },
    logger: { warn: () => {}, info: () => {} },
    effect: () => {},
    get: () => ({ list: () => [] }),
  }
  const cleanup = apply(mockCtx, entryConfig)
  await new Promise((resolve) => setTimeout(resolve, 200))
  cleanup()
  await rm(stateDir, { recursive: true, force: true })
})
