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
}

const BOOLEAN_KEYS = new Set(['enabled', 'capture', 'reuseUpstreamHooks', 'mcp', 'reportUsage', 'messagingGuidance'])
const NUMBER_KEYS = new Set(['mcpToolCallTimeoutMs'])
const STRING_KEYS = new Set([
  'serverUrl', 'token', 'dataDir', 'captureMode', 'mcpServerName', 'projectStrategy', 'workspace', 'project',
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
 */
export function resolveToken(config, env = process.env) {
  const configured = String(config?.token ?? '').trim()
  if (configured) return { token: configured, source: 'panel' }
  return detectToken(config?.dataDir, env)
}
