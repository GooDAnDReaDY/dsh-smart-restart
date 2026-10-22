// chat-command.js — Chat slash command and message interceptor for safe DSH restart (#44)

/**
 * Parse human duration string into milliseconds.
 *
 * @param {string|number} val
 * @returns {number|null}
 */
export function parseDuration(val) {
  if (typeof val === 'number') return Math.max(0, val)
  if (!val) return null
  const s = String(val).trim().toLowerCase()
  if (/^\d+$/.test(s)) return parseInt(s, 10)
  if (/^(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?$/.test(s)) {
    return Math.round(parseFloat(RegExp.$1) * 1000)
  }
  if (/^(\d+(?:\.\d+)?)\s*m(?:in(?:utes?)?)?$/.test(s)) {
    return Math.round(parseFloat(RegExp.$1) * 60000)
  }
  if (/^(\d+(?:\.\d+)?)\s*ms$/.test(s)) {
    return Math.round(parseFloat(RegExp.$1))
  }
  const n = parseFloat(s)
  return isNaN(n) ? null : Math.round(n * 1000)
}

/**
 * Parse raw arguments for /restart chat command.
 *
 * @param {string} rawInput
 * @returns {{
 *   action: 'restart'|'cancel'|'status'|'help',
 *   reason: string,
 *   delayMs: number|null,
 *   confirm: boolean,
 *   dryRun: boolean,
 *   force: boolean
 * }}
 */
export function parseRestartCommandArgs(rawInput) {
  const str = String(rawInput || '').trim()
  if (!str) {
    return {
      action: 'restart',
      reason: '',
      delayMs: null,
      confirm: false,
      dryRun: false,
      force: false,
    }
  }

  const tokens = []
  const re = /[^\s"']+|"([^"]*)"|'([^']*)'/g
  let match
  while ((match = re.exec(str)) !== null) {
    tokens.push(match[1] || match[2] || match[0])
  }

  const first = String(tokens[0] || '').toLowerCase()
  if (first === 'cancel' || first === 'abort') {
    return {
      action: 'cancel',
      reason: tokens.slice(1).join(' ').trim(),
      delayMs: null,
      confirm: false,
      dryRun: false,
      force: false,
    }
  }
  if (first === 'status' || first === 'check') {
    return {
      action: 'status',
      reason: '',
      delayMs: null,
      confirm: false,
      dryRun: false,
      force: false,
    }
  }
  if (first === 'help' || first === '?') {
    return {
      action: 'help',
      reason: '',
      delayMs: null,
      confirm: false,
      dryRun: false,
      force: false,
    }
  }

  let confirm = false
  let dryRun = false
  let force = false
  let delayMs = null
  let reason = ''
  const words = []

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === '--confirm' || t === '-y' || t === '-c') {
      confirm = true
    } else if (t === '--dry-run' || t === '-n') {
      dryRun = true
    } else if (t === '--force' || t === '-f') {
      force = true
    } else if (t === '--cancel') {
      return {
        action: 'cancel',
        reason: tokens.slice(i + 1).join(' ').trim(),
        delayMs: null,
        confirm: false,
        dryRun: false,
        force: false,
      }
    } else if (t === '--status') {
      return {
        action: 'status',
        reason: '',
        delayMs: null,
        confirm: false,
        dryRun: false,
        force: false,
      }
    } else if (t === '--help') {
      return {
        action: 'help',
        reason: '',
        delayMs: null,
        confirm: false,
        dryRun: false,
        force: false,
      }
    } else if (t.startsWith('--reason=') || t.startsWith('-r=')) {
      reason = t.slice(t.indexOf('=') + 1)
    } else if (t === '--reason' || t === '-r') {
      if (i + 1 < tokens.length) {
        reason = tokens[++i]
      }
    } else if (t.startsWith('--delay=') || t.startsWith('-d=')) {
      const val = t.slice(t.indexOf('=') + 1)
      delayMs = parseDuration(val)
    } else if (t === '--delay' || t === '-d') {
      if (i + 1 < tokens.length) {
        delayMs = parseDuration(tokens[++i])
      }
    } else {
      words.push(t)
    }
  }

  if (!reason && words.length > 0) {
    reason = words.join(' ')
  }

  return {
    action: 'restart',
    reason,
    delayMs,
    confirm,
    dryRun,
    force,
  }
}

/**
 * Extract session ID from invocation or session object.
 *
 * @param {any} invocationOrSession
 * @param {string} [fallback='']
 * @returns {string}
 */
export function sessionIdOf(invocationOrSession, fallback = '') {
  if (!invocationOrSession) return fallback
  try {
    if (typeof invocationOrSession === 'string') return invocationOrSession
    if (invocationOrSession.sessionId) return String(invocationOrSession.sessionId)
    if (invocationOrSession.session) {
      const s = invocationOrSession.session
      return String(s.id || s.header?.id || s.sessionId || fallback)
    }
    if (invocationOrSession.data?.sessionId) return String(invocationOrSession.data.sessionId)
    if (invocationOrSession.conversationId) return String(invocationOrSession.conversationId)
    if (invocationOrSession.id) return String(invocationOrSession.id)
    if (invocationOrSession.agent?.session) {
      const s = invocationOrSession.agent.session
      return String(s.id || s.header?.id || fallback)
    }
  } catch (err) {
    // Non-fatal extraction fallback
  }
  return fallback
}

/**
 * Format markdown status summary for chat command.
 *
 * @param {object} status
 * @returns {string}
 */
export function formatChatRestartStatus(status = {}) {
  const verdict = String(status.verdict || 'unknown').toLowerCase()
  const verdictIcon = verdict === 'healthy' ? '🟢' : (verdict === 'degraded' ? '🟡' : '🔴')
  const verdictLabel = verdict.charAt(0).toUpperCase() + verdict.slice(1)

  const lines = [
    `📊 **DSH Health Status**: ${verdictIcon} ${verdictLabel}`,
    `- **Unit**: \`${status.unit || 'dsh-web.service'}\``,
    `- **Active Port**: \`${status.port || 'unknown'}\``,
  ]

  if (status.guard) {
    const windowMin = Math.round((status.guard.windowMs || 900000) / 60000)
    lines.push(`- **Restart Budget**: ${status.guard.count || 0}/${status.guard.max || 3} in past ${windowMin} min`)
  }

  if (status.activeRestart) {
    const delaySec = Math.round((status.activeRestart.delayMs || 0) / 1000)
    lines.push(`- ⏳ **Restart Scheduled**: in ${delaySec}s (reason: *${status.activeRestart.reason || 'unspecified'}*)`)
    lines.push(`  *Send \`/restart cancel\` to abort.*`)
  } else {
    lines.push(`- **Scheduled Restart**: none`)
  }

  return lines.join('\n')
}

/**
 * Register chat command handler and middleware for DSH restart (#44).
 *
 * @param {object} ctx - Cordis context
 * @param {object} deps - Injected dependencies from lib/index.js
 * @returns {() => void} Cleanup function
 */
export function registerChatCommand(ctx, deps) {
  const {
    executeRestartPipeline,
    cancelPendingRestart,
    getRestartStatus,
    live,
  } = deps

  const handleCommand = async (rawInput, invocationOrSession) => {
    try {
      const parsed = parseRestartCommandArgs(rawInput)

      if (parsed.action === 'help') {
        return [
          'ℹ️ **DeepSeek Harness Restart Commands**:',
          '- `/restart` — Safely restart DSH with preflight health validation',
          '- `/restart --confirm` (or `-y`) — Skip confirmation prompt',
          '- `/restart --reason="..."` — Set custom restart reason',
          '- `/restart --delay=10s` — Custom grace period before restart',
          '- `/restart --dry-run` — Verify preflight checks without restarting',
          '- `/restart cancel` — Cancel scheduled restart',
          '- `/restart status` — Check service health and restart budget',
        ].join('\n')
      }

      if (parsed.action === 'status') {
        const st = typeof getRestartStatus === 'function' ? await getRestartStatus() : {}
        return formatChatRestartStatus(st)
      }

      if (parsed.action === 'cancel') {
        const res = typeof cancelPendingRestart === 'function'
          ? cancelPendingRestart(parsed.reason ? `chat: ${parsed.reason}` : 'chat command')
          : { ok: false, cancelled: false }
        if (res.cancelled) {
          return '✅ **Pending restart cancelled.** Intent cleaned up and scheduled timer stopped.'
        }
        return 'ℹ️ **No pending restart scheduled.** Nothing to cancel.'
      }

      // Action: restart
      const targetSessionId = sessionIdOf(invocationOrSession)
      return await executeRestartPipeline({
        confirm: parsed.confirm,
        dryRun: parsed.dryRun,
        force: parsed.force,
        delayMs: parsed.delayMs,
        reason: parsed.reason,
        sessionId: targetSessionId,
        source: 'chat-command',
      })
    } catch (err) {
      ctx.logger?.warn?.('[smart-restart-guard] chat command error:', err && err.message)
      return `❌ **Restart Command Error**: ${err?.message || err}`
    }
  }

  const disposers = []

  // 1. Dynamic injection into @deepseek-ai/dsh-commands registry
  if (typeof ctx.inject === 'function') {
    ctx.inject(['commands'], (cmdCtx) => {
      const commands = cmdCtx.commands
      if (typeof commands?.register !== 'function') return

      const unregister = commands.register({
        definitionId: '@goodandready/dsh-smart-restart',
        name: 'restart',
        description: 'Safely restart DeepSeek Harness (/restart [--reason="..."] [--delay=5s] [--dry-run] [--confirm] [cancel|status])',
        input: { hint: '[--reason="..."] [--delay=5s] [--dry-run] [--confirm] [cancel|status]' },
        handler: async (invocation) => {
          const raw = invocation?.rawInput || invocation?.text || (typeof invocation === 'string' ? invocation : '')
          return await handleCommand(raw, invocation)
        },
        execute: async (rawArgs, invocation) => {
          return await handleCommand(rawArgs, invocation)
        },
      })

      if (typeof unregister === 'function') disposers.push(unregister)
      else if (unregister && typeof unregister.dispose === 'function') disposers.push(() => unregister.dispose())
    })
  }

  // 2. Chat middleware fallback to intercept /restart and !restart in text messages
  if (typeof ctx.middleware === 'function') {
    const removeMiddleware = ctx.middleware(async (session, next) => {
      const content = session && typeof session.content === 'string' ? session.content.trim() : ''
      if (!content) return next()

      const isRestart = /^[!/](?:dsh-)?restart(?:\s+.*)?$/i.test(content)
      const isCancel = /^[!/](?:cancel|abort)-restart(?:\s+.*)?$/i.test(content)

      if (!isRestart && !isCancel) return next()

      let rawArgs = ''
      if (isCancel) {
        rawArgs = 'cancel ' + content.replace(/^[!/](?:cancel|abort)-restart\s*/i, '')
      } else {
        rawArgs = content.replace(/^[!/](?:dsh-)?restart\s*/i, '')
      }

      const reply = await handleCommand(rawArgs, session)
      if (reply) {
        if (typeof session.send === 'function') {
          await session.send(reply)
        } else if (typeof session.postMessage === 'function') {
          await session.postMessage(reply)
        }
      }
      // Do not call next() so the agent does not receive the command as an LLM turn
      return
    })

    if (typeof removeMiddleware === 'function') disposers.push(removeMiddleware)
  }

  return () => {
    for (const d of disposers) {
      try {
        d()
      } catch (err) {
        ctx.logger?.debug?.('[smart-restart-guard] chat command dispose error:', err && err.message)
      }
    }
    disposers.length = 0
  }
}
