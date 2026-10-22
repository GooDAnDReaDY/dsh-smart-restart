import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseDuration,
  parseRestartCommandArgs,
  sessionIdOf,
  formatChatRestartStatus,
  registerChatCommand,
} from '../lib/chat-command.js'

test('parseDuration parses seconds, minutes, milliseconds, and raw numbers', () => {
  assert.equal(parseDuration('5s'), 5000)
  assert.equal(parseDuration('10sec'), 10000)
  assert.equal(parseDuration('1.5s'), 1500)
  assert.equal(parseDuration('2m'), 120000)
  assert.equal(parseDuration('1min'), 60000)
  assert.equal(parseDuration('500ms'), 500)
  assert.equal(parseDuration('3000'), 3000)
  assert.equal(parseDuration(2500), 2500)
  assert.equal(parseDuration(''), null)
  assert.equal(parseDuration(null), null)
  assert.equal(parseDuration('invalid'), null)
})

test('parseRestartCommandArgs extracts actions, flags, and reasons (#44)', () => {
  // Empty / bare
  const bare = parseRestartCommandArgs('')
  assert.equal(bare.action, 'restart')
  assert.equal(bare.reason, '')
  assert.equal(bare.confirm, false)
  assert.equal(bare.dryRun, false)

  // Subcommands
  assert.equal(parseRestartCommandArgs('cancel').action, 'cancel')
  assert.equal(parseRestartCommandArgs('cancel aborting deploy').reason, 'aborting deploy')
  assert.equal(parseRestartCommandArgs('status').action, 'status')
  assert.equal(parseRestartCommandArgs('help').action, 'help')

  // Flags: confirm
  assert.equal(parseRestartCommandArgs('--confirm').confirm, true)
  assert.equal(parseRestartCommandArgs('-y').confirm, true)
  assert.equal(parseRestartCommandArgs('-c').confirm, true)

  // Flags: dry-run, force
  assert.equal(parseRestartCommandArgs('--dry-run').dryRun, true)
  assert.equal(parseRestartCommandArgs('-n').dryRun, true)
  assert.equal(parseRestartCommandArgs('--force').force, true)
  assert.equal(parseRestartCommandArgs('-f').force, true)

  // Flags: delay
  assert.equal(parseRestartCommandArgs('--delay 10s').delayMs, 10000)
  assert.equal(parseRestartCommandArgs('-d 2m').delayMs, 120000)
  assert.equal(parseRestartCommandArgs('--delay=3500').delayMs, 3500)

  // Flags: reason and positional text
  const withReasonFlag = parseRestartCommandArgs('--reason "Updating plugin" -y')
  assert.equal(withReasonFlag.reason, 'Updating plugin')
  assert.equal(withReasonFlag.confirm, true)

  const withShortReasonFlag = parseRestartCommandArgs('-r="Config reload" --dry-run')
  assert.equal(withShortReasonFlag.reason, 'Config reload')
  assert.equal(withShortReasonFlag.dryRun, true)

  const positional = parseRestartCommandArgs('Quick reboot after test run')
  assert.equal(positional.action, 'restart')
  assert.equal(positional.reason, 'Quick reboot after test run')

  // Combined flags
  const combined = parseRestartCommandArgs('-y -f --delay 5s Routine maintenance')
  assert.equal(combined.action, 'restart')
  assert.equal(combined.confirm, true)
  assert.equal(combined.force, true)
  assert.equal(combined.delayMs, 5000)
  assert.equal(combined.reason, 'Routine maintenance')
})

test('sessionIdOf resolves session id from various structures (#44)', () => {
  assert.equal(sessionIdOf({ sessionId: 'sess-1' }), 'sess-1')
  assert.equal(sessionIdOf({ session: { id: 'sess-2' } }), 'sess-2')
  assert.equal(sessionIdOf({ session: { header: { id: 'sess-3' } } }), 'sess-3')
  assert.equal(sessionIdOf({ conversationId: 'conv-4' }), 'conv-4')
  assert.equal(sessionIdOf({ data: { sessionId: 'data-5' } }), 'data-5')
  assert.equal(sessionIdOf(null), '')
  assert.equal(sessionIdOf({}), '')
})

test('formatChatRestartStatus produces formatted markdown output (#44)', () => {
  const status = {
    verdict: 'healthy',
    unit: 'dsh-web.service',
    port: 5140,
    guard: { count: 1, max: 3, allowed: true, windowMs: 900000 },
    activeRestart: { at: Date.now() + 5000, delayMs: 5000, reason: 'test' },
  }
  const text = formatChatRestartStatus(status)
  assert.ok(text.includes('Healthy'), 'must include verdict')
  assert.ok(text.includes('dsh-web.service'), 'must include unit')
  assert.ok(text.includes('5140'), 'must include port')
  assert.ok(text.includes('test'), 'must include pending restart reason')
})

test('registerChatCommand wires slash commands and middleware interceptor (#44)', async () => {
  let registeredCommand = null
  let registeredMiddleware = null
  let pendingRestart = null
  let restartPipelineArgs = null

  const mockCtx = {
    inject(deps, factory) {
      if (deps.includes('commands')) {
        factory({
          commands: {
            register: (def) => {
              registeredCommand = def
              return () => { registeredCommand = null }
            },
          },
        })
      }
    },
    middleware(fn) {
      registeredMiddleware = fn
      return () => { registeredMiddleware = null }
    },
    logger: { warn: () => {}, debug: () => {} },
  }

  const cleanup = registerChatCommand(mockCtx, {
    executeRestartPipeline: async (options) => {
      restartPipelineArgs = options
      if (options.dryRun) {
        return '✅ Restart Preflight PASSED (dry-run)'
      }
      if (!options.confirm) {
        return '⚠️ Confirm DeepSeek Harness Restart: send /restart -y'
      }
      pendingRestart = { at: Date.now() + 5000, reason: options.reason }
      return `⏳ Restarting DeepSeek Harness in 5s (reason: ${options.reason})`
    },
    cancelPendingRestart: (source) => {
      if (pendingRestart) {
        pendingRestart = null
        return { ok: true, cancelled: true, source }
      }
      return { ok: false, cancelled: false }
    },
    getRestartStatus: async () => ({
      verdict: 'healthy',
      unit: 'dsh-web.service',
      port: 5173,
      guard: { count: 0, max: 3, windowMs: 900000 },
      activeRestart: pendingRestart,
    }),
    live: () => ({ enabled: true, requireApproval: true }),
  })

  assert.ok(registeredCommand, 'must register command via commands service')
  assert.equal(registeredCommand.name, 'restart')
  assert.ok(registeredMiddleware, 'must register fallback chat middleware')

  // 1. Command handler: help
  const helpReply = await registeredCommand.handler({ rawInput: 'help' })
  assert.ok(helpReply.includes('DeepSeek Harness Restart Commands'), 'help text returned')

  // 2. Command handler: status
  const statusReply = await registeredCommand.handler({ rawInput: 'status' })
  assert.ok(statusReply.includes('Healthy'), 'status text returned')

  // 3. Command handler: cancel when nothing scheduled
  const cancelNoneReply = await registeredCommand.handler({ rawInput: 'cancel' })
  assert.ok(cancelNoneReply.includes('No pending restart scheduled'), 'cancel none returned')

  // 4. Command handler: dry-run
  const dryRunReply = await registeredCommand.handler({ rawInput: '--dry-run' })
  assert.ok(dryRunReply.includes('dry-run'), 'dry-run reply returned')
  assert.equal(restartPipelineArgs.dryRun, true)

  // 5. Command handler: require confirmation
  const unconfirmedReply = await registeredCommand.handler({ rawInput: '' })
  assert.ok(unconfirmedReply.includes('Confirm DeepSeek Harness Restart'), 'confirmation prompt returned')
  assert.equal(pendingRestart, null)

  // 6. Command handler: confirmed restart
  const confirmedReply = await registeredCommand.handler({
    rawInput: '-y --reason "Maintenance" --delay 10s',
    sessionId: 'session-chat-99',
  })
  assert.ok(confirmedReply.includes('Restarting DeepSeek Harness in 5s'), 'acknowledgement returned')
  assert.equal(restartPipelineArgs.confirm, true)
  assert.equal(restartPipelineArgs.sessionId, 'session-chat-99')
  assert.equal(restartPipelineArgs.reason, 'Maintenance')
  assert.ok(pendingRestart, 'pending restart scheduled')

  // 7. Command handler: cancel scheduled restart
  const cancelSuccessReply = await registeredCommand.handler({ rawInput: 'cancel' })
  assert.ok(cancelSuccessReply.includes('Pending restart cancelled'), 'cancel success returned')
  assert.equal(pendingRestart, null)

  // 8. Middleware interceptor: normal chat message -> calls next()
  let nextCalled = false
  const normalSession = { content: 'hello how are you?', send: async () => {} }
  await registeredMiddleware(normalSession, async () => { nextCalled = true })
  assert.equal(nextCalled, true, 'normal message must pass through to next()')

  // 9. Middleware interceptor: /restart message -> intercepts, replies via session.send, does NOT call next()
  let interceptedReply = null
  let restartNextCalled = false
  const commandSession = {
    content: '/restart status',
    id: 'chat-sess-1',
    send: async (msg) => { interceptedReply = msg },
  }
  await registeredMiddleware(commandSession, async () => { restartNextCalled = true })
  assert.equal(restartNextCalled, false, 'command must NOT call next()')
  assert.ok(interceptedReply.includes('Healthy'), 'command reply delivered via session.send')

  // 10. Cleanup
  cleanup()
  assert.equal(registeredCommand, null)
  assert.equal(registeredMiddleware, null)
})
