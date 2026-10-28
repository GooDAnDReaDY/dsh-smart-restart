import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'
import { safeGet } from '../lib/chat-command.js'

function createStrictCordisContext(declared = ['tools', 'agents', 'settings'], extraServices = {}) {
  const allowed = new Set([
    'on', 'once', 'emit', 'effect', 'inject', 'get', 'set',
    ...declared,
  ])

  const target = {
    inject(deps, cb) {
      const subContext = createStrictCordisContext([...declared, ...deps], extraServices)
      cb(subContext)
    },
    effect(fn) {
      const res = fn()
      return () => { if (typeof res === 'function') res() }
    },
    on(event, handler) {
      return () => {}
    },
    get(name, strict = true) {
      if (declared.includes(name)) return target[name]
      if (extraServices[name]) return extraServices[name]
      return undefined
    },
    tools: {
      register(def) { return () => {} },
    },
    agents: {
      get: () => null,
      roots: () => [],
      list: () => [],
    },
    settings: {},
    ...extraServices,
  }

  return new Proxy(target, {
    get(obj, prop) {
      if (typeof prop === 'symbol') return obj[prop]
      if (allowed.has(prop)) return obj[prop]
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
  })
}

test('strict Cordis v4 proxy throws when accessing undeclared property directly', () => {
  const strictCtx = createStrictCordisContext(['tools', 'agents', 'settings'])
  assert.throws(
    () => { strictCtx.middleware },
    /cannot get property "middleware" without inject/
  )
})

test('safeGet returns undefined without throwing on strict Cordis proxy (#49)', () => {
  const strictCtx = createStrictCordisContext(['tools', 'agents', 'settings'])
  assert.equal(safeGet(strictCtx, 'middleware'), undefined)
  assert.equal(safeGet(strictCtx, 'approval'), undefined)
  assert.equal(safeGet(strictCtx, 'logger'), undefined)
  assert.equal(safeGet(strictCtx, 'nonexistent'), undefined)
  assert.equal(safeGet(null, 'test'), undefined)
})

test('plugin activates cleanly under strict Cordis v4 proxy without inject crashes (#49)', () => {
  const strictCtx = createStrictCordisContext(['tools', 'agents', 'settings'])
  const config = { enabled: true, requireApproval: true }

  let cleanup = null
  assert.doesNotThrow(() => {
    cleanup = apply(strictCtx, config)
  }, 'apply(ctx) must activate cleanly without missing inject errors')

  assert.equal(typeof cleanup, 'function', 'apply must return cleanup function')
  assert.doesNotThrow(() => {
    cleanup()
  }, 'cleanup must dispose without errors')
})

test('plugin activates and registers commands when commands service is injected (#49)', () => {
  let registeredCommand = null
  const extra = {
    commands: {
      register: (def) => {
        registeredCommand = def
        return () => { registeredCommand = null }
      },
    },
  }

  const strictCtx = createStrictCordisContext(['tools', 'agents', 'settings'], extra)
  const config = { enabled: true }

  const cleanup = apply(strictCtx, config)
  assert.ok(registeredCommand, 'commands.register must be called via inject')
  assert.equal(registeredCommand.name, 'restart')

  cleanup()
  assert.equal(registeredCommand, null, 'cleanup must unregister command')
})
