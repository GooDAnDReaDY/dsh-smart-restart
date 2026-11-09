import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply, name, PRODUCER_SOURCE_KIND, RETIRED_PLUGIN_KIND } from '../lib/index.js'

/**
 * Strict DSH session format v4 source validator matching @deepseek-ai/dsh-session-format-v3-to-v4
 * and @deepseek-ai/dsh-session-persistence-jsonl.
 */
function assertV4MessageSource(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('format v4 message requires a json object source')
  }
  if (typeof source.kind !== 'string' || source.kind.length === 0 || source.kind === 'plugin') {
    throw new Error('format v4 message requires a producer-owned source kind')
  }
  return true
}

test('producer-owned source constants are declared correctly (#51)', () => {
  assert.equal(name, 'dsh-smart-restart')
  assert.equal(PRODUCER_SOURCE_KIND, 'plugin:dsh-smart-restart')
  assert.equal(RETIRED_PLUGIN_KIND, 'plugin')
})

test('v4 source validator rejects retired kind="plugin" and accepts producer-owned kind (#51)', () => {
  const retiredSource = { kind: 'plugin', plugin: name, form: 'notice', summary: 'test' }
  assert.throws(
    () => assertV4MessageSource(retiredSource),
    /format v4 message requires a producer-owned source kind/
  )

  const v4Source = { kind: PRODUCER_SOURCE_KIND, form: 'notice', summary: 'test' }
  assert.doesNotThrow(() => assertV4MessageSource(v4Source))
})

test('delivered restart report uses producer-owned source kind and passes v4 validation (#51)', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-smart-restart-v4-src-'))
  await writeFile(
    join(stateDir, 'marker.json'),
    JSON.stringify({ pid: 1, bootAt: new Date(Date.now() - 5000).toISOString() })
  )
  await writeFile(
    join(stateDir, 'intent.json'),
    JSON.stringify({ at: new Date().toISOString(), reason: 'upgraded to v4', resume: 'continue job' })
  )

  let deliveredMessage = null
  const mockAgent = {
    followup(msg) {
      deliveredMessage = msg
    },
  }

  const mockCtx = {
    on: () => () => {},
    inject: () => {},
    tools: { register: () => () => {} },
    agents: {
      get: () => null,
      roots: () => [mockAgent],
      list: () => [mockAgent],
    },
    logger: { warn: () => {}, info: () => {}, debug: () => {} },
    effect: () => {},
  }

  const cleanup = apply(mockCtx, {
    enabled: true,
    stateDir,
    target: 'primary',
  })

  // Wait for deliverWithWait
  for (let i = 0; i < 30; i++) {
    if (deliveredMessage) break
    await new Promise((r) => setTimeout(r, 100))
  }

  assert.ok(deliveredMessage, 'report message must be delivered to agent')
  assert.ok(deliveredMessage.source, 'delivered message must have source metadata')

  // #51 Requirements:
  // 1. Source kind must NOT be retired 'plugin'
  assert.notEqual(
    deliveredMessage.source.kind,
    'plugin',
    'source.kind must not equal retired catch-all "plugin"'
  )

  // 2. Source kind must be producer-owned 'plugin:<name>'
  assert.equal(
    deliveredMessage.source.kind,
    'plugin:dsh-smart-restart',
    'source.kind must be producer-owned "plugin:dsh-smart-restart"'
  )

  // 3. Retired 'plugin' property must not be present
  assert.equal(
    deliveredMessage.source.plugin,
    undefined,
    'source.plugin field must be dropped in v4'
  )

  // 4. Additional fields (form, summary) preserved
  assert.equal(deliveredMessage.source.form, 'notice')
  assert.ok(deliveredMessage.source.summary, 'summary field preserved')

  // 5. Native DSH v4 validation must pass without errors
  assert.doesNotThrow(() => assertV4MessageSource(deliveredMessage.source))

  if (typeof cleanup === 'function') cleanup()
})
