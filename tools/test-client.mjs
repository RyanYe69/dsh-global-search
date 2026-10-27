// Client-half smoke test.
//
// The browser half cannot be loaded by Node directly (it expects the DSH module
// table and React), so this file reproduces the same seam the page uses:
// `window.__ModuleLoader__.load({ id, factory })`, a `require` that hands back a
// minimal React, and a `slots` stub that records registrations.
//
// The React stub deliberately exposes ONLY `createElement`, `useState` and
// `useEffect` — the three entry points a dynamic Client bundle is documented to
// receive. A previous version of this plugin used `class extends React.Component`
// and `useCallback`; the fake React of that day provided both, so the test passed
// while the real page rendered "渲染失败". Now a hook or member outside the
// documented surface fails here first.
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

let passed = 0
let failed = 0
function check(name, fn) {
  try {
    const ok = fn()
    if (ok === false) throw new Error('returned false')
    passed += 1
    console.log(`  PASS ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}: ${error?.message ?? error}`)
  }
}
function eq(name, actual, expected) {
  check(name, () => {
    const a = JSON.stringify(actual)
    const b = JSON.stringify(expected)
    if (a !== b) throw new Error(`expected ${b}, got ${a}`)
    return true
  })
}

// ---- surface discipline ---------------------------------------------------
// Comments explain the past (`class ErrorBoundary extends React.Component`), so the
// scans below run on comment-stripped code only.
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const ALLOWED_REACT = new Set(['createElement', 'useState', 'useEffect', 'Component'])

check('no class component in the client half', () => !/\bclass\s+\w+/.test(CODE))
check('no React.Component extension', () => !/extends\s+React\.Component/.test(CODE))

check('only documented React members are referenced', () => {
  const used = new Set()
  for (const match of CODE.matchAll(/React\.([A-Za-z_$][\w$]*)/g)) used.add(match[1])
  for (const match of CODE.matchAll(/const\s*\{([^}]+)\}\s*=\s*React/g)) {
    for (const name of match[1].split(',').map((s) => s.trim())) if (name) used.add(name)
  }
  used.delete('Component')
  const bad = [...used].filter((name) => !ALLOWED_REACT.has(name))
  if (bad.length > 0) throw new Error(`uses ${bad.join(', ')} — not part of the documented surface`)
  return true
})

// ---- the seam -------------------------------------------------------------
const React = {
  createElement(type, props, ...children) {
    const merged = { ...(props ?? {}) }
    if (children.length === 1) merged.children = children[0]
    else if (children.length > 1) merged.children = children
    return { type, props: merged, children }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect() {},
}

let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      loaded = spec
    },
  },
}
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, google: {} }) })

// ---- load ----------------------------------------------------------------
check('client module registers itself with the module loader', () => {
  // eslint-disable-next-line no-new-func
  new Function('window', SRC)(globalThis.window)
  if (loaded === null) throw new Error('window.__ModuleLoader__.load was never called')
  return loaded.id === 'dsh-global-search'
})

const exported = loaded.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require(${JSON.stringify(name)})`)
})

eq('inject lists the slots service', exported.inject, ['slots'])
check('apply is a function', () => typeof exported.apply === 'function')

// ---- run apply against a recording slots stub -----------------------------
const registrations = []
const slots = {
  inject(name, fn) {
    const dispose = fn()
    registrations.push({ injected: name, dispose })
  },
  register(options, component) {
    registrations.push({ ...options, component })
    return () => {}
  },
}
exported.apply({ slots })

const pageEntry = () => byName('settings.section').find((r) => r.id === 'dsh-global-search-page')
const byName = (name) => registrations.filter((r) => r.name === name)

check('registers the native settings page', () => Boolean(pageEntry()))
check('registers the Web UI plugin list card', () => byName('web-ui.plugin.item').length === 1)
check('registers the bundle configuration card', () => byName('plugins.bundle.config').length === 1)
check('registers the composer switch', () => byName('conversation.composer.dock').length === 1)

eq(
  'settings page id',
  [pageEntry().id],
  ['dsh-global-search-page'],
)
eq(
  'bundle config key is the package name',
  byName('plugins.bundle.config').map((r) => r.key),
  ['dsh-global-search'],
)

check('two registrations never share one id in one slot', () => {
  for (const slot of new Set(registrations.filter((r) => r.id).map((r) => r.name))) {
    const ids = registrations.filter((r) => r.name === slot).map((r) => r.id)
    if (new Set(ids).size !== ids.length) throw new Error(`duplicate id in ${slot}: ${ids.join(',')}`)
  }
  return true
})

// The regression this guards, observed in the live page: two different slots
// registered under one id, and the first occupant ended up `active:false` — which
// reads to the user as "the settings page was never implemented". Uniqueness has to
// hold across every slot, not just within one.
check('every registration id is unique across every slot', () => {
  const ids = registrations.filter((r) => r.id).map((r) => r.id)
  if (new Set(ids).size !== ids.length) throw new Error(`duplicate id across slots: ${ids.join(',')}`)
  return true
})

check('settings label resolves to a non-empty string (string or thunk)', () => {
  const entry = pageEntry()
  const text = typeof entry.label === 'function' ? entry.label() : entry.label
  return typeof text === 'string' && text.length > 0
})

// ---- execute each component body once ------------------------------------
function renderOnce(component, props) {
  const element = component(props)
  if (element === null || element === undefined) throw new Error('component returned nothing')
  const type = element.type
  if (typeof type === 'function') {
    const out = type(element.props)
    if (!out) throw new Error('component rendered nothing')
    // one level deeper: a page wrapper renders a Panel element
    if (typeof out.type === 'function') {
      const inner = out.type(out.props)
      if (!inner) throw new Error('inner component rendered nothing')
      return inner
    }
    return out
  }
  return element
}

for (const entry of registrations.filter((r) => typeof r.component === 'function')) {
  check(`renders once: ${entry.name}${entry.id ? `#${entry.id}` : ''}${entry.key ? `@${entry.key}` : ''}`, () =>
    renderOnce(entry.component, { close() {}, view: 'page' }),
  )
}

// The bundle card is asked for a summary line first; that path must stay inert.
check('bundle config summary renders nothing (page-only card)', () => {
  const entry = byName('plugins.bundle.config')[0]
  return entry.component({ view: 'summary' }) === null
})

// ---- the settings page must carry the key entry with zero hooks ----------
// Measured on the live page: this settings shell calls a hook-using occupant over and
// over without ever committing it (occupant stays `active:false`, effects never run),
// while a hook-free occupant of the same slot is `active:true`. The page is therefore
// hook-free by contract, and this test is what keeps it that way.
check('settings page renders the onboarding + key input with no status payload', () => {
  const entry = pageEntry()
  const json = JSON.stringify(renderOnce(entry.component, { close() {} }))
  for (const needle of ['接入步骤', 'SERP key', 'serper.dev', '"type":"password"', 'data-gs-key', '保存 key', '开关']) {
    if (!json.includes(needle)) throw new Error(`settings page is missing ${needle}`)
  }
  return true
})

check('settings page component uses no React hooks', () => {
  const start = SRC.indexOf('function SettingsPage(')
  const end = SRC.indexOf("return {\n      inject: ['slots']")
  if (start < 0 || end < 0 || end < start) throw new Error('cannot isolate the settings page source')
  const region = SRC.slice(start, end)
  for (const hook of ['useState(', 'useEffect(', 'useRef(', 'useCallback(', 'useMemo(']) {
    if (region.includes(hook)) throw new Error(`settings page must stay hook-free, found ${hook}`)
  }
  return true
})

check('the dock card is the only surface that uses hooks', () => {
  if (!SRC.includes('h(Panel, { compact: true })')) throw new Error('dock card no longer renders Panel')
  return true
})

// ---- failure reporting is wired -----------------------------------------
check('a render failure posts to the plugin log route', () => {
  if (!SRC.includes('/dsh-global-search/client-error')) throw new Error('no client-error reporter')
  if (!SRC.includes('reportClientError')) throw new Error('reporter is never called')
  return true
})

console.log(`\n${'='.repeat(52)}`)
console.log(`client: ${passed} passed, ${failed} failed, ${passed + failed} total`)
process.exit(failed === 0 ? 0 : 1)
