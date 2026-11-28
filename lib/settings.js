/**
 * Plugin configuration: loader config (from the profile patch) plus a
 * panel-owned settings layer persisted under the plugin state directory.
 *
 * The loader row can only be edited by rewriting the profile patch, which is
 * the operator's file; we do not touch it for our own settings. Instead the
 * panel writes `<state>/settings.json`, and that layer wins over the loader
 * default. Uninstalling the plugin removes the directory and the overrides
 * with it, while the patch default keeps a fresh install sensible.
 *
 * @module dsh-plugin-ai-memory/settings
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { settingsPath, defaultDataDir } from './paths.js'

/** Built-in defaults: a local ai-memory server with capture and MCP on. */
export const DEFAULTS = {
  /** Master switch: false disables capture, MCP sync and hooks staging. */
  enabled: true,
  /** ai-memory server base URL (no `/mcp` suffix), local or remote. */
  serverUrl: 'http://127.0.0.1:49374',
  /** Optional static bearer token; empty means the server runs unauthenticated. */
  token: '',
  /**
   * DSH credential reference holding the bearer (`AI_MEMORY_TOKEN`). When set
   * it wins over `token` and the auto-detected file: the MCP row carries
   * `${credential:<tokenRef>}` (with `expandTemplates: true`) and host-side
   * calls resolve the value through `ctx.credentials` per request, so the
   * secret lives only in the credential store. Empty keeps the literal path.
   */
  tokenRef: '',
  /** ai-memory data directory; empty means the platform default. */
  dataDir: '',
  /** Lifecycle capture on/off. */
  capture: true,
  /**
   * How a captured event is delivered:
   *  - `scripts`: run the upstream ai-memory `hooks/dsh/*.sh` scripts (the
   *    literal hooks the ai-memory repo proposes for DSH);
   *  - `native`: run `ai-memory hook --event … --agent dsh` instead (local
   *    spool + OIDC fallback, but needs the binary on PATH).
   */
  captureMode: 'scripts',
  /** Teach the model when to use the cross-project inbox (system-prompt section). */
  messagingGuidance: true,
  /** Reuse `ai-memory install-hooks`'s staged bundle instead of our copy. */
  reuseUpstreamHooks: false,
  /**
   * Report per-response token usage to ai-memory (`_ai_memory_usage_calls`).
   * The upstream hook scripts never capture model responses, so a DSH session
   * with this off shows "no reported usage".
   */
  reportUsage: true,
  /** Manage an `@deepseek-ai/dsh-mcp-client` row in the profile patch. */
  mcp: true,
  /** MCP server namespace: tools appear as `mcp__<serverName>__<tool>`. */
  mcpServerName: 'ai_memory',
  /** Per-call MCP timeout in milliseconds. */
  mcpToolCallTimeoutMs: 120000,
  /** `''` (server default), `basename` or `repo-root`. */
  projectStrategy: '',
  /** Optional `workspace` value written into a repository `.ai-memory.toml`. */
  workspace: '',
  /** Optional `project` value written into a repository `.ai-memory.toml`. */
  project: '',
  /**
   * Explicit workspace/project → local checkout map
   * (`"guedder/guedder-guedder-ng": "/abs/path"`).
   */
  projectPathMap: {},
  /** Directories to scan (bounded) for `.ai-memory.toml` markers. */
  repoRoots: [],
  /**
   * Preferred DSH agent preset when opening a session from the Inbox.
   * Empty means inherit the current session's preset; never hardcoded to `ptc`.
   */
  defaultAgentPreset: '',
}

const BOOLEAN_KEYS = new Set(['enabled', 'capture', 'reuseUpstreamHooks', 'mcp', 'reportUsage', 'messagingGuidance'])
const NUMBER_KEYS = new Set(['mcpToolCallTimeoutMs'])
const STRING_KEYS = new Set([
  'serverUrl', 'token', 'tokenRef', 'dataDir', 'captureMode', 'mcpServerName', 'projectStrategy', 'workspace', 'project', 'defaultAgentPreset',
])

/** Trim, drop leading/trailing whitespace and trailing slashes from a URL. */
export function normalizeUrl(value) {
  const text = String(value ?? '').trim()
  return text.replace(/\/+$/, '')
}

/**
 * Coerce one raw value for `key`, returning `undefined` when the value is not
 * acceptable so the caller keeps whatever it had.
 * @param {string} key
 * @param {unknown} value
 */
export function coerce(key, value) {
  if (BOOLEAN_KEYS.has(key)) {
    if (typeof value === 'boolean') return value
    if (value === 'true' || value === '1') return true
    if (value === 'false' || value === '0') return false
    return undefined
  }
  if (NUMBER_KEYS.has(key)) {
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), 600000) : undefined
  }
  if (STRING_KEYS.has(key)) {
    if (typeof value !== 'string') return undefined
    return key === 'serverUrl' ? normalizeUrl(value) : value.trim()
  }
  if (key === 'projectPathMap') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const out = {}
    for (const [name, path] of Object.entries(value)) {
      if (typeof name === 'string' && name.includes('/') && typeof path === 'string' && path.trim()) {
        out[name.trim()] = path.trim()
      }
    }
    return out
  }
  if (key === 'repoRoots') {
    if (!Array.isArray(value)) return undefined
    return value.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => entry.trim())
  }
  return undefined
}

/** Keep only known keys with accepted values. */
export function sanitize(patch) {
  const out = {}
  if (!patch || typeof patch !== 'object') return out
  for (const [key, raw] of Object.entries(patch)) {
    const value = coerce(key, raw)
    if (value !== undefined) out[key] = value
  }
  return out
}

/** Read the persisted panel layer, tolerating a missing or corrupt file. */
export function readSettings(env = process.env) {
  try {
    const text = readFileSync(settingsPath(env), 'utf8')
    const parsed = JSON.parse(text)
    return sanitize(parsed)
  } catch {
    return {}
  }
}

/** Persist the panel layer atomically enough for a human-scale config file. */
export function writeSettings(patch, env = process.env) {
  const current = readSettings(env)
  const next = { ...current, ...sanitize(patch) }
  // A credential reference replaces the literal: once the panel layer names a
  // valid ref, the plaintext copy is dropped so the secret lives only in the
  // credential store.
  if (isCredentialRefName(next.tokenRef)) delete next.token
  const path = settingsPath(env)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  return next
}

/**
 * Effective configuration: defaults → loader row config → panel settings.
 * @param {Record<string, unknown> | undefined} loaderConfig
 */
export function resolveConfig(loaderConfig, env = process.env) {
  const fromLoader = sanitize(loaderConfig ?? {})
  const fromPanel = readSettings(env)
  const merged = { ...DEFAULTS, ...fromLoader, ...fromPanel }
  if (!merged.dataDir) merged.dataDir = defaultDataDir(env)
  merged.serverUrl = normalizeUrl(merged.serverUrl) || DEFAULTS.serverUrl
  if (merged.captureMode !== 'native') merged.captureMode = 'scripts'
  if (merged.projectStrategy !== 'basename' && merged.projectStrategy !== 'repo-root') merged.projectStrategy = ''
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(merged.mcpServerName)) merged.mcpServerName = DEFAULTS.mcpServerName
  if (!merged.projectPathMap || typeof merged.projectPathMap !== 'object' || Array.isArray(merged.projectPathMap)) {
    merged.projectPathMap = {}
  }
  if (!Array.isArray(merged.repoRoots)) merged.repoRoots = []
  if (typeof merged.defaultAgentPreset !== 'string') merged.defaultAgentPreset = ''
  // A ref outside the credential grammar could never resolve; treat it as unset
  // so the literal path keeps working instead of writing a dead template.
  if (!isCredentialRefName(merged.tokenRef)) merged.tokenRef = ''
  return merged
}

/** The MCP endpoint for a server base URL (`/mcp` appended once). */
export function mcpUrl(serverUrl) {
  const base = normalizeUrl(serverUrl)
  return /\/mcp$/.test(base) ? base : `${base}/mcp`
}

/** Bearer header value, or `''` when no token is configured. */
export function bearer(token) {
  const text = String(token ?? '').trim()
  return text ? `Bearer ${text}` : ''
}

/**
 * Discover the bearer token ai-memory already persisted for this machine.
 *
 * `ai-memory install-hooks --apply` keeps the bearer out of generated configs
 * (issue #552) and writes it to `<data-dir>/auth-token` plus a ready-made
 * `<data-dir>/auth-header` (both 0600) for the shell hooks to read. Reusing
 * that file means the panel needs no second copy of the secret to reach a
 * server the operator already wired.
 *
 * @returns {{ token: string, source: string }} `source` names where it came from
 */
export function detectToken(dataDir, env = process.env) {
  const dir = dataDir || defaultDataDir(env)
  if (!dir) return { token: '', source: '' }
  try {
    const token = readFileSync(join(dir, 'auth-token'), 'utf8').trim()
    if (token) return { token, source: 'ai-memory auth-token' }
  } catch {
    /* not installed that way */
  }
  try {
    const header = readFileSync(join(dir, 'auth-header'), 'utf8')
    const match = /^\s*authorization:\s*bearer\s+(.+)$/im.exec(header)
    if (match && match[1].trim()) return { token: match[1].trim(), source: 'ai-memory auth-header' }
  } catch {
    /* no header file */
  }
  return { token: '', source: '' }
}

/**
 * The token to authenticate with: the panel's own value when set, otherwise the
 * one ai-memory already stored. Never persisted by us unless the operator types
 * it into the panel.
 *
 * Synchronous, so it cannot read the credential store: with `tokenRef` set it
 * returns an empty token plus `ref`, and callers that need the value use
 * {@link resolveTokenLive}.
 */
export function resolveToken(config, env = process.env) {
  const ref = configuredRef(config)
  if (ref) return { token: '', source: `credential:${ref}`, ref }
  const configured = String(config?.token ?? '').trim()
  if (configured) return { token: configured, source: 'panel' }
  return detectToken(config?.dataDir, env)
}

/**
 * Credential-reference grammar of `@deepseek-ai/dsh-credentials`
 * (`credentialRef`): one POSIX shell identifier.
 */
export const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Whether `value` can name a credential reference. */
export function isCredentialRefName(value) {
  return typeof value === 'string' && CREDENTIAL_REF_PATTERN.test(value)
}

/**
 * Brand a reference for `ctx.credentials`. Mirrors `credentialRef` from
 * `@deepseek-ai/dsh-credentials`, whose brand is the identity at runtime; the
 * plugin ships with no dependencies, so it validates the same grammar instead
 * of importing the Host package.
 */
export function credentialRef(name) {
  if (!isCredentialRefName(name)) throw new TypeError(`credential ref "${name}" must match ${String(CREDENTIAL_REF_PATTERN)}`)
  return name
}

/** The `dsh-mcp-client` runtime template for a reference. */
export function credentialTemplate(ref) {
  return `\${credential:${credentialRef(ref)}}`
}

/** The valid `tokenRef` of a config, or `''`. */
export function configuredRef(config) {
  const ref = String(config?.tokenRef ?? '').trim()
  return isCredentialRefName(ref) ? ref : ''
}

/** The Host credentials service, or `undefined` outside a composition that has one. */
export function credentialsService(ctx) {
  try {
    if (ctx && typeof ctx.get === 'function') return ctx.get('credentials') ?? undefined
  } catch {
    /* optional service */
  }
  return undefined
}

/**
 * Resolve the token for one operation. With `tokenRef` set the value comes
 * from `credentials.resolve` on every call (no cache, nothing written), so a
 * rotation in the credential store applies to the next request; otherwise the
 * literal/auto-detected path of {@link resolveToken}.
 *
 * @returns {Promise<{ token: string, source: string, ref?: string }>}
 */
export async function resolveTokenLive(config, credentials, env = process.env) {
  const ref = configuredRef(config)
  if (!ref) return resolveToken(config, env)
  if (!credentials || typeof credentials.resolve !== 'function') {
    return { token: '', source: `credential:${ref} (no credentials service)`, ref }
  }
  try {
    const hit = await credentials.resolve(credentialRef(ref))
    const token = String(hit?.value ?? '').trim()
    return { token, source: token ? `credential:${ref}` : `credential:${ref} (unset)`, ref }
  } catch {
    return { token: '', source: `credential:${ref} (unreadable)`, ref }
  }
}

/**
 * UI-safe view of the configured reference through `credentials.describe`,
 * which never returns the value.
 *
 * @returns {Promise<{ configured: boolean, source?: string, masked?: string } | null>}
 */
export async function describeTokenRef(config, credentials) {
  const ref = configuredRef(config)
  if (!ref || !credentials || typeof credentials.describe !== 'function') return null
  try {
    const info = await credentials.describe(credentialRef(ref))
    return {
      configured: Boolean(info?.configured),
      ...(typeof info?.source === 'string' ? { source: info.source } : {}),
      ...(typeof info?.masked === 'string' ? { masked: info.masked } : {}),
    }
  } catch {
    return { configured: false }
  }
}
