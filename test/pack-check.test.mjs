import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const scriptPath = join(process.cwd(), 'scripts', 'pack-check.mjs')

test('pack-check passes when no stray tarballs exist in root and package size is within limit (#54)', () => {
  const result = execFileSync('node', [scriptPath], {
    encoding: 'utf8',
    cwd: process.cwd(),
  })
  assert.match(result, /\[pack:check\] OK: 11 files packed/)
  assert.match(result, /All files under 262144 bytes/)
})

test('pack-check refuses execution and exits with code 1 if a stray .tgz is in root (#54)', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'pack-check-stray-'))
  try {
    // Create a mock package.json and a stray tarball in tempDir
    await writeFile(join(tempDir, 'package.json'), JSON.stringify({ name: 'test-pkg', version: '1.0.0' }))
    await writeFile(join(tempDir, 'dummy-release.tgz'), 'dummy')

    assert.throws(
      () => {
        execFileSync('node', [scriptPath], {
          encoding: 'utf8',
          cwd: tempDir,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      },
      (err) => {
        assert.equal(err.status, 1)
        assert.match(err.stderr, /Untracked release tarballs found in source root: dummy-release\.tgz/)
        return true
      }
    )
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})
