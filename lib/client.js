// Client half: one settings page and the composer switch.
//
// All traffic goes through same-origin relative URLs (`/dsh-global-search/...`),
// never 127.0.0.1 — when the page is opened over a LAN host, 127.0.0.1 in the
// browser is the *client's* loopback and would always fail.
//
// This half sticks to the three React entry points a dynamic Client bundle is
// documented to receive (`createElement`, `useState`, `useEffect`) and defines no
// class component. A `class ErrorBoundary extends React.Component` here rendered
// as "渲染失败" in the real page while passing a fake-React test, so the safety
// net is now a plain try/catch around the render function plus an error report
// posted to the host log: a panel can fail loudly instead of silently blanking.
//
// Nothing here ships a key: a key can only be typed by the user (settings page, or
// the one-click prompt on the composer switch) or supplied through the environment
// at install time. It is stored in the plugin data directory and never echoed back
// in full — the settings page only ever sees a masked `abcd…yz` form.
window.__ModuleLoader__.load({
  id: 'dsh-global-search',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect } = React

    const POLL_MS = 10000

    const T = {
      bg1: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.06))',
      bg2: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.12))',
      border: 'var(--dsw-alias-border-l1, rgba(127,127,127,0.28))',
      border2: 'var(--dsw-alias-border-l2, rgba(127,127,127,0.45))',
      text: 'var(--dsw-alias-label-primary, inherit)',
      dim: 'var(--dsw-alias-label-secondary, #8b949e)',
      brand: 'var(--dsw-alias-brand-primary, #2f7cf6)',
      ok: 'var(--dsw-alias-state-success-primary, #2ea043)',
      warn: 'var(--dsw-alias-state-warn-primary, #d29922)',
      err: 'var(--dsw-alias-state-error-primary, #d1242f)',
      idle: 'var(--dsw-alias-state-idle-primary, #8b949e)',
    }

    const jsonRequest = async (path, method = 'GET', body) => {
      const init = { method, headers: { accept: 'application/json' }, cache: 'no-store' }
      if (body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(body)
      }
      const res = await fetch(`/dsh-global-search/${path}`, init)
      const value = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(value?.error ?? `HTTP ${res.status}`)
      return value
    }

    // A render failure must leave a trace: the browser console is not reachable
    // from the host, so the message goes back over the plugin's own route and lands
    // in log.jsonl next to everything else.
    const reportClientError = (where, error) => {
      try {
        const payload = {
          where,
          message: String(error?.message ?? error),
          stack: String(error?.stack ?? '').slice(0, 4000),
          url: String(window?.location?.href ?? ''),
          ua: String(window?.navigator?.userAgent ?? ''),
        }
        fetch('/dsh-global-search/client-error', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          keepalive: true,
        }).catch(() => {})
      } catch {
        /* reporting must never throw inside a render failure */
      }
    }

    // Mount beacon: tells the host log which surfaces the browser really rendered.
    // Registration is not rendering — a slot occupant can sit there `active:false`
    // forever — so every component below reports itself once on mount.
    const beat = (surface) => {
      try {
        fetch('/dsh-global-search/client-heartbeat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ surface, url: String(window?.location?.pathname ?? '') }),
          keepalive: true,
        }).catch(() => {})
      } catch {
        /* a beacon must never throw inside a render */
      }
    }

    const relative = (ms) => {
      if (!Number.isFinite(ms) || ms < 0) return '—'
      const s = Math.floor(ms / 1000)
      if (s < 60) return `${s} 秒前`
      const m = Math.floor(s / 60)
      if (m < 60) return `${m} 分钟前`
      const hours = Math.floor(m / 60)
      if (hours < 24) return `${hours} 小时前`
      return `${Math.floor(hours / 24)} 天前`
    }

    function useStatus() {
      const [status, setStatus] = useState(null)
      const [error, setError] = useState(null)

      const load = () => {
        jsonRequest('status')
          .then((value) => {
            setStatus(value)
            setError(null)
          })
          .catch((e) => setError(String(e?.message ?? e)))
      }

      useEffect(() => {
        let alive = true
        const tick = () => {
          if (alive) load()
        }
        tick()
        const timer = setInterval(tick, POLL_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [])

      return { status, error, reload: load, setStatus }
    }

    // ---- settings page -----------------------------------------------------
    // Everything below is plain rendering: no hooks, no class, so the panel body can
    // be wrapped in try/catch and a broken status payload still shows a message.
    function renderPanel(ui) {
      const { compact, status, error, reload, keyInput, setKeyInput, providerId, setProviderId, busy, setBusy, notice, setNotice } = ui

      const google = status?.google
      const configured = google?.configured === true
      const enabled = google?.enabled === true
      const balance = google?.balance ?? {}
      const providers = Array.isArray(google?.providers) ? google.providers : []

      const run = async (label, task) => {
        setBusy(label)
        setNotice(null)
        try {
          const value = await task()
          if (value && value.status) ui.setStatus(value.status)
          else if (value && value.ok === false) setNotice({ kind: 'err', text: String(value.error ?? '失败') })
          return value
        } catch (e) {
          setNotice({ kind: 'err', text: String(e?.message ?? e) })
          return null
        } finally {
          setBusy('')
        }
      }

      const saveKey = () =>
        run('save', async () => {
          const value = await jsonRequest('settings', 'POST', { key: keyInput.trim(), provider: providerId })
          setKeyInput('')
          setNotice({ kind: 'ok', text: 'key 已保存，Google 搜索已开启' })
          return value
        })

      const clearKey = () =>
        run('clear', async () => {
          const value = await jsonRequest('settings', 'POST', { clearKey: true })
          setNotice({ kind: 'ok', text: 'key 已清除，Google 搜索已关闭' })
          return value
        })

      const toggle = () => run('toggle', () => jsonRequest('settings', 'POST', { enabled: !enabled }))

      const refreshBalance = () =>
        run('balance', async () => {
          const value = await jsonRequest('balance', 'POST')
          const credits = value?.balance?.credits
          setNotice(
            Number.isFinite(credits)
              ? { kind: 'ok', text: `余额：${credits} 次` }
              : { kind: 'err', text: `余额读取失败：${value?.balance?.error ?? value?.balance?.unsupported ?? '未知原因'}` },
          )
          return { status: value.status }
        })

      const test = () =>
        run('test', async () => {
          const value = await jsonRequest('test?q=tokio%20async%20runtime', 'POST')
          if (value?.ok) {
            setNotice({
              kind: 'ok',
              text: `Google 可用：${value.sources?.length ?? 0} 条结果 · ${value.ms} ms · 剩余 ${value.credits ?? '?'} 次`,
            })
          } else {
            setNotice({ kind: 'err', text: `Google 不可用：${value?.category ?? ''} ${value?.error ?? value?.why ?? ''}`.trim() })
          }
          return value ? { status: value.status } : null
        })

      if (error && !status) {
        return h('div', { style: { padding: 16, color: T.err, font: '13px/1.6 inherit' } }, `读取插件状态失败：${error}`)
      }

      const row = (children, extra = {}) =>
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', ...extra } }, children)

      const button = (text, onClick, { primary = false, disabled = false } = {}) =>
        h(
          'button',
          {
            type: 'button',
            onClick,
            disabled: disabled || busy !== '',
            style: {
              padding: '4px 12px',
              height: 26,
              borderRadius: 6,
              border: `1px solid ${primary ? T.brand : T.border2}`,
              background: primary ? 'color-mix(in srgb, ' + T.brand + ' 14%, transparent)' : 'transparent',
              color: primary ? T.brand : T.text,
              font: '12px/1.2 inherit',
              cursor: disabled || busy ? 'not-allowed' : 'pointer',
              opacity: disabled || busy ? 0.55 : 1,
            },
          },
          text,
        )

      const caption = (text) => h('div', { style: { font: '12px/1.6 inherit', color: T.dim, marginBottom: 2 } }, text)

      const infoRow = (name, value, color = T.text) =>
        h(
          'div',
          { style: { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '3px 0', font: '12px/1.6 inherit' } },
          h('span', { style: { color: T.dim } }, name),
          h('span', { style: { color, textAlign: 'right', wordBreak: 'break-all' } }, value),
        )

      const activeProvider = providers.filter((p) => p.id === (google?.key?.provider ?? providerId))[0]
      const creditsText = Number.isFinite(balance.credits)
        ? `${balance.credits} 次${balance.checkedAt ? `（${relative(balance.ageMs)}）` : ''}`
        : balance.unsupported === 'provider-has-no-balance-endpoint'
          ? '该 provider 不提供余额接口'
          : balance.error
            ? `读取失败：${balance.error}`
            : '未知（尚无读数）'

      return h(
        'div',
        { style: { padding: '4px 2px 24px', display: 'flex', flexDirection: 'column', gap: 14, color: T.text, maxWidth: 640 } },
        h('div', { style: { font: '14px/1.5 inherit', fontWeight: 600 } }, '外网搜索（Google）'),
        h(
          'div',
          { style: { font: '12px/1.7 inherit', color: T.dim } },
          '插件不内置任何 key，也不需要代理：Google 结果由你自己的免费 SERP key 提供。',
          ' 未开启时，web_search 走 Bing（英文→国际索引，中文→国内索引）。',
          ' 开启后模型可自行判断何时调用 google_search，每次调用消耗 1 次额度。',
        ),

        // onboarding: the four steps to a working key, spelled out so nobody has to
        // guess where the key comes from.
        h(
          'div',
          { style: { border: `1px dashed ${T.border2}`, borderRadius: 8, padding: '10px 12px', font: '12px/1.9 inherit', color: T.dim } },
          h('div', { style: { fontWeight: 600, color: T.text, marginBottom: 4 } }, '接入步骤（约 1 分钟，免费）'),
          h('div', {}, '① 打开 ', h('a', { href: 'https://serper.dev', target: '_blank', rel: 'noreferrer', style: { color: T.brand } }, 'serper.dev'), '，用 GitHub / Google 账号注册（每月 2,500 次，不需要信用卡）'),
          h('div', {}, '② 在控制台复制 API key（一串 40 位字符）'),
          h('div', {}, '③ 粘贴到下面「① 填写 API key」的输入框，点「保存」'),
          h('div', {}, '④ 点「测试连接」验证；成功后可在本页或输入框下方的开关开启'),
        ),

        // key + provider
        h(
          'div',
          { style: { border: `1px solid ${T.border}`, borderRadius: 8, padding: 12, background: T.bg1, display: 'flex', flexDirection: 'column', gap: 8 } },
          h('div', { style: { font: '13px/1.4 inherit', fontWeight: 600 } }, '① 填写 API key'),
          caption('服务商（免费额度）'),
          row(
            h(
              'select',
              {
                value: providerId,
                onChange: (e) => setProviderId(e.target.value),
                style: { height: 28, borderRadius: 6, border: `1px solid ${T.border2}`, background: T.bg2, color: T.text, font: '12px/1.2 inherit', padding: '0 6px' },
              },
              providers.length > 0
                ? providers.map((p) => h('option', { key: p.id, value: p.id }, p.label))
                : h('option', { value: 'serper' }, 'serper.dev — 2,500 free queries/month'),
            ),
            activeProvider
              ? h('a', { href: activeProvider.docs, target: '_blank', rel: 'noreferrer', style: { color: T.brand, font: '12px/1.2 inherit' } }, '免费注册 →')
              : h('a', { href: 'https://serper.dev', target: '_blank', rel: 'noreferrer', style: { color: T.brand, font: '12px/1.2 inherit' } }, '免费注册 →'),
          ),
          row(
            h('input', {
              type: 'password',
              value: keyInput,
              placeholder: configured ? `已保存 ${google?.key?.masked ?? ''}（粘贴新 key 可替换）` : '粘贴 key，例如 e9a3…',
              onChange: (e) => setKeyInput(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter' && keyInput.trim().length >= 8) saveKey()
              },
              style: {
                flex: '1 1 260px',
                height: 28,
                borderRadius: 6,
                border: `1px solid ${T.border2}`,
                background: T.bg2,
                color: T.text,
                font: '12px/1.2 ui-monospace, monospace',
                padding: '0 8px',
              },
            }),
            button(busy === 'save' ? '保存中…' : '保存', saveKey, { primary: true, disabled: keyInput.trim().length < 8 }),
            button('测试连接', test, { disabled: !configured }),
            configured ? button('清除 key', clearKey) : null,
          ),
          h(
            'div',
            { style: { font: '11px/1.6 inherit', color: T.dim } },
            'key 只保存在插件数据目录（本机），不随安装包分发、不写入日志、卸载时一并删除。',
          ),
        ),

        // switch
        h(
          'div',
          { style: { border: `1px solid ${T.border}`, borderRadius: 8, padding: 12, background: T.bg1, display: 'flex', flexDirection: 'column', gap: 8 } },
          h('div', { style: { font: '13px/1.4 inherit', fontWeight: 600 } }, '② 开关'),
          row(
            h('span', { style: { display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: enabled ? T.ok : T.idle } }),
            h('span', { style: { font: '12px/1.6 inherit' } }, enabled ? '已开启：模型可调用 google_search' : '已关闭：只用 Bing，不消耗额度'),
            button(enabled ? '关闭' : '开启', toggle, { disabled: !configured, primary: !enabled && configured }),
          ),
          !configured ? h('div', { style: { font: '11px/1.6 inherit', color: T.warn } }, '先保存一个 key 才能开启。') : null,
        ),

        // quota
        compact
          ? null
          : h(
              'div',
              { style: { border: `1px solid ${T.border}`, borderRadius: 8, padding: 12, background: T.bg1, display: 'flex', flexDirection: 'column', gap: 6 } },
              h('div', { style: { font: '13px/1.4 inherit', fontWeight: 600 } }, '③ 额度'),
              infoRow('剩余次数', creditsText, Number.isFinite(balance.credits) && balance.credits < 20 ? T.warn : T.text),
              infoRow('上次刷新', balance.checkedAt ? relative(balance.ageMs) : '尚未读取'),
              infoRow('刷新时机', '每轮对话结束后自动读取一次'),
              row(button(busy === 'balance' ? '读取中…' : '立即刷新', refreshBalance, { disabled: !configured })),
            ),

        // live state
        compact
          ? null
          : h(
              'div',
              { style: { border: `1px solid ${T.border}`, borderRadius: 8, padding: 12, background: T.bg1, display: 'flex', flexDirection: 'column', gap: 6 } },
              h('div', { style: { font: '13px/1.4 inherit', fontWeight: 600 } }, '④ 运行状态'),
              infoRow('插件版本', status?.version ?? '—'),
              infoRow('google_search 工具', google?.tool?.registered ? '已注册（模型可见）' : '未注册', google?.tool?.registered ? T.ok : T.dim),
              infoRow('上次检索通道', status?.lastChannel ?? '尚未检索'),
              infoRow('Bing 通道', `${status?.channels?.international ?? 'bing-global'} / ${status?.channels?.domestic ?? 'bing-cn'}`),
              infoRow('日志文件', status?.logFile ?? '—'),
            ),

        notice
          ? h(
              'div',
              {
                style: {
                  font: '12px/1.6 inherit',
                  color: notice.kind === 'ok' ? T.ok : T.err,
                  border: `1px solid ${notice.kind === 'ok' ? T.ok : T.err}`,
                  borderRadius: 6,
                  padding: '6px 10px',
                },
              },
              notice.text,
            )
          : null,
        error ? h('div', { style: { font: '11px/1.6 inherit', color: T.err } }, `状态刷新失败：${error}`) : null,
        h(
          'div',
          { style: { font: '11px/1.6 inherit', color: T.dim, display: 'flex', gap: 10, flexWrap: 'wrap' } },
          h('span', {}, '诊断：'),
          h('a', { href: '/dsh-global-search/status', target: '_blank', rel: 'noreferrer', style: { color: T.brand } }, '/dsh-global-search/status'),
          button('刷新状态', reload),
        ),
      )
    }

    function Panel(props) {
      // Entered-the-body beacon, before any hook runs: distinguishes "the shell never
      // called this component" from "it was called and then threw".
      beat('panel-enter')
      const compact = props?.compact === true
      const { status, error, reload, setStatus } = useStatus()
      const [keyInput, setKeyInput] = useState('')
      const [providerId, setProviderId] = useState('serper')
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState(null)

      useEffect(() => {
        beat('settings-page')
      }, [])

      const ui = {
        compact,
        status,
        error,
        reload,
        keyInput,
        setKeyInput,
        providerId,
        setProviderId,
        busy,
        setBusy,
        notice,
        setNotice,
        setStatus,
      }

      try {
        return renderPanel(ui)
      } catch (e) {
        reportClientError('panel', e)
        return h(
          'div',
          { style: { padding: 12, color: T.err, font: '12px/1.6 inherit' } },
          '设置面板渲染失败：',
          String(e?.message ?? e),
          h('div', { style: { color: T.dim, marginTop: 6 } }, '该错误已写入插件日志（log.jsonl）。'),
        )
      }
    }

    // ---- composer switch ---------------------------------------------------
    function renderSwitch(state) {
      const { status, busy, open, setOpen } = state
      const google = status?.google
      const configured = google?.configured === true
      const ready = google?.ready === true
      const credits = google?.balance?.credits

      const color = !configured ? T.idle : ready ? T.ok : T.dim
      const text = !configured ? '未配置' : ready ? '开' : '关'
      const title = [
        !configured
          ? 'Google 搜索：还没有 key。点一下可直接粘贴 serper.dev 的免费 key（2500 次/月），也可以去 设置 › 外网搜索。'
          : `Google 搜索：${ready ? '开' : '关'}（点击切换）`,
        configured ? `key：${google?.key?.masked ?? ''}（${google?.key?.provider ?? ''}）` : '',
        Number.isFinite(credits) ? `剩余额度：${credits} 次` : '',
        `上次通道：${status?.lastChannel ?? '尚未检索'}`,
        '关闭时 web_search 只用 Bing（英文国际索引 / 中文国内索引），不消耗额度。',
      ]
        .filter(Boolean)
        .join('\n')

      return h(
        'button',
        {
          type: 'button',
          title,
          'aria-label': title,
          'aria-pressed': open,
          disabled: busy,
          onClick: () => {
            if (busy) return
            setOpen(!open)
          },
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '2px 10px',
            height: 22,
            borderRadius: 11,
            border: `1px solid ${ready ? T.brand : T.border2}`,
            background: ready ? `color-mix(in srgb, ${T.brand} 16%, transparent)` : 'transparent',
            color: ready ? T.brand : T.dim,
            font: '11px/1.2 inherit',
            cursor: busy ? 'progress' : 'pointer',
            opacity: busy ? 0.6 : 1,
            whiteSpace: 'nowrap',
            userSelect: 'none',
          },
        },
        h('span', { style: { display: 'inline-block', width: 6, height: 6, borderRadius: 3, background: color, flex: '0 0 auto' } }),
        'Google 搜索 · ',
        h('strong', { style: { fontWeight: 600 } }, text),
        Number.isFinite(credits) && ready ? h('span', { style: { opacity: 0.75 } }, ` ${credits}`) : null,
      )
    }

    function GoogleSwitch() {
      const { status } = useStatus()
      const [busy] = useState(false)
      const [open, setOpen] = useState(false)

      useEffect(() => {
        beat('switch')
      }, [])

      let chip
      try {
        chip = renderSwitch({ status, busy, open, setOpen })
      } catch (e) {
        reportClientError('switch', e)
        chip = h('button', { type: 'button', title: 'Google 搜索：面板渲染失败', style: { font: '11px/1.2 inherit' } }, 'Google 搜索')
      }

      // The chip doubles as the configuration entry: this dock row is the one surface
      // that is always on screen, so the key entry no longer depends on a settings
      // navigation the plugin does not own.
      return h(
        'div',
        { style: { position: 'relative', display: 'inline-flex' } },
        chip,
        open
          ? h(
              'div',
              {
                style: {
                  position: 'absolute',
                  bottom: 'calc(100% + 6px)',
                  left: 0,
                  zIndex: 40,
                  width: 420,
                  maxWidth: 'min(88vw, 420px)',
                  maxHeight: '72vh',
                  overflow: 'auto',
                  padding: 12,
                  borderRadius: 10,
                  border: `1px solid ${T.border2}`,
                  background: 'var(--dsw-alias-bg-layer-2, #1b1f24)',
                  boxShadow: '0 12px 32px rgba(0, 0, 0, 0.35)',
                  color: T.text,
                  textAlign: 'left',
                },
              },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
                h('strong', { style: { fontSize: 12 } }, '外网搜索 (Google)'),
                h('span', { style: { flex: 1 } }),
                h(
                  'button',
                  {
                    type: 'button',
                    onClick: () => setOpen(false),
                    style: {
                      font: '11px/1.2 inherit',
                      padding: '2px 8px',
                      borderRadius: 6,
                      border: `1px solid ${T.border}`,
                      background: 'transparent',
                      color: T.dim,
                      cursor: 'pointer',
                    },
                  },
                  '关闭',
                ),
              ),
              h(Panel, { compact: true }),
            )
          : null,
      )
    }

    // ---- settings page, deliberately hook-free ------------------------------
    // Measured on the live page: the same `Panel` renders correctly in the composer
    // dock card, while the settings shell calls it over and over (`panel-enter` x41)
    // without ever committing it (no effect, no error, occupant `active:false`).
    // A hook-free occupant in that very slot stays `active:true`. So the page that
    // ships in the settings nav uses no hooks at all: handlers talk to the host and
    // patch one output node, which needs no re-render.
    function SettingsPage(props) {
      try {
        return renderSettingsPage(props?.compact === true)
      } catch (e) {
        reportClientError('settings-page', e)
        return h(
          'div',
          { style: { padding: 12, color: T.err, font: '12px/1.6 inherit' } },
          '设置页渲染失败：',
          String(e?.message ?? e),
        )
      }
    }

    function renderSettingsPage(compact) {
      // Render-body beacon: lands in log.jsonl even though this page has no effects, so
      // "the shell never called the page" and "the page rendered but shows nothing" stay
      // distinguishable from the host side.
      beat('settings-body')
      const scope = (e) => (e.currentTarget ? e.currentTarget.closest('[data-gs-root]') : null)
      const field = (e, name) => {
        const root = scope(e)
        const node = root && root.querySelector(`[data-gs-${name}]`)
        return node ? String(node.value ?? '').trim() : ''
      }
      const say = (e, text, tone) => {
        const root = scope(e)
        const node = root && root.querySelector('[data-gs-out]')
        if (!node) return
        node.textContent = text
        node.style.color = tone === 'err' ? T.err : tone === 'ok' ? T.ok : T.dim
      }
      const post = async (path, body) => {
        const res = await fetch(`/dsh-global-search/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
          cache: 'no-store',
        })
        const value = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(String(value?.error ?? `HTTP ${res.status}`))
        return value
      }

      const save = async (e) => {
        const key = field(e, 'key')
        if (key.length < 8) return say(e, 'key 太短：serper.dev 的 key 一般 30 位以上', 'err')
        say(e, '保存中…', 'dim')
        try {
          await post('settings', { key, provider: field(e, 'provider') || 'serper' })
          say(e, '已保存，Google 搜索已开启 ✅（可以关掉这页，直接用输入框下方的开关）', 'ok')
        } catch (err) {
          say(e, `保存失败：${String(err?.message ?? err)}`, 'err')
        }
      }
      const test = async (e) => {
        say(e, '正在用 Google 检索一次…', 'dim')
        try {
          const value = await post('test', {})
          if (value?.ok) say(e, `测试通过：${value.provider} · ${value.ms} ms · 剩余 ${value.credits ?? '—'} 次`, 'ok')
          else say(e, `测试失败：${value?.why ?? value?.error ?? '未知原因'}`, 'err')
        } catch (err) {
          say(e, `测试失败：${String(err?.message ?? err)}`, 'err')
        }
      }
      const refresh = async (e) => {
        say(e, '读取中…', 'dim')
        try {
          const res = await fetch('/dsh-global-search/status', { cache: 'no-store' })
          const value = await res.json()
          const g = value?.google ?? {}
          const parts = [
            g.configured ? `key：${g.key?.masked ?? '已配置'}（${g.key?.provider ?? ''}）` : 'key：未配置',
            `开关：${g.enabled ? '开' : '关'}`,
            Number.isFinite(g.balance?.credits) ? `剩余额度：${g.balance.credits} 次` : '剩余额度：—',
            `上次通道：${value?.lastChannel ?? '尚未检索'}`,
          ]
          say(e, parts.join(' · '), 'dim')
        } catch (err) {
          say(e, `读取失败：${String(err?.message ?? err)}`, 'err')
        }
      }
      const clear = async (e) => {
        say(e, '清除中…', 'dim')
        try {
          await post('settings', { clearKey: true })
          say(e, 'key 已清除，Google 搜索已关闭（web_search 会回到 Bing）', 'ok')
        } catch (err) {
          say(e, `清除失败：${String(err?.message ?? err)}`, 'err')
        }
      }

      const box = (children, extra) =>
        h('div', { style: { display: 'grid', gap: 10, ...extra } }, ...children)
      const label = (text) => h('div', { style: { font: '12px/1.6 inherit', color: T.dim } }, text)
      const btn = (text, onClick, primary) =>
        h(
          'button',
          {
            type: 'button',
            onClick,
            style: {
              font: '12px/1.4 inherit',
              padding: '5px 12px',
              borderRadius: 7,
              border: `1px solid ${primary ? T.brand : T.border}`,
              background: primary ? `color-mix(in srgb, ${T.brand} 14%, transparent)` : 'transparent',
              color: primary ? T.brand : T.text,
              cursor: 'pointer',
            },
          },
          text,
        )

      return h(
        'div',
        {
          'data-gs-root': '1',
          style: {
            display: 'grid',
            gap: 14,
            padding: compact ? 0 : '4px 2px 12px',
            maxWidth: 620,
            font: '13px/1.65 inherit',
            color: T.text,
          },
        },
        h('div', { style: { display: 'grid', gap: 4 } },
          h('div', { style: { fontSize: 15, fontWeight: 600 } }, '外网搜索 (Google)'),
          label('用你自己的 Google SERP key 检索国际内容；不配 key 也能用，只是回到 Bing。'),
        ),
        h('div', {
          style: {
            display: 'grid',
            gap: 6,
            padding: '10px 12px',
            borderRadius: 8,
            border: `1px solid ${T.border}`,
            background: T.bg1,
            font: '12px/1.75 inherit',
          },
        },
          h('strong', { style: { fontSize: 12 } }, '接入步骤（约 1 分钟）'),
          h('div', {}, '1. 打开 ', h('a', { href: 'https://serper.dev', target: '_blank', rel: 'noreferrer', style: { color: T.brand } }, 'serper.dev'), '，用 Google 账号登录（免费 2500 次/月，不用信用卡）。'),
          h('div', {}, '2. 在 Dashboard 复制 API key（一串 30 多位字符）。'),
          h('div', {}, '3. 粘贴到下面，选 serper，点「保存 key」。'),
          h('div', {}, '4. 回到对话，输入框下方的「Google 搜索」胶囊显示「开」即生效。'),
        ),
        box([
          label('SERP key'),
          h('input', {
            'data-gs-key': '1',
            type: 'password',
            autocomplete: 'off',
            spellcheck: false,
            placeholder: '粘贴 key，只保存在本机 ~/.dsh/dsh-global-search',
            style: {
              width: '100%',
              boxSizing: 'border-box',
              padding: '7px 10px',
              borderRadius: 7,
              border: `1px solid ${T.border2}`,
              background: T.bg2,
              color: T.text,
              font: '12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
            },
          }),
        ]),
        box([
          label('服务商'),
          h(
            'select',
            {
              'data-gs-provider': '1',
              style: {
                padding: '6px 10px',
                borderRadius: 7,
                border: `1px solid ${T.border2}`,
                background: T.bg2,
                color: T.text,
                font: '12px/1.5 inherit',
              },
            },
            h('option', { value: 'serper' }, 'serper.dev — 2500 次/月（推荐）'),
            h('option', { value: 'searchapi' }, 'searchapi.io — 100 次'),
            h('option', { value: 'serpapi' }, 'serpapi.com — 100 次'),
            h('option', { value: 'zenserp' }, 'zenserp.com — 50 次'),
            h('option', { value: 'valueserp' }, 'valueserp.com — 100 次'),
          ),
        ]),
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
          btn('保存 key', save, true),
          btn('测试一次', test),
          btn('刷新状态', refresh),
          btn('清除 key', clear),
        ),
        h('div', {
          'data-gs-out': '1',
          style: {
            font: '12px/1.7 inherit',
            color: T.dim,
            minHeight: 20,
            padding: '8px 10px',
            borderRadius: 7,
            border: `1px dashed ${T.border}`,
            background: T.bg1,
            whiteSpace: 'pre-wrap',
          },
        }, '点「刷新状态」查看当前状态；状态也会显示在输入框下方的开关上。'),
        h('div', { style: { font: '11px/1.7 inherit', color: T.dim } },
          'key 只存本机数据目录，插件不会回传完整 key。关闭开关时 web_search 只用 Bing，不消耗额度。诊断：',
          h('a', { href: '/dsh-global-search/status', target: '_blank', rel: 'noreferrer', style: { color: T.brand } }, '/dsh-global-search/status'),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.slots
        beat('apply')
        // Browser-side safety net: an error thrown while the shell renders a section
        // never reaches the host on its own. These two listeners forward it to
        // /client-error, so the next failure is a stack in log.jsonl instead of a
        // blank pane nobody can explain.
        try {
          if (typeof window !== 'undefined' && window && typeof window.addEventListener === 'function' && !window.__dsgsErrorHook) {
            window.__dsgsErrorHook = true
            window.addEventListener('error', (event) => reportClientError('window-error', event?.error ?? event?.message ?? 'unknown'))
            window.addEventListener('unhandledrejection', (event) => reportClientError('unhandled-rejection', event?.reason ?? 'unknown'))
          }
        } catch {
          /* instrumentation must never break apply */
        }
        // One settings entry, one plugin card, one bundle card — all pointing at the
        // hook-free page. The A/B pair and the diagnostic page of 1.1.4–1.1.7 are gone:
        // they answered their question (this shell will not commit a hook-using
        // component into a settings section) and leaving them would ship test furniture.
        slots.inject('settings.section', () =>
          slots.register({ name: 'settings.section', id: 'dsh-global-search-page', order: 16, label: '外网搜索 (Google)' }, SettingsPage),
        )
        slots.inject('web-ui.plugin.item', () =>
          slots.register(
            { name: 'web-ui.plugin.item', id: 'dsh-global-search-card', order: 16, label: '外网搜索 (Google)' },
            (props) => h(SettingsPage, { ...(props ?? {}), compact: true }),
          ),
        )
        slots.inject('plugins.bundle.config', () =>
          slots.register(
            { name: 'plugins.bundle.config', key: 'dsh-global-search' },
            (props) => (props?.view === 'summary' ? null : h(SettingsPage, { ...(props ?? {}), compact: true })),
          ),
        )
        // Distinct registration id from the settings page above: two occupants of the
        // same plugin keyed by one id is the kind of collision that leaves the first
        // registration silently inactive.
        slots.inject('conversation.composer.dock', () =>
          slots.register({ name: 'conversation.composer.dock', id: 'dsh-global-search-switch', order: 2, label: 'Google 搜索' }, () => h(GoogleSwitch)),
        )
      },
    }
  },
})
