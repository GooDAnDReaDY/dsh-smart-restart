// dsh-restart-guard — browser half.
//
// One settings card in the plugin list, the same seat every other plugin of ours uses, plus the
// live seats (plugins.item and plugins.row.config). Every user-visible string lives in the
// locale registry under NS with an English source and a Chinese translation; Russian comes from
// dsh-russian-lang, never from this file.
//
// Not ESM: the shell loads this file as a lazy CJS factory. No import, no JSX.

window.__ModuleLoader__.load({
  id: '@goodandready/dsh-smart-restart',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react') || {}
    const NS = 'goodandready-smart-restart'

    const en = {
      title: 'Restart guard',
      summary: 'Verified restart: the boot is checked, the verdict comes back to the session that asked, and the work resumes.',
      enabled: 'Enabled',
      enabledHint: 'Register the tools and check every boot.',
      restartMode: 'Restart mode',
      restartModeHint: '"kill" ends the process and lets systemd restart it (no privileges); "systemctl" runs systemctl restart <unit>.',
      unit: 'systemd unit',
      unitHint: 'Empty detects the unit from the process cgroup.',
      delayMs: 'Delay before restart (ms)',
      delayMsHint: 'Long enough for the answer to reach the caller first.',
      drainTimeoutMs: 'Graceful drain timeout (ms)',
      drainTimeoutMsHint: 'Time to wait for active agent tasks to complete before restarting (default 15000).',
      target: 'Where the report goes',
      targetHint: 'requester, primary, or a session id.',
      stateDir: 'State directory',
      stateDirHint: 'Under $DSH_HOME: boot marker, intent, last report, history.',
      maxRestarts: 'Restart limit',
      maxRestartsHint: 'Refuse a restart after this many inside the window.',
      windowMs: 'Window (ms)',
      windowMsHint: 'The loop-guard window.',
      expectTools: 'Required tools (comma separated)',
      expectToolsHint: 'A missing tool makes the boot verdict degraded.',
      toolEnabled: 'Expose the tools',
      toolEnabledHint: 'dsh_restart and dsh_restart_status.',
      requireApproval: 'Require operator approval',
      requireApprovalHint: 'Prompt the human operator before executing a harness restart.',
      save: 'Save',
      saved: 'Saved',
      invalid: 'Enter a number, not text.',
      unavailable: 'The settings service is unavailable, so this form cannot be saved right now.',
      loading: 'Loading settings...',
      healthVerdict: 'Health status',
      healthOk: 'Healthy',
      healthDegraded: 'Degraded',
      healthLoop: 'Loop guard active',
      historyTitle: 'Recent restarts',
      historyEmpty: 'No restarts recorded yet.',
      downtime: 'Downtime',
      safeRestart: 'Safe restart',
      safeRestartDesc: 'Validate configuration and restart the harness with health check verification.',
      confirmRestart: 'Confirm restart',
      cancelRestart: 'Cancel restart',
      cancel: 'Cancel',
      restartDelaySec: 'Grace period (sec)',
      restartReasonPrompt: 'Reason for restart',
      restartingIn: 'Restarting in {seconds}s...',
      restartCancelled: 'Restart was cancelled.',
      preflightPassed: 'Preflight checks passed.',
      preflightFailed: 'Preflight validation failed:',
      reasonPlaceholder: 'Reason for restart (e.g. updated plugin)',
      time: 'Time',
      verdict: 'Verdict',
      reason: 'Reason',
    }

    const zh = {
      title: '重启守卫',
      summary: '可验证的重启：启动后检查健康，把结论送回发起会话，并接回未完成的工作。',
      enabled: '启用',
      enabledHint: '注册工具并在每次启动后检查。',
      restartMode: '重启方式',
      restartModeHint: '"kill" 结束进程由 systemd 拉起（无需权限）；"systemctl" 执行 systemctl restart <unit>。',
      unit: 'systemd 单元',
      unitHint: '留空则从进程 cgroup 自动识别。',
      delayMs: '重启前延迟（毫秒）',
      delayMsHint: '足够让回答先送到调用方。',
      drainTimeoutMs: '优雅排空超时（毫秒）',
      drainTimeoutMsHint: '重启前等待正在运行的任务完成的超时时间（默认 15000 毫秒）。',
      target: '报告发往',
      targetHint: 'requester、primary 或会话 id。',
      stateDir: '状态目录',
      stateDirHint: '位于 $DSH_HOME 下：启动标记、意图、上次报告、历史。',
      maxRestarts: '重启上限',
      maxRestartsHint: '窗口内超过该次数即拒绝重启。',
      windowMs: '窗口（毫秒）',
      windowMsHint: '循环保护窗口。',
      expectTools: '必需工具（逗号分隔）',
      expectToolsHint: '缺少工具会让启动结论变为 degraded。',
      toolEnabled: '暴露工具',
      toolEnabledHint: 'dsh_restart 与 dsh_restart_status。',
      requireApproval: '需要操作员审批',
      requireApprovalHint: '在执行重启前向人工操作员弹出确认审批。',
      save: '保存',
      saved: '已保存',
      invalid: '请输入数字，而不是文本。',
      unavailable: '设置服务不可用，当前表单无法保存。',
      loading: '加载设置中...',
      healthVerdict: '健康状态',
      healthOk: '健康',
      healthDegraded: '降级',
      healthLoop: '防循环保护生效中',
      historyTitle: '最近重启记录',
      historyEmpty: '暂无重启记录。',
      downtime: '停机时间',
      safeRestart: '安全重启',
      safeRestartDesc: '验证配置并重启 Harness，并在启动后执行健康检查。',
      confirmRestart: '确认重启',
      cancelRestart: '取消重启',
      cancel: '取消',
      restartDelaySec: '缓冲等待时间（秒）',
      restartReasonPrompt: '重启原因',
      restartingIn: '将在 {seconds} 秒后重启...',
      restartCancelled: '重启已取消。',
      preflightPassed: '预检通过。',
      preflightFailed: '预检失败：',
      reasonPlaceholder: '重启原因（如：更新插件）',
      time: '时间',
      verdict: '结论',
      reason: '原因',
    }

    let ChevronIcon = null
    try {
      const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
      ChevronIcon = primitives && primitives.IconChevronDownOutline14
    } catch (_) {
      ChevronIcon = null
    }

    function FallbackChevron(props) {
      return React.createElement(
        'svg',
        {
          width: 14,
          height: 14,
          viewBox: '0 0 14 14',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          className: props && props.className,
          style: props && props.style,
        },
        React.createElement('path', {
          d: 'M3.5 5.25L7 8.75L10.5 5.25',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        })
      )
    }

    const Chevron = ChevronIcon || FallbackChevron

    const CSS = [
      '.sr-card{display:flex;flex-direction:column;gap:10px;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.sr-head{display:flex;align-items:center;gap:8px;cursor:pointer;background:0 0;border:0;padding:0;font:inherit;color:inherit;text-align:left}',
      '.sr-title{font-weight:600}',
      '.sr-chev{width:14px;height:14px;color:var(--dsw-alias-label-tertiary);transition:transform .2s ease;flex-shrink:0;display:inline-flex;align-items:center;justify-content:center}',
      '.sr-chev[data-open="true"]{transform:rotate(90deg)}',
      '.sr-summary{color:var(--dsw-alias-label-tertiary);font-size:12px}',
      '.sr-body{display:flex;flex-direction:column;gap:12px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px}',
      '.sr-field{display:flex;flex-direction:column;gap:3px}',
      '.sr-label{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.sr-hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.sr-input,.sr-select{height:28px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);padding:0 8px;font:inherit}',
      '.sr-foot{display:flex;align-items:center;gap:8px}',
      '.sr-btn{appearance:none;font:inherit;font-size:12px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:0 0;color:var(--dsw-alias-label-primary);border-radius:8px;padding:4px 10px}',
      '.sr-note{font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.sr-bad{color:var(--dsw-alias-state-error-primary)}',
      '.sr-banner{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 12px;border:1px solid var(--dsw-alias-state-warning-primary);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}',
      '.sr-dash{display:flex;flex-direction:column;gap:8px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3)}',
      '.sr-badges{display:flex;flex-wrap:wrap;align-items:center;gap:6px}',
      '.sr-badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;padding:2px 7px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2)}',
      '.sr-badge-ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}',
      '.sr-badge-warn{color:var(--dsw-alias-state-warning-primary);border-color:var(--dsw-alias-state-warning-primary)}',
      '.sr-badge-err{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
      '.sr-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
      '.sr-btn-action{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1)}',
      '.sr-table{width:100%;font-size:11px;border-collapse:collapse}',
      '.sr-th,.sr-td{padding:4px 6px;text-align:left;border-bottom:1px solid var(--dsw-alias-border-l2)}',
      '.sr-th{color:var(--dsw-alias-label-secondary);font-weight:600}',
      '.sr-confirm-box{display:flex;flex-direction:column;gap:8px;padding:8px 10px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px}',
    ].join('')

    let cssInstalled = false
    function ensureCss() {
      if (cssInstalled || typeof document === 'undefined') return
      const tag = document.createElement('style')
      if (tag.dataset) tag.dataset.dshPlugin = 'dsh-smart-restart'
      else if (typeof tag.setAttribute === 'function') tag.setAttribute('data-dsh-plugin', 'dsh-smart-restart')
      tag.textContent = CSS
      document.head.appendChild(tag)
      cssInstalled = true
    }

    function RestartGuardCard(props) {
      ensureCss()
      const scope = props && props.scope
      const t = props.t || ((key) => en[key] || key)
      const [open, setOpen] = React.useState(false)
      const [draft, setDraft] = React.useState({})
      const [message, setMessage] = React.useState('')
      const [serverStatus, setServerStatus] = React.useState(null)
      const [showConfirm, setShowConfirm] = React.useState(false)
      const [restartDelay, setRestartDelay] = React.useState(5)
      const [restartReason, setRestartReason] = React.useState('')
      const [actionMsg, setActionMsg] = React.useState('')
      const [actionBusy, setActionBusy] = React.useState(false)
      const [showHistory, setShowHistory] = React.useState(false)

      const snap = scope && typeof scope.getSnapshot === 'function' ? scope.getSnapshot() : null
      const status = (snap && snap.status) || (scope ? 'loading' : 'unavailable')
      const unavailable = status === 'unavailable'
      const loading = status === 'loading'
      const values = { ...(snap ? snap.value : {}), ...draft }

      React.useEffect(() => {
        if (!scope || typeof scope.subscribe !== 'function') return undefined
        return scope.subscribe(() => {
          setDraft({})
        })
      }, [scope])

      React.useEffect(() => {
        if (!open) return undefined
        let cancelled = false
        const fetchStatus = async () => {
          try {
            if (typeof fetch !== 'function') return
            const res = await fetch('/dsh-smart-restart/status')
            if (res.ok) {
              const data = await res.json()
              if (!cancelled && data && data.status) {
                setServerStatus(data.status)
              }
            }
          } catch {
            // best effort status polling
          }
        }
        fetchStatus()
        const interval = setInterval(fetchStatus, 3000)
        return () => {
          cancelled = true
          clearInterval(interval)
        }
      }, [open])

      const scheduled = serverStatus && serverStatus.scheduled
      const [remainingSeconds, setRemainingSeconds] = React.useState(0)

      React.useEffect(() => {
        if (!scheduled || !scheduled.at) {
          setRemainingSeconds(0)
          return undefined
        }
        const tick = () => {
          const diff = Math.max(0, Math.ceil((scheduled.at - Date.now()) / 1000))
          setRemainingSeconds(diff)
        }
        tick()
        const tId = setInterval(tick, 1000)
        return () => clearInterval(tId)
      }, [scheduled])

      const set = (key, val) => {
        setDraft((prev) => ({ ...prev, [key]: val }))
        setMessage('')
      }

      const save = () => {
        if (!scope) return
        const next = { ...values }
        for (const num of ['delayMs', 'drainTimeoutMs', 'maxRestarts', 'windowMs']) {
          if (next[num] !== undefined && next[num] !== '') {
            const parsed = Number(next[num])
            if (Number.isNaN(parsed)) {
              setMessage(t('invalid'))
              return
            }
            next[num] = parsed
          }
        }
        if (typeof scope.set === 'function') {
          scope.set(next)
        } else if (typeof scope.update === 'function') {
          scope.update(next)
        }
        setMessage(t('saved'))
      }

      const handleSafeRestart = async () => {
        setActionBusy(true)
        setActionMsg('')
        try {
          if (typeof fetch !== 'function') return
          const res = await fetch('/dsh-smart-restart/restart', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              confirm: true,
              delayMs: Number(restartDelay) * 1000,
              reason: restartReason || 'Safe restart requested from WebUI',
            }),
          })
          const json = await res.json()
          if (json.ok) {
            setActionMsg(t('restartingIn').replace('{seconds}', String(restartDelay)))
            setShowConfirm(false)
            setServerStatus((prev) => ({
              ...(prev || {}),
              scheduled: {
                at: json.at,
                delayMs: json.delayMs,
                reason: json.reason,
              },
            }))
          } else {
            setActionMsg(json.error || 'Failed to initiate restart')
          }
        } catch (err) {
          setActionMsg(String((err && err.message) || err))
        } finally {
          setActionBusy(false)
        }
      }

      const handleCancelRestart = async () => {
        setActionBusy(true)
        try {
          if (typeof fetch !== 'function') return
          const res = await fetch('/dsh-smart-restart/cancel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          })
          const json = await res.json()
          if (json.ok && json.cancelled) {
            setActionMsg(t('restartCancelled'))
            setServerStatus((prev) => (prev ? { ...prev, scheduled: null } : null))
          } else {
            setActionMsg(json.message || 'No restart was pending')
          }
        } catch (err) {
          setActionMsg(String((err && err.message) || err))
        } finally {
          setActionBusy(false)
        }
      }

      const text = (key, label) => React.createElement('div', { className: 'sr-field' },
        React.createElement('span', { className: 'sr-label' }, t(label)),
        React.createElement('input', {
          className: 'sr-input',
          value: values[key] ?? '',
          onChange: (event) => set(key, event.target.value),
        }),
        React.createElement('span', { className: 'sr-hint' }, t(`${label}Hint`)),
      )

      const flag = (key, label) => React.createElement('label', { className: 'sr-field', style: { flexDirection: 'row', alignItems: 'center', gap: '8px' } },
        React.createElement('input', {
          type: 'checkbox',
          checked: values[key] !== false,
          onChange: (event) => set(key, event.target.checked),
        }),
        React.createElement('span', { className: 'sr-label' }, t(label)),
        React.createElement('span', { className: 'sr-hint' }, t(`${label}Hint`)),
      )

      // Grace period banner component (#43)
      const renderCountdownBanner = () => {
        if (!scheduled || remainingSeconds <= 0) return null
        return React.createElement('div', { className: 'sr-banner' },
          React.createElement('div', null,
            React.createElement('strong', null, t('restartingIn').replace('{seconds}', String(remainingSeconds))),
            scheduled.reason ? React.createElement('span', { style: { marginLeft: '8px', fontSize: '11px', opacity: 0.85 } }, `(${scheduled.reason})`) : null,
          ),
          React.createElement('button', {
            type: 'button',
            className: 'sr-btn sr-btn-danger',
            onClick: handleCancelRestart,
            disabled: actionBusy,
          }, t('cancelRestart')),
        )
      }

      // Reliability Dashboard component (#42)
      const renderDashboard = () => {
        if (!serverStatus) return null
        const v = serverStatus.verdict || 'ok'
        const badgeClass = v === 'ok' ? 'sr-badge-ok' : v === 'degraded' ? 'sr-badge-warn' : 'sr-badge-err'
        const label = v === 'ok' ? t('healthOk') : v === 'degraded' ? t('healthDegraded') : t('healthLoop')
        const checks = Array.isArray(serverStatus.checks) ? serverStatus.checks : []
        const history = Array.isArray(serverStatus.history) ? serverStatus.history : []

        return React.createElement('div', { className: 'sr-dash' },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
            React.createElement('span', { className: 'sr-label' }, t('healthVerdict')),
            React.createElement('span', { className: `sr-badge ${badgeClass}` }, label),
          ),
          checks.length > 0 ? React.createElement('div', { className: 'sr-badges' },
            checks.map((c, idx) => {
              const cClass = c.ok ? 'sr-badge-ok' : 'sr-badge-err'
              return React.createElement('span', { key: idx, className: `sr-badge ${cClass}` },
                `${c.ok ? '✓' : '✗'} ${c.name}`,
              )
            })
          ) : null,
          React.createElement('div', { style: { display: 'flex', gap: '8px', marginTop: '4px' } },
            React.createElement('button', {
              type: 'button',
              className: 'sr-btn sr-btn-action',
              onClick: () => setShowConfirm((prev) => !prev),
            }, t('safeRestart')),
            history.length > 0 ? React.createElement('button', {
              type: 'button',
              className: 'sr-btn',
              onClick: () => setShowHistory((prev) => !prev),
            }, `${t('historyTitle')} (${history.length})`) : null,
          ),
          showConfirm ? React.createElement('div', { className: 'sr-confirm-box' },
            React.createElement('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } }, t('safeRestartDesc')),
            React.createElement('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
              React.createElement('span', { className: 'sr-label' }, t('restartDelaySec')),
              React.createElement('input', {
                type: 'number',
                min: '1',
                className: 'sr-input',
                style: { width: '60px' },
                value: restartDelay,
                onChange: (e) => setRestartDelay(e.target.value),
              }),
            ),
            React.createElement('input', {
              className: 'sr-input',
              placeholder: t('reasonPlaceholder'),
              value: restartReason,
              onChange: (e) => setRestartReason(e.target.value),
            }),
            React.createElement('div', { style: { display: 'flex', gap: '6px' } },
              React.createElement('button', {
                type: 'button',
                className: 'sr-btn sr-btn-action',
                onClick: handleSafeRestart,
                disabled: actionBusy,
              }, t('confirmRestart')),
              React.createElement('button', {
                type: 'button',
                className: 'sr-btn',
                onClick: () => setShowConfirm(false),
              }, t('cancel')),
            ),
          ) : null,
          showHistory && history.length > 0 ? React.createElement('table', { className: 'sr-table' },
            React.createElement('thead', null,
              React.createElement('tr', null,
                React.createElement('th', { className: 'sr-th' }, t('time')),
                React.createElement('th', { className: 'sr-th' }, t('downtime')),
                React.createElement('th', { className: 'sr-th' }, t('reason')),
              ),
            ),
            React.createElement('tbody', null,
              history.slice().reverse().map((item, idx) => {
                const ts = typeof item === 'number' ? new Date(item).toLocaleTimeString() : (item.bootAt ? new Date(item.bootAt).toLocaleTimeString() : String(item))
                const down = item.downtimeMs ? `${(item.downtimeMs / 1000).toFixed(1)}s` : '-'
                const rsn = item.reason || '-'
                return React.createElement('tr', { key: idx },
                  React.createElement('td', { className: 'sr-td' }, ts),
                  React.createElement('td', { className: 'sr-td' }, down),
                  React.createElement('td', { className: 'sr-td' }, rsn),
                )
              }),
            ),
          ) : null,
          actionMsg ? React.createElement('div', { className: 'sr-note', style: { color: 'var(--dsw-alias-state-warning-primary)' } }, actionMsg) : null,
        )
      }

      return React.createElement(
        'div',
        { className: 'sr-card' },
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'sr-head',
            onClick: () => setOpen(!open),
          },
          React.createElement('span', { className: 'sr-chev', 'data-open': String(open) }, React.createElement(Chevron, { width: 14, height: 14 })),
          React.createElement('span', { className: 'sr-title' }, t('title')),
        ),
        React.createElement('div', { className: 'sr-summary' }, t('summary')),
        open ? React.createElement('div', { className: 'sr-body' },
          renderCountdownBanner(),
          renderDashboard(),
          loading ? React.createElement('div', { className: 'sr-note' }, t('loading')) : null,
          unavailable ? React.createElement('div', { className: 'sr-note sr-bad' }, t('unavailable')) : null,
          !unavailable ? React.createElement(React.Fragment || 'div', null,
            flag('enabled', 'enabled'),
            React.createElement('div', { className: 'sr-field' },
              React.createElement('span', { className: 'sr-label' }, t('restartMode')),
              React.createElement('select', {
                className: 'sr-select',
                value: values.restartMode || 'kill',
                onChange: (event) => set('restartMode', event.target.value),
              },
                React.createElement('option', { value: 'kill' }, 'kill — end the process, systemd restarts it'),
                React.createElement('option', { value: 'systemctl' }, 'systemctl — restart the unit'),
              ),
              React.createElement('span', { className: 'sr-hint' }, t('restartModeHint')),
            ),
            text('unit', 'unit'),
            text('target', 'target'),
            text('delayMs', 'delayMs'),
            text('drainTimeoutMs', 'drainTimeoutMs'),
            text('stateDir', 'stateDir'),
            text('maxRestarts', 'maxRestarts'),
            text('windowMs', 'windowMs'),
            text('expectTools', 'expectTools'),
            flag('toolEnabled', 'toolEnabled'),
            flag('requireApproval', 'requireApproval'),
            React.createElement('div', { className: 'sr-foot' },
              React.createElement('button', { type: 'button', className: 'sr-btn', onClick: save }, t('save')),
              message ? React.createElement('span', { className: 'sr-note' }, message) : null,
            ),
          ) : null,
        ) : null,
      )
    }

    function apply(ctx) {
      const registerLocales = () => {
        try {
          if (ctx.locale && typeof ctx.locale.register === 'function') {
            return ctx.locale.register(NS, { en, zh })
          }
        } catch (err) {
          if (ctx.logger && typeof ctx.logger.warn === 'function') {
            ctx.logger.warn('[smart-restart-guard] locale registration failed:', err && err.message)
          }
        }
        return undefined
      }

      if (typeof ctx.effect === 'function') {
        ctx.effect(() => {
          const disposer = registerLocales()
          return () => {
            if (typeof disposer === 'function') disposer()
          }
        })
      } else {
        registerLocales()
      }
      const t = ctx.locale && typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : (key) => en[key] || key
      const entries = [
        { seat: 'plugins.item', entry: { name: 'plugins.item', id: NS, order: 60, label: () => t('title'), locale: NS } },
        { seat: 'plugins.row.config', entry: { name: 'plugins.row.config', key: NS, locale: NS, order: 60, label: () => t('title') } },
      ]
      for (const { seat, entry } of entries) {
        try {
          ctx.slots.inject(seat, () => {
            let scope = null
            try {
              if (typeof ctx.get === 'function') {
                const cf = ctx.get('configForms')
                if (cf && typeof cf.get === 'function') {
                  scope = cf.get(NS)
                } else {
                  const ss = ctx.get('settingsScope')
                  if (ss && ss.bind) scope = ss.bind({ namespace: NS })
                }
              }
            } catch (err) {
              if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn('[smart-restart-guard] configForms / settingsScope resolution failed:', err && err.message)
            }
            if (!scope && ctx.logger && typeof ctx.logger.warn === 'function') {
              ctx.logger.warn('[smart-restart-guard] settings scope is unavailable for namespace', NS)
            }
            entry.inject = () => ({ t, scope })
            return ctx.slots.register(entry, RestartGuardCard)
          })
        } catch {
          // an older core without this seat: the other one may still exist
        }
      }
    }

    const inject = ['slots', 'locale']
    module.exports = { apply, inject, RestartGuardCard }
    return module.exports
  },
})
