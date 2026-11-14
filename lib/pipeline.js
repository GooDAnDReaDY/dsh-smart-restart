// Chat command restart pipeline execution (#44, #56).

export async function executeChatRestartPipeline(options = {}, deps = {}) {
  const {
    confirm,
    dryRun,
    force,
    delayMs,
    reason,
    sessionId,
    source = 'chat-command',
  } = options

  const {
    live,
    unitName,
    runPreflight,
    formatPreflightFailureReport,
    loopGuard,
    readJson,
    writeJson,
    drainActiveAgents,
    getAgents,
    logger,
    cancelPendingRestart,
    clampDelayMs,
    activeTimers,
    setActiveRestart,
    performRestart,
  } = deps

  if (live().enabled === false) {
    return '⚠️ **DSH Restart Guard is disabled in settings.**'
  }

  const unit = unitName()
  const mode = live().restartMode === 'systemctl' ? 'systemctl' : 'kill'
  if (mode === 'systemctl' && !unit) {
    return '❌ **No systemd unit configured.** Please set unit in plugin settings or use restartMode "kill".'
  }

  // Preflight validation (#38)
  const preflight = await runPreflight(unit, mode)
  if (!preflight.ok) {
    const failureMsg = formatPreflightFailureReport(preflight)
    return `❌ **Restart Preflight Failed**:\n${failureMsg}\n*Aborting restart to protect service.*`.trim()
  }

  if (dryRun) {
    return [
      '✅ **Restart Preflight PASSED** (dry-run):',
      `- **Unit**: \`${unit || 'process'}\``,
      '- **Config YAML**: valid',
      '- **Port conflicts**: none detected',
      'Simulation complete. No changes were made and service was not restarted.',
    ].join('\n')
  }

  // Loop guard check
  const guard = loopGuard(readJson('history.json') || [], { max: live().maxRestarts, windowMs: live().windowMs })
  if (!guard.allowed) {
    const winMin = Math.round(guard.windowMs / 60000)
    return `❌ **Restart Refused**: ${guard.count} restarts recorded within the ${winMin} min window. Fix the underlying issue first.`
  }

  // Confirmation / approval check
  if (live().requireApproval !== false && !confirm) {
    const delayText = delayMs != null ? `${Math.round(delayMs / 1000)}s` : '5s'
    return [
      '⚠️ **Confirm DeepSeek Harness Restart**',
      `- **Reason**: *${reason || 'Manual chat restart'}*`,
      `- **Delay**: ${delayText}`,
      `- **Unit**: \`${unit || 'process'}\``,
      '',
      'To confirm, send:',
      '> `/restart --confirm` (or `/restart -y`)',
      'Or `/restart cancel` to dismiss.',
    ].join('\n')
  }

  // Drain active agents if not force
  if (!force) {
    const drain = await drainActiveAgents(
      getAgents,
      sessionId,
      live().drainTimeoutMs ?? 15000,
      250,
    )
    if (!drain.drained) {
      logger.warn?.(`[smart-restart-guard] drain timed out with ${drain.activeCount} active agent(s); proceeding with restart`)
    }
  }

  // Cancel any existing pending timer before scheduling new one
  cancelPendingRestart('superseded by new chat restart command')

  const delay = clampDelayMs(delayMs != null ? delayMs : 5000, 1000)
  const restartAt = Date.now() + delay
  const effectiveReason = reason || 'Manual chat restart'

  writeJson('intent.json', {
    intent: 'restart',
    at: new Date(restartAt).toISOString(),
    delayMs: delay,
    reason: effectiveReason,
    resume: 'Continue conversation.',
    sessionId: sessionId || '',
    unit,
    mode,
    source,
    context: {
      cwd: typeof process.cwd === 'function' ? process.cwd() : '',
      source,
      sessionId: sessionId || '',
      reason: effectiveReason,
    },
  })

  const scheduledRecord = {
    scheduledAt: Date.now(),
    at: restartAt,
    delayMs: delay,
    reason: effectiveReason,
    mode,
    unit,
    sessionId: sessionId || '',
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

  const delaySec = Math.round(delay / 1000)
  return [
    '⏳ **Restarting DeepSeek Harness...**',
    `- **Reason**: *${effectiveReason}*`,
    `- **Scheduled in**: ${delaySec} second${delaySec === 1 ? '' : 's'}`,
    '- **Target**: report will be delivered back to this chat after reboot.',
    '',
    '*Send `/restart cancel` or use the WebUI countdown banner to abort.*',
  ].join('\n')
}
