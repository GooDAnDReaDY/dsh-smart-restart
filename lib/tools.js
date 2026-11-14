// Agent tools registration for dsh-smart-restart (#36, #38, #39, #40, #56).

import { defineTool } from '@deepseek-ai/dsh-tools'

const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true }

export function registerTools(ctx, {
  live,
  cleanPayload,
  readJson,
  writeJson,
  unitName,
  previousMarker,
  getActiveRestart,
  setActiveRestart,
  loopGuard,
  cancelPendingRestart,
  callerSession,
  runPreflight,
  formatPreflightFailureReport,
  deliverTo,
  drainActiveAgents,
  getAgents,
  clampDelayMs,
  performRestart,
  activeTimers,
  safeGet,
  logger,
  disposers,
}) {
  function tool(toolName, description, parameters, execute) {
    const definition = defineTool({
      name: toolName,
      description,
      parameters,
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
      },
      execute,
    })
    try {
      const reg = ctx.tools.register(definition)
      if (typeof reg === 'function') disposers.push(reg)
      else if (reg && typeof reg.dispose === 'function') disposers.push(() => reg.dispose())
      return reg
    } catch (err) {
      if (!/is already registered/.test(String((err && err.message) || err))) throw err
      logger.warn?.(`[smart-restart-guard] tool "${toolName}" is already provided by another plugin; skipping it`)
      return null
    }
  }

  if (live().toolEnabled === false) return

  tool(
    'dsh_restart_status',
    'Read-only view of the restart guard: the last boot and its downtime, the last health report, a pending intent (what to continue after a restart), diff of installed packages, pending scheduled restart, and how many restarts happened inside the window.',
    {},
    async () => {
      const activeRestart = getActiveRestart()
      return cleanPayload({
        enabled: live().enabled !== false,
        mode: live().restartMode,
        unit: unitName(),
        unitSource: live().unit ? 'settings' : 'detected from /proc/self/cgroup',
        lastBoot: readJson('marker.json'),
        previousBoot: previousMarker,
        lastReport: readJson('last-report.json'),
        lastDiff: readJson('last-report.json')?.diff || null,
        pendingIntent: readJson('intent.json'),
        scheduled: activeRestart ? {
          scheduledAt: activeRestart.scheduledAt,
          at: activeRestart.at,
          delayMs: activeRestart.delayMs,
          remainingMs: Math.max(0, activeRestart.at - Date.now()),
          reason: activeRestart.reason,
        } : null,
        restartsInWindow: loopGuard(readJson('history.json') || [], { max: live().maxRestarts, windowMs: live().windowMs }),
      })
    },
  )

  tool(
    'dsh_restart_cancel',
    'Cancel a pending scheduled restart before its delay expires. Clears the timer, deletes intent.json, and prevents the harness from restarting.',
    {},
    async () => cleanPayload(cancelPendingRestart('agent-tool')),
  )

  tool(
    'dsh_restart',
    'Restart the harness and have it verified: the guard records why and what to continue, ends the process (systemd brings the service back, no privileges needed) or runs systemctl restart, and after the boot sends this session a health report with the verdict, package diff, and the context.',
    {
      reason: { type: 'string', description: 'Why the restart is needed; it is recorded and shown in the report.' },
      resume: { type: 'string', description: 'What to continue after the boot; it comes back in the report.' },
      context: {
        type: 'object',
        description: 'Structured situational context for resuming work after restart (cwd, branch, worktree, files, tasks, memoryTag).',
        additionalProperties: true,
      },
      delayMs: { type: 'number', description: 'How long to wait before the process ends (default from settings).' },
      confirm: { type: 'boolean', description: 'Must be true: the restart ends this process.' },
      dryRun: { type: 'boolean', description: 'Run preflight validation checks without initiating restart.' },
    },
    async (args, execution) => {
      if (args.confirm !== true && args.dryRun !== true) return cleanPayload({ ok: false, error: 'refusing to restart without confirm: true' })
      if (live().enabled === false) return cleanPayload({ ok: false, error: 'the restart guard is disabled in settings' })
      if (!args.dryRun && live().requireApproval !== false && !execution?.approved) {
        const approval = safeGet(ctx, 'approval')
        if (approval && typeof approval.request === 'function') {
          const outcome = await approval.request({
            agent: execution?.agent,
            toolName: 'dsh_restart',
            callId: execution?.callId,
            reason: args.reason || 'DeepSeek Harness restart requested',
            signal: execution?.signal,
          })
          if (outcome !== 'allowed-once') {
            return cleanPayload({
              ok: false,
              error: `restart was rejected or cancelled by operator (outcome: ${outcome || 'denied'})`,
            })
          }
        }
      }
      if (!args.dryRun) {
        const guard = loopGuard(readJson('history.json') || [], { max: live().maxRestarts, windowMs: live().windowMs })
        if (!guard.allowed) {
          return cleanPayload({
            ok: false,
            error: `refusing: ${guard.count} restart(s) inside the window (${Math.round(guard.windowMs / 60000)} min) — fix the cause first`,
            restartsInWindow: guard,
          })
        }
      }
      const unit = unitName()
      const mode = live().restartMode === 'systemctl' ? 'systemctl' : 'kill'
      if (mode === 'systemctl' && !unit) return cleanPayload({ ok: false, error: 'no systemd unit: set unit in the settings or use restartMode "kill"' })

      const sessionId = callerSession(execution)

      // Preflight validation (#38)
      const preflight = await runPreflight(unit, mode)
      if (!preflight.ok) {
        const failureMsg = formatPreflightFailureReport(preflight)
        if (sessionId) deliverTo(sessionId, failureMsg)
        return cleanPayload({
          ok: false,
          error: `preflight validation failed: ${preflight.error}`,
          preflight,
        })
      }

      if (args.dryRun === true) {
        return cleanPayload({
          ok: true,
          dryRun: true,
          preflight,
          note: 'preflight validation passed; restart simulated',
        })
      }

      // Graceful drain of active agent tasks (#39)
      const drain = await drainActiveAgents(
        getAgents,
        sessionId,
        live().drainTimeoutMs ?? 15000,
        250,
      )
      if (!drain.drained) {
        logger.warn?.(`[smart-restart-guard] drain timed out with ${drain.activeCount} active agent(s) remaining after ${drain.waitedMs}ms; proceeding with restart`)
      }

      // Rich Situational Snapshot (#40)
      let context = null
      if (args.context && typeof args.context === 'object') {
        context = cleanPayload(args.context)
        if (!context.cwd && typeof process.cwd === 'function') {
          try {
            context.cwd = process.cwd()
          } catch {
            // best effort fallback
          }
        }
      }

      const delay = clampDelayMs(args.delayMs || live().delayMs, 3000)
      writeJson('intent.json', {
        at: new Date().toISOString(),
        sessionId,
        reason: String(args.reason || ''),
        resume: String(args.resume || ''),
        context: context || undefined,
        mode,
        unit,
        delayMs: delay,
        drain: {
          drained: drain.drained,
          waitedMs: drain.waitedMs,
          activeCount: drain.activeCount,
        },
      })
      const scheduledRecord = {
        scheduledAt: Date.now(),
        at: Date.now() + delay,
        delayMs: delay,
        reason: String(args.reason || ''),
        sessionId,
        mode,
        unit,
        timeoutId: null,
      }

      const timer = setTimeout(() => {
        activeTimers.delete(timer)
        setActiveRestart(null)
        performRestart(mode, unit)
      }, delay)
      activeTimers.add(timer)
      scheduledRecord.timeoutId = timer
      setActiveRestart(scheduledRecord)
      return cleanPayload({
        ok: true,
        restarting: true,
        mode,
        unit: unit || '(none)',
        delayMs: delay,
        sessionId,
        context: context || undefined,
        preflight: { verdict: 'passed' },
        drain: {
          drained: drain.drained,
          waitedMs: drain.waitedMs,
        },
        note: 'the report will come back to this session after the boot',
      })
    },
  )
}
