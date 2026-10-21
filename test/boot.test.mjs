import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildReport,
  clampDelayMs,
  composeChecks,
  countActiveAgents,
  detectRestart,
  diffPackages,
  drainActiveAgents,
  formatPackageDiff,
  formatPreflightFailureReport,
  intentState,
  loopGuard,
  MAX_DELAY_MS,
  ownerBelongsToUnit,
  parseCgroupUnit,
  parsePortOwner,
  parseListenPortsForPid,
  readBoot,
  resolveSafeStateDir,
  systemctlRestartArgs,
  unitScopeFromCgroup,
  validateRestartPreflight,
  validateYamlSyntax,
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
  assert.match(inside.detail, /inside dsh-web\.service/)

  const outside = ownerBelongsToUnit({ ownerCgroup: '0::/system.slice/dsh-stray.service', unit: 'dsh-web.service' })
  assert.equal(outside.ok, false)
  assert.match(outside.detail, /stray instance/)

  const noUnit = ownerBelongsToUnit({ ownerCgroup: '0::/system.slice/dsh-web.service', unit: '' })
  assert.equal(noUnit.ok, false)
})

test('an intent older than its TTL is marked stale rather than presented as current work', () => {
  const now = Date.parse('2026-09-21T20:00:00.000Z')
  const fresh = intentState({ at: new Date(now - 60000).toISOString(), reason: 'upgraded', resume: 'run smoke' }, { now })
  assert.equal(fresh.present, true)
  assert.equal(fresh.stale, false)
  assert.equal(fresh.reason, 'upgraded')
  assert.equal(fresh.resume, 'run smoke')

  const stale = intentState({ at: new Date(now - 7 * 3600 * 1000).toISOString(), reason: 'ancient' }, { now })
  assert.equal(stale.present, true)
  assert.equal(stale.stale, true)

  assert.deepEqual(intentState(null), { present: false, stale: false })
  assert.deepEqual(intentState({ at: 'broken-date' }), { present: false, stale: false })
})

test('a user unit is recognised, so it is inspected in the user manager', () => {
  assert.equal(unitScopeFromCgroup('0::/system.slice/dsh-web.service'), 'system')
  assert.equal(unitScopeFromCgroup('0::/user.slice/user-1000.slice/user@1000.service/app.slice/dsh-test-web.service'), 'user')
  assert.equal(unitScopeFromCgroup(''), 'system')
})

test('the ports we serve are found from our own pid', () => {
  const output = [
    'State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process',
    'LISTEN 0      511    127.0.0.1:3080      0.0.0.0:*    users:(("MainThread",pid=4242,fd=21))',
    'LISTEN 0      511    127.0.1.1:3080      0.0.0.0:*    users:(("MainThread",pid=4242,fd=47))',
    'LISTEN 0      511    127.0.0.1:3082      0.0.0.0:*    users:(("MainThread",pid=9,fd=21))',
  ].join('\n')
  assert.deepEqual(parseListenPortsForPid(output, 4242), [3080, 3080])
  assert.deepEqual(parseListenPortsForPid(output, 7), [])
  assert.deepEqual(parseListenPortsForPid('', 4242), [])
})

test('systemctl restart args includes --user for user units and bare for system', () => {
  assert.deepEqual(systemctlRestartArgs('dsh.service', 'system'), ['restart', 'dsh.service'])
  assert.deepEqual(systemctlRestartArgs('dsh-test.service', 'user'), ['--user', 'restart', 'dsh-test.service'])
  assert.deepEqual(systemctlRestartArgs(''), [])
})

test('readBoot generates marker with pid, timestamp, and detected versions', () => {
  const now = 1758500000000
  const marker = readBoot(now, { pluginVersion: '0.1.7', dshVersion: '0.2.0-rc.2', pid: 9999 })
  assert.equal(marker.pid, 9999)
  assert.equal(marker.bootAt, new Date(now).toISOString())
  assert.equal(marker.pluginVersion, '0.1.7')
  assert.equal(marker.dshVersion, '0.2.0-rc.2')

  const prevEnv = process.env.DSH_VERSION
  try {
    process.env.DSH_VERSION = '0.2.0-env'
    const autoMarker = readBoot(now, { pluginVersion: '0.1.7' })
    assert.equal(autoMarker.dshVersion, '0.2.0-env')
  } finally {
    if (prevEnv === undefined) delete process.env.DSH_VERSION
    else process.env.DSH_VERSION = prevEnv
  }
})

test('intentState recognises intent without sessionId when reason or resume is present', () => {
  const now = Date.parse('2026-09-21T20:00:00.000Z')
  const noSession = intentState({ at: new Date(now - 1000).toISOString(), reason: 'upgraded', resume: 'run smoke' }, { now })
  assert.equal(noSession.present, true)
  assert.equal(noSession.stale, false)
  assert.equal(noSession.sessionId, '')
  assert.equal(noSession.reason, 'upgraded')
  assert.equal(noSession.resume, 'run smoke')

  const empty = intentState({}, { now })
  assert.equal(empty.present, false)
  assert.equal(empty.stale, false)
})

test('systemctlRestartArgs validates unit syntax and restricts to allowedUnit (#36)', async () => {
  assert.deepEqual(systemctlRestartArgs('dsh-web.service'), ['restart', 'dsh-web.service'])
  assert.deepEqual(systemctlRestartArgs('dsh-web.service', 'user'), ['--user', 'restart', 'dsh-web.service'])
  // Invalid unit names or shell injection attempts are refused
  assert.deepEqual(systemctlRestartArgs('dsh-web.service; rm -rf /'), [])
  assert.deepEqual(systemctlRestartArgs('dsh-web.target'), [])
  assert.deepEqual(systemctlRestartArgs('../../etc/passwd'), [])
  // When allowedUnit is specified, divergent units are refused
  assert.deepEqual(systemctlRestartArgs('rogue.service', 'system', { allowedUnit: 'dsh-web.service' }), [])
  assert.deepEqual(systemctlRestartArgs('dsh-web.service', 'system', { allowedUnit: 'dsh-web.service' }), ['restart', 'dsh-web.service'])
})

test('clampDelayMs bounds delay between 500ms and 2147483647ms (#36)', async () => {
  assert.equal(clampDelayMs(100), 500)
  assert.equal(clampDelayMs(5000), 5000)
  assert.equal(clampDelayMs(3000000000), MAX_DELAY_MS)
  assert.equal(clampDelayMs(Infinity), MAX_DELAY_MS)
  assert.equal(clampDelayMs('not-a-number', 4000), 4000)
})

test('resolveSafeStateDir prevents path traversal outside baseHome (#36)', async () => {
  const baseHome = '/home/user/.dsh'
  // Default fallback
  assert.equal(resolveSafeStateDir('', baseHome), '/home/user/.dsh/.restart-guard')
  // Valid relative subdirectory inside baseHome
  assert.equal(resolveSafeStateDir('safe-state', baseHome), '/home/user/.dsh/safe-state')
  // Path traversal attempting to escape baseHome is blocked and falls back to default
  assert.equal(resolveSafeStateDir('../../../etc/cron.d', baseHome), '/home/user/.dsh/.restart-guard')
  assert.equal(resolveSafeStateDir('safe/../../etc', baseHome), '/home/user/.dsh/.restart-guard')
  // Absolute paths for test fixtures are resolved
  assert.equal(resolveSafeStateDir('/tmp/test-fixture', baseHome), '/tmp/test-fixture')
})

test('validateYamlSyntax catches tab indentation and unbalanced delimiters (#38)', () => {
  // Valid yaml
  const valid = 'name: test\nservices:\n  - webServer\n  - tools\n'
  assert.deepEqual(validateYamlSyntax(valid), { valid: true })

  // Invalid: tabs used for indentation
  const tabYaml = 'name: test\n\tindent_with_tab: true\n'
  const tabRes = validateYamlSyntax(tabYaml)
  assert.equal(tabRes.valid, false)
  assert.match(tabRes.error, /Tab characters are not allowed/)
  assert.equal(tabRes.line, 2)

  // Invalid: unbalanced bracket
  const bracketYaml = 'plugins: [first, second'
  const bracketRes = validateYamlSyntax(bracketYaml)
  assert.equal(bracketRes.valid, false)
  assert.match(bracketRes.error, /Unclosed delimiter/)

  // Invalid: mismatched brace
  const mismatchYaml = 'config: {key: "val"]'
  const mismatchRes = validateYamlSyntax(mismatchYaml)
  assert.equal(mismatchRes.valid, false)
  assert.match(mismatchRes.error, /Unmatched closing bracket/)
})

test('validateRestartPreflight verifies config syntax, unit format, and port conflicts (#38)', () => {
  // Case 1: Healthy preflight
  const healthy = validateRestartPreflight({
    configFiles: [
      { path: 'package.json', content: '{"name": "test-app", "version": "1.0.0"}' },
      { path: 'cordis.patch.yml', content: 'services:\n  tools: true\n' },
    ],
    unit: 'dsh-web.service',
    restartMode: 'systemctl',
    portOwnerVerdict: { ok: true, detail: 'the port owner runs inside dsh-web.service' },
  })
  assert.equal(healthy.ok, true)
  assert.equal(healthy.verdict, 'passed')
  assert.equal(healthy.failed.length, 0)

  // Case 2: Corrupted JSON config
  const badJson = validateRestartPreflight({
    configFiles: [
      { path: 'package.json', content: '{"name": "broken", invalid' },
    ],
    restartMode: 'kill',
  })
  assert.equal(badJson.ok, false)
  assert.equal(badJson.verdict, 'failed')
  assert.match(badJson.error, /JSON parse error/)

  // Case 3: Corrupted YAML config with tab indent
  const badYaml = validateRestartPreflight({
    configFiles: [
      { path: 'cordis.patch.yml', content: 'services:\n\tweb: true\n' },
    ],
    restartMode: 'kill',
  })
  assert.equal(badYaml.ok, false)
  assert.match(badYaml.error, /Tab characters are not allowed/)

  // Case 4: Invalid unit name in systemctl mode
  const badUnit = validateRestartPreflight({
    configFiles: [],
    unit: 'malicious.service; rm -rf /',
    restartMode: 'systemctl',
  })
  assert.equal(badUnit.ok, false)
  assert.match(badUnit.error, /invalid or missing unit name/)

  // Case 5: Rogue port owner conflict
  const roguePort = validateRestartPreflight({
    configFiles: [],
    unit: 'dsh-web.service',
    restartMode: 'kill',
    portOwnerVerdict: { ok: false, detail: 'stray instance holding port' },
  })
  assert.equal(roguePort.ok, false)
  assert.match(roguePort.error, /stray instance/)
})

test('formatPreflightFailureReport generates clear actionable alert for chat (#38)', () => {
  const preflight = {
    ok: false,
    checks: [
      { name: 'config:cordis.patch.yml', ok: false, detail: 'Tab characters are not allowed for YAML indentation at line 4' },
      { name: 'unit', ok: true, detail: 'valid unit syntax' },
    ],
  }
  const report = formatPreflightFailureReport(preflight)
  assert.match(report, /pre-flight validation failed/)
  assert.match(report, /- FAIL config:cordis\.patch\.yml: Tab characters/)
  assert.match(report, /- ok unit/)
  assert.match(report, /action: fix the configuration/)
})

test('countActiveAgents excludes caller session and counts active turns (#39)', () => {
  const agents = [
    { id: 'caller-session', status: 'running' },
    { id: 'other-session-1', status: 'running' },
    { id: 'other-session-2', status: 'idle' },
    { id: 'other-session-3', busy: true },
  ]
  // Caller session is ignored; other running/busy agents are counted
  assert.equal(countActiveAgents(agents, 'caller-session'), 2)
  assert.equal(countActiveAgents(agents, 'unknown-caller'), 3)
  assert.equal(countActiveAgents([], 'caller-session'), 0)
})

test('drainActiveAgents waits for active tasks to complete (#39)', async () => {
  let agentBusy = true
  const getAgents = () => [
    { id: 'caller-session', status: 'running' },
    { id: 'worker-agent', status: agentBusy ? 'running' : 'idle' },
  ]

  // Simulate background task completing after 100ms
  setTimeout(() => { agentBusy = false }, 100)

  const result = await drainActiveAgents(getAgents, 'caller-session', 1000, 25)
  assert.equal(result.drained, true)
  assert.equal(result.activeCount, 0)
  assert.ok(result.waitedMs >= 80)

  // Simulate task that never finishes and times out
  const busyAgent = () => [{ id: 'stuck-worker', status: 'running' }]
  const timedOut = await drainActiveAgents(busyAgent, 'caller-session', 150, 25)
  assert.equal(timedOut.drained, false)
  assert.equal(timedOut.activeCount, 1)
})

test('diffPackages identifies added, removed, and upgraded packages (#41)', () => {
  const previous = {
    '@deepseek-ai/dsh-tools': '0.1.7',
    'left-pad': '1.0.0',
    'express': '4.18.0',
  }
  const current = {
    '@deepseek-ai/dsh-tools': '0.2.0',
    'express': '4.18.0',
    'lodash': '4.17.21',
  }
  const diff = diffPackages(previous, current)
  assert.equal(diff.hasChanges, true)
  assert.deepEqual(diff.changed, [{ name: '@deepseek-ai/dsh-tools', from: '0.1.7', to: '0.2.0' }])
  assert.deepEqual(diff.added, [{ name: 'lodash', version: '4.17.21' }])
  assert.deepEqual(diff.removed, [{ name: 'left-pad', version: '1.0.0' }])

  const formatted = formatPackageDiff(diff)
  assert.match(formatted, /\+ lodash@4\.17\.21/)
  assert.match(formatted, /- left-pad@1\.0\.0/)
  assert.match(formatted, /@deepseek-ai\/dsh-tools 0\.1\.7 -> 0\.2\.0/)
})

test('diffPackages treats empty or missing previous marker as no changes (#41)', () => {
  const current = { 'a-package': '1.0.0' }
  assert.equal(diffPackages(null, current).hasChanges, false)
  assert.equal(diffPackages({}, current).hasChanges, false)
  assert.equal(diffPackages(current, current).hasChanges, false)
})

test('intentState captures structured situational context (#40)', () => {
  const intent = intentState({
    reason: 'reloading for config',
    context: {
      cwd: '/workspace/project',
      branch: 'feature-x',
      worktree: 'wt-feature-x',
      files: ['src/index.js', 'package.json'],
      tasks: ['test suite', 'git push'],
      memoryTag: 'task-40-ref',
      customKey: 'custom-value',
    },
  })
  assert.ok(intent.context)
  assert.equal(intent.context.cwd, '/workspace/project')
  assert.equal(intent.context.branch, 'feature-x')
  assert.equal(intent.context.worktree, 'wt-feature-x')
  assert.deepEqual(intent.context.files, ['src/index.js', 'package.json'])
  assert.deepEqual(intent.context.tasks, ['test suite', 'git push'])
  assert.equal(intent.context.memoryTag, 'task-40-ref')
  assert.equal(intent.context.customKey, 'custom-value')
})

test('intentState recognizes intent when only context is provided (#40)', () => {
  const intent = intentState({
    context: { branch: 'main' },
  })
  assert.equal(intent.present, true)
  assert.equal(intent.context.branch, 'main')
})

test('buildReport formats context and changes in post-boot output (#40, #41)', () => {
  const report = buildReport({
    bootAt: '2026-10-21T15:00:00.000Z',
    pid: 12345,
    checks: [{ name: 'unit', ok: true, detail: 'active' }],
    reason: 'installed plugins',
    resume: 'resume work on issue 40',
    context: {
      cwd: '/home/vadim/project',
      branch: 'feat/test',
      files: ['lib/index.js'],
      tasks: ['npm test'],
    },
    diff: {
      hasChanges: true,
      added: [{ name: 'new-pkg', version: '1.0.0' }],
      changed: [{ name: 'core-pkg', from: '0.1.0', to: '0.2.0' }],
      removed: [],
    },
  })
  assert.match(report, /- changes: core-pkg 0\.1\.0 -> 0\.2\.0, \+ new-pkg@1\.0\.0/)
  assert.match(report, /- context: branch: feat\/test, cwd: \/home\/vadim\/project, files: \[lib\/index\.js\], tasks: \[npm test\]/)
  assert.match(report, /resume: resume work on issue 40/)
})

