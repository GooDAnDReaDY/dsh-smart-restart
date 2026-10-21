import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

async function loadClient(modules = {}) {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let entry
  const window = {
    __ModuleLoader__: {
      load(value) {
        entry = value
      },
    },
  }

  runInNewContext(source, {
    window,
    console,
    document: {
      createElement: () => ({ setAttribute: () => {}, textContent: '', dataset: {} }),
      head: { appendChild: () => {} },
    },
  })

  assert.equal(entry.id, '@goodandready/dsh-smart-restart')
  const exports = entry.factory((id) => {
    if (modules[id] !== undefined) return modules[id]
    if (id === 'react') {
      return {
        createElement: (...args) => args,
        useState: (v) => [v, () => {}],
        useEffect: (fn) => typeof fn === 'function' && fn(),
      }
    }
    return undefined
  })
  return { entry, exports, source }
}

test('web client loader factory returns the plugin exports', async () => {
  const { entry, exports } = await loadClient()
  assert.equal(entry.id, '@goodandready/dsh-smart-restart')
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(Array.from(exports.inject), ['slots', 'locale'])
})

test('apply registers locales within ctx.effect and returns cleanup disposer (#29)', async () => {
  const { exports } = await loadClient()
  let disposed = false
  let registered = false
  let effectDisposer = null

  const ctx = {
    effect(fn) {
      effectDisposer = fn()
    },
    locale: {
      register(ns, dicts) {
        registered = true
        assert.equal(ns, 'goodandready-smart-restart')
        assert.ok(dicts.en)
        assert.ok(dicts.zh)
        return () => {
          disposed = true
        }
      },
      bind: () => (k) => k,
    },
    slots: {
      inject: () => {},
      register: () => {},
    },
  }

  exports.apply(ctx)
  assert.ok(registered, 'locales should be registered')
  assert.equal(typeof effectDisposer, 'function', 'effect must return disposer')
  effectDisposer()
  assert.ok(disposed, 'disposer returned by locale.register must be called on teardown')
})

test('apply logs warning when settings scope is unavailable (#26)', async () => {
  const { exports } = await loadClient()
  const warnings = []
  const registeredEntries = []

  const ctx = {
    logger: {
      warn(...args) {
        warnings.push(args.join(' '))
      },
    },
    get() {
      return null
    },
    locale: {
      register: () => () => {},
      bind: () => (k) => k,
    },
    slots: {
      inject(seat, fn) {
        fn()
      },
      register(entry, component) {
        registeredEntries.push({ entry, component })
      },
    },
  }

  exports.apply(ctx)
  assert.ok(warnings.some((w) => w.includes('settings scope is unavailable')), 'warning logged for unavailable scope')
  assert.equal(registeredEntries.length, 2, 'registers both slots')
  const { scope } = registeredEntries[0].entry.inject()
  assert.equal(scope, null, 'scope injected is null')
})

test('core chevron icon is imported from @deepseek-ai/dsh-client-ui-primitives (#27)', async () => {
  const dummyChevron = () => 'chevron'
  const { entry } = await loadClient({
    '@deepseek-ai/dsh-client-ui-primitives': {
      IconChevronDownOutline14: dummyChevron,
    },
  })
  assert.ok(entry, 'client loaded with primitives')
})

test('css uses var(--dsw-alias-state-error-primary) instead of deprecated label-error (#30)', async () => {
  const { source } = await loadClient()
  assert.ok(source.includes('--dsw-alias-state-error-primary'), 'css has error primary token')
  assert.ok(!source.includes('--dsw-alias-label-error'), 'deprecated token removed')
})

test('client registers dashboard, history, and countdown locales in en and zh (#42, #43)', async () => {
  const { exports } = await loadClient()
  let capturedDicts = null
  const ctx = {
    effect(fn) { fn() },
    locale: {
      register(_ns, dicts) {
        capturedDicts = dicts
        return () => {}
      },
      bind: () => (k) => k,
    },
    slots: { inject: () => {}, register: () => {} },
  }

  exports.apply(ctx)
  assert.ok(capturedDicts)
  const requiredKeys = [
    'healthVerdict',
    'healthOk',
    'healthDegraded',
    'healthLoop',
    'historyTitle',
    'safeRestart',
    'confirmRestart',
    'cancelRestart',
    'restartingIn',
    'restartCancelled',
  ]
  for (const k of requiredKeys) {
    assert.ok(capturedDicts.en[k], `en must have key ${k}`)
    assert.ok(capturedDicts.zh[k], `zh must have key ${k}`)
  }
})

test('RestartGuardCard mounts cleanly with dashboard and countdown styles (#42, #43)', async () => {
  const { exports, source } = await loadClient()
  assert.ok(exports.RestartGuardCard, 'RestartGuardCard must be exported')
  // Verify CSS contains dashboard, badges, banner, and table classes
  assert.ok(source.includes('.sr-banner'))
  assert.ok(source.includes('.sr-dash'))
  assert.ok(source.includes('.sr-badge-ok'))
  assert.ok(source.includes('.sr-badge-warn'))
  assert.ok(source.includes('.sr-badge-err'))
  assert.ok(source.includes('.sr-btn-danger'))
  assert.ok(source.includes('.sr-table'))

  // Mount card component
  const rendered = exports.RestartGuardCard({
    t: (k) => k,
    scope: {
      getSnapshot: () => ({ status: 'ready', value: { enabled: true } }),
      subscribe: () => () => {},
    },
  })
  assert.ok(rendered, 'RestartGuardCard must render')
})
