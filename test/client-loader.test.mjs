import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

test('web client loader factory returns the plugin exports', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let entry
  const window = {
    __ModuleLoader__: {
      load(value) {
        entry = value
      },
    },
  }

  runInNewContext(source, { window })

  assert.equal(entry.id, '@goodandready/dsh-smart-restart')
  const exports = entry.factory((id) => (id === 'react' ? {} : undefined))
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(Array.from(exports.inject), ['slots', 'locale'])
})
