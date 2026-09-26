import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { apply } from '../lib/index.js'

test('live() settings precedence: saved settingsScope overrides defaults and rawConfig', async () => {
  let settingsCallback
  const registeredTools = []
  let effectDisposer
  let toolDisposed = false

  let storedSettings = { enabled: false, restartMode: 'systemctl', delayMs: 7000 }

  const mockCtx = {
    inject(deps, cb) {
      if (deps.includes('settings')) {
        settingsCallback = cb
        cb({
          settings: {
            register(ns, schema, opts) {
              return {
                get: () => storedSettings,
                set: (patch) => Object.assign(storedSettings, patch),
                status: () => 'ready'
              }
            }
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

  const cleanup = apply(mockCtx, { delayMs: 3000, restartMode: 'kill' })

  assert.equal(typeof cleanup, 'function')
  assert.equal(typeof effectDisposer, 'function')

  const restartTool = registeredTools.find((t) => t.name === 'dsh_restart')
  assert.ok(restartTool, 'dsh_restart tool should be registered')

  // Tool execution when enabled: false in scope
  const restartResult = await restartTool.execute({ confirm: true }, { sessionId: 's1' })
  assert.equal(restartResult.ok, false)
  assert.match(restartResult.error, /disabled in settings/)

  // Change storedSettings to enabled: true, mode: systemctl
  storedSettings.enabled = true
  storedSettings.unit = 'my-test.service'
  storedSettings.maxRestarts = 100
  const restartAllowed = await restartTool.execute({ confirm: true }, { sessionId: 's1' })
  assert.equal(restartAllowed.ok, true)
  assert.equal(restartAllowed.restarting, true)
  assert.equal(restartAllowed.mode, 'systemctl')

  // Disposing cleans up tools and active timers
  cleanup()
  assert.equal(toolDisposed, true)
})

test('client slots register canonical settings.plugin.item with key and locale', async () => {
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

  const settingsSlot = registeredSlots.find((s) => s.slotEntry.name === 'settings.plugin.item')
  assert.ok(settingsSlot, 'settings.plugin.item should be registered')
  assert.equal(settingsSlot.slotEntry.key, 'dsh-smart-restart')
  assert.equal(settingsSlot.slotEntry.locale, 'dsh-smart-restart')
})
