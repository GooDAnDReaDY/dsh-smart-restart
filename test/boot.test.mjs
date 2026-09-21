import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildReport,
  composeChecks,
  detectRestart,
  intentState,
  loopGuard,
  ownerBelongsToUnit,
  parseCgroupUnit,
  parsePortOwner,
} from '../lib/boot.js'

test('a different pid is a restart, the same pid is not', () => {
  const previous = { pid: 100, bootAt: '2026-09-21T20:00:00.000Z' }
  const now = Date.parse('2026-09-21T20:00:06.200Z')
  const restarted = detectRestart(previous, 200, now)
  assert.equal(restarted.wasRestart, true)
  assert.equal(restarted.downtimeMs, 6200)
  assert.equal(restarted.prevBootAt, previous.bootAt)

  const same = detectRestart(previous, 100, now)
  assert.equal(same.wasRestart, false)

  const first = detectRestart(null, 100, now)
  assert.equal(first.firstBoot, true)
  assert.equal(first.wasRestart, false)
})

test('a corrupt marker does not invent a downtime', () => {
  const result = detectRestart({ pid: 1, bootAt: 'nonsense' }, 2, Date.now())
  assert.equal(result.wasRestart, true)
  assert.equal(result.downtimeMs, null)
})

test('the loop guard counts only the restarts inside the window', () => {
  const now = Date.parse('2026-09-21T20:00:00.000Z')
  const history = [now - 1000, now - 2000, now - 700000, now - 3000]
  const guard = loopGuard(history, { now, max: 3, windowMs: 600000 })
  assert.equal(guard.count, 3, 'the old entry falls out of the window')
  assert.equal(guard.allowed, false)

  const room = loopGuard([now - 1000], { now, max: 3, windowMs: 600000 })
  assert.equal(room.allowed, true)
  assert.equal(room.count, 1)
})

test('the verdict is degraded as soon as one check fails, and skipped checks do not count as failures', () => {
  const ok = composeChecks([
    { name: 'services', ok: true, detail: 'webServer, tools' },
    { name: 'unit', ok: true, detail: 'active/running' },
    { name: 'port', ok: true, skipped: true, detail: 'ss is unavailable here' },
  ])
  assert.equal(ok.verdict, 'ok')
  assert.equal(ok.skipped.length, 1)

  const bad = composeChecks([
    { name: 'services', ok: true },
    { name: 'unit', ok: false, detail: 'activating' },
  ])
  assert.equal(bad.verdict, 'degraded')
  assert.deepEqual(bad.failed.map((c) => c.name), ['unit'])
})

test('the report says what happened, what failed and what to resume', () => {
  const text = buildReport({
    bootAt: '2026-09-21T20:00:06.200Z',
    downtimeMs: 6200,
    pid: 4242,
    checks: [
      { name: 'services', ok: true, detail: 'webServer, tools' },
      { name: 'port', ok: false, detail: 'held by a process outside the unit' },
    ],
    resume: 'finish the release and report',
    reason: 'installed a new plugin',
    previousVersion: '0.1.0',
    version: '0.1.1',
  })
  assert.match(text, /1 check\(s\) did not pass/)
  assert.match(text, /was down 6\.2s, pid 4242/)
  assert.match(text, /reason recorded before the restart: installed a new plugin/)
  assert.match(text, /version changed: 0\.1\.0 -> 0\.1\.1/)
  assert.match(text, /- ok services/)
  assert.match(text, /- FAIL port/)
  assert.match(text, /verdict: degraded/)
  assert.match(text, /what to look at: port/)
  assert.match(text, /resume: finish the release and report/)
  assert.ok(!text.includes('undefined'), 'a report never carries undefined')
})

test('a healthy report says so and still carries the intent', () => {
  const text = buildReport({
    bootAt: '2026-09-21T20:00:00.000Z',
    downtimeMs: 5000,
    pid: 7,
    checks: [{ name: 'services', ok: true, detail: 'webServer' }],
    resume: '',
  })
  assert.match(text, /boot check passed/)
  assert.match(text, /verdict: ok/)
  assert.match(text, /nothing was recorded before the restart/)
})

test('the unit comes out of a cgroup line, for system and user slices', () => {
  assert.equal(parseCgroupUnit('0::/system.slice/dsh-web.service\n'), 'dsh-web.service')
  assert.equal(parseCgroupUnit('0::/user.slice/user-1000.slice/user@1000.service/app.slice/dsh-test-web.service'), 'dsh-test-web.service')
  assert.equal(parseCgroupUnit('0::/user.slice/session-1.scope'), '')
  assert.equal(parseCgroupUnit(''), '')
})

test('the port owner is read out of ss output', () => {
  const output = [
    'State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process',
    'LISTEN 0      511    127.0.0.1:3080      0.0.0.0:*    users:(("MainThread",pid=2402362,fd=21))',
    'LISTEN 0      511    127.0.0.1:3082      0.0.0.0:*    users:(("MainThread",pid=9,fd=21))',
  ].join('\n')
  assert.equal(parsePortOwner(output, 3080), 2402362)
  assert.equal(parsePortOwner(output, 9999), 0)
  assert.equal(parsePortOwner('', 3080), 0)
})

test('the port check names a stray instance instead of shrugging', () => {
  const inside = ownerBelongsToUnit({ ownerCgroup: '0::/system.slice/dsh-web.service', unit: 'dsh-web.service' })
  assert.equal(inside.ok, true)
  const stray = ownerBelongsToUnit({ ownerCgroup: '0::/user.slice/session-170773.scope', unit: 'dsh-web.service' })
  assert.equal(stray.ok, false)
  assert.match(stray.detail, /stray instance/)
  assert.equal(ownerBelongsToUnit({ ownerCgroup: '', unit: 'dsh-web.service' }).ok, false)
  assert.equal(ownerBelongsToUnit({ ownerCgroup: 'x', unit: '' }).ok, false)
})

test('an intent older than its TTL is marked stale rather than presented as current work', () => {
  const now = Date.parse('2026-09-21T20:00:00.000Z')
  const fresh = intentState({ sessionId: 's1', at: new Date(now - 60_000).toISOString(), resume: 'x' }, { now })
  assert.equal(fresh.present, true)
  assert.equal(fresh.stale, false)
  assert.equal(fresh.resume, 'x')

  const old = intentState({ sessionId: 's1', at: new Date(now - 7 * 3600_000).toISOString() }, { now })
  assert.equal(old.stale, true)

  assert.deepEqual(intentState(null, { now }), { present: false, stale: false })
})
