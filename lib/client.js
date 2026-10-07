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
      save: 'Save',
      saved: 'Saved',
      invalid: 'Enter a number, not text.',
      unavailable: 'The settings service is unavailable, so this form cannot be saved right now.',
      loading: 'Loading settings...',
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
      save: '保存',
      saved: '已保存',
      invalid: '请输入数字，而不是文本。',
      unavailable: '设置服务不可用，当前表单无法保存。',
      loading: '加载设置中...',
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
      '.sr-body{display:flex;flex-direction:column;gap:10px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px}',
      '.sr-field{display:flex;flex-direction:column;gap:3px}',
      '.sr-label{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.sr-hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.sr-input,.sr-select{height:28px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);padding:0 8px;font:inherit}',
      '.sr-foot{display:flex;align-items:center;gap:8px}',
      '.sr-btn{appearance:none;font:inherit;font-size:12px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:0 0;color:var(--dsw-alias-label-primary);border-radius:8px;padding:4px 10px}',
      '.sr-note{font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.sr-bad{color:var(--dsw-alias-state-error-primary)}',
    ].join('')

    let cssInstalled = false
    function ensureCss() {
      if (cssInstalled || typeof document === 'undefined') return
      const tag = document.createElement('style')
      tag.dataset.dshPlugin = 'dsh-smart-restart'
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

      // ConfigForm is getSnapshot() in both 0.1.7-rc.2 and 0.2.0: a synchronous
      // { status, value, base, revision } plus a no-argument subscribe(). There is
      // no status() and no get(), so the old path always fell through to the draft
      // alone and the card showed defaults that were never read from the form.
      const snap = scope && typeof scope.getSnapshot === 'function' ? scope.getSnapshot() : null
      const status = (snap && snap.status) || (scope ? 'loading' : 'unavailable')
      const unavailable = status === 'unavailable'
      const loading = status === 'loading'
      const values = snap && snap.value && typeof snap.value === 'object' ? { ...snap.value, ...draft } : { ...draft }

      const set = (key, value) => setDraft((current) => ({ ...current, [key]: value }))

      const save = () => {
        if (!scope || typeof scope.set !== 'function') return
        const patch = {}
        const numbers = ['delayMs', 'maxRestarts', 'windowMs']
        for (const [key, value] of Object.entries(draft)) {
          if (numbers.includes(key)) {
            const parsed = Number(value)
            if (!Number.isFinite(parsed)) {
              setMessage(`${t('invalid')} (${key})`)
              return
            }
            patch[key] = parsed
          } else if (key === 'expectTools') {
            patch[key] = String(value).split(',').map((s) => s.trim()).filter(Boolean)
          } else {
            patch[key] = value
          }
        }
        try {
          scope.set(patch)
          setDraft({})
          setMessage(t('saved'))
        } catch (err) {
          setMessage(String((err && err.message) || err))
        }
      }

      const text = (key, label) => React.createElement('div', { className: 'sr-field' },
        React.createElement('span', { className: 'sr-label' }, t(label)),
        React.createElement('input', {
          className: 'sr-input',
          type: 'text',
          value: values[key] === undefined || values[key] === null ? '' : String(values[key]),
          onChange: (event) => set(key, event.target.value),
        }),
        React.createElement('span', { className: 'sr-hint' }, t(`${label}Hint`)),
      )

      const flag = (key, label) => React.createElement('label', { className: 'sr-field' },
        React.createElement('span', { className: 'sr-label' },
          React.createElement('input', {
            type: 'checkbox',
            checked: values[key] !== false,
            onChange: (event) => set(key, event.target.checked),
          }),
          ` ${t(label)}`,
        ),
        React.createElement('span', { className: 'sr-hint' }, t(`${label}Hint`)),
      )

      return React.createElement('div', { className: 'sr-card' },
        React.createElement('button', {
          type: 'button',
          className: 'sr-head',
          'aria-expanded': open,
          onClick: () => setOpen(!open),
        },
          React.createElement('span', { className: 'sr-chev', 'data-open': String(open) }, React.createElement(Chevron, { width: 14, height: 14 })),
          React.createElement('span', { className: 'sr-title' }, t('title')),
        ),
        React.createElement('div', { className: 'sr-summary' }, t('summary')),
        open ? React.createElement('div', { className: 'sr-body' },
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
          text('stateDir', 'stateDir'),
          text('maxRestarts', 'maxRestarts'),
          text('windowMs', 'windowMs'),
          text('expectTools', 'expectTools'),
          flag('toolEnabled', 'toolEnabled'),
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
      // Live seats only. settings.plugin.item was retired before DSH 0.1.7-rc.2 —
      // one occurrence in the whole 0.1.7-rc.2 tree against 54 of plugins.item —
      // so it only registered the card a second time on a seat that no longer
      // exists. The row seat carries the same card.
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
    module.exports = { apply, inject }
    return module.exports
  },
})
