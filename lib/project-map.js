/**
 * Map an ai-memory workspace/project pair to a local checkout, using
 * `.ai-memory.toml` markers, an explicit settings map, and known directories.
 *
 * @module dsh-plugin-ai-memory/project-map
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve as resolvePath, sep } from 'node:path'
import { homedir } from 'node:os'
import { clearDeriveCache, deriveProject } from './repo-root.js'

const MARKER = '.ai-memory.toml'
const MAX_WALK = 40
const MAX_SCAN_DEPTH = 2
const MAX_SCAN_ENTRIES = 400

/**
 * Parse a single TOML key from a marker file (quoted or bare value).
 * Matches the line-based parser in `assets/hooks/_lib.sh`.
 * @param {string} text
 * @param {string} key
 * @returns {string}
 */
export function parseTomlKey(text, key) {
  const re = new RegExp(
    `^\\s*${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^#\\r\\n]+))`,
    'm',
  )
  const match = String(text ?? '').match(re)
  if (!match) return ''
  return String(match[1] ?? match[2] ?? match[3] ?? '').trim()
}

/** Read workspace/project/strategy from a marker file or raw text. */
export function parseMarker(source) {
  let text = ''
  let path = ''
  if (typeof source === 'string' && source.includes('=') && !source.endsWith('.toml') && !existsSync(source)) {
    text = source
  } else if (typeof source === 'string') {
    path = source
    try {
      text = readFileSync(source, 'utf8')
    } catch {
      return { path, workspace: '', project: '', projectStrategy: '' }
    }
  } else {
    return { path: '', workspace: '', project: '', projectStrategy: '' }
  }
  return {
    path,
    workspace: parseTomlKey(text, 'workspace'),
    project: parseTomlKey(text, 'project'),
    projectStrategy: parseTomlKey(text, 'project_strategy'),
  }
}

const WS = '[ \\t\\r\\f\\v]'
const stripBom = (text) => String(text).replace(/^\uFEFF/, '')

// sed -E "s/^[[:space:]]*KEY[[:space:]]*=[[:space:]]*\"([^\"]*)\".*/\1/p" | head -n 1
// (ai_memory_parse_toml_key): quoted values only, section-blind.
function hookKey(text, key) {
  const match = stripBom(text).match(new RegExp(`^${WS}*${key}${WS}*=${WS}*"([^"\\n]*)"`, 'm'))
  return match ? match[1] : ''
}

// ai_memory_parse_toml_flag: quoted or bare, up to a quote or `#`, right-trimmed.
function hookFlag(text, key) {
  const match = stripBom(text).match(new RegExp(`^${WS}*${key}${WS}*=${WS}*"?([^"#\\n]*)"?`, 'm'))
  return match ? match[1].replace(/\s+$/, '') : ''
}

const SETTINGS_KEYS = ['workspace', 'project', 'project_strategy', 'drop_subagent_captures', 'identity', 'identity_style']
const SETTINGS_FLAGS = [
  'default_global', 'inject_on_session_start', 'inject_on_subagent_start', 'max_chars',
  'contribute', 'consume', 'deliver_on_session_start',
]

/**
 * Port of `ai_memory_marker_declares_settings` (assets/hooks/_lib.sh). Only a
 * marker that declares none of these is transparent to scope resolution (for
 * example a bare `[capture]` file). Anything else, including a strategy-only
 * or identity-only marker, is a resolution boundary. An unreadable marker
 * counts as declaring settings, like the hook's server test.
 * @param {string} path
 */
export function markerDeclaresSettings(path) {
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return true
  }
  if (SETTINGS_KEYS.some((key) => hookKey(text, key))) return true
  if (new RegExp(`^${WS}*aliases${WS}*=`, 'm').test(stripBom(text))) return true
  if (SERVER_KEY.test(text)) return true
  return SETTINGS_FLAGS.some((key) => hookFlag(text, key))
}

// Same line-based, section-blind test as ai_memory_marker_declares_server in
// assets/hooks/_lib.sh: `server = ...` in any value shape. `server_url` does not match.
const SERVER_KEY = /^[^A-Za-z0-9_#"\n]*server[ \t]*=/m

/**
 * Whether a marker file selects a named server. An unreadable marker counts as
 * declaring one, as in the hook.
 * @param {string} path
 */
export function markerDeclaresServer(path) {
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return true
  }
  return SERVER_KEY.test(text)
}

/**
 * Whether any marker on the walk from `cwd` selects a named server (hooks'
 * `ai_memory_server_routed`). Such a checkout is not served by the plugin-wide
 * `serverUrl`, so the panel must not read or write mail for it there.
 * @param {string} cwd
 */
export function serverRoutedFor(cwd) {
  if (!cwd) return false
  let dir = ''
  try {
    dir = resolvePath(cwd)
  } catch {
    return false
  }
  let home = ''
  try {
    home = resolvePath(homedir() || '')
  } catch {
    home = ''
  }
  const boundary = home && (dir === home || dir.startsWith(home + sep)) ? home : ''
  for (let i = 0; i < MAX_WALK; i += 1) {
    const candidate = join(dir, MARKER)
    if (existsSync(candidate) && markerDeclaresServer(candidate)) return true
    if (dir === boundary) return false
    const parent = dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
  return false
}

const isFile = (path) => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Port of `ai_memory_find_settings_marker`: walk up from `cwd` to the nearest
 * marker that declares settings (capture-only markers are skipped). The
 * marker in the home directory always counts. The walk stops at the home
 * directory, or, for a directory outside home, at the nearest `.git` root (the
 * directory itself when there is none), so a marker above the repository is
 * never inherited.
 * @param {string} cwd
 * @returns {string} absolute path to the marker, or ''
 */
export function findMarkerPath(cwd) {
  let dir = ''
  try {
    dir = resolvePath(cwd || '')
  } catch {
    return ''
  }
  if (!dir) return ''
  let home = ''
  try {
    home = resolvePath(homedir() || '')
  } catch {
    home = ''
  }
  let boundary = ''
  if (home) {
    if (dir === home || dir.startsWith(home + sep)) {
      boundary = home
    } else {
      let probe = dir
      for (let i = 0; i < MAX_WALK; i += 1) {
        if (existsSync(join(probe, '.git'))) {
          boundary = probe
          break
        }
        const up = dirname(probe)
        if (up === probe) break
        probe = up
      }
      if (!boundary) boundary = dir
    }
  }
  for (let i = 0; i < MAX_WALK; i += 1) {
    const parent = dirname(dir)
    if (parent === dir) return '' // the filesystem root is never checked
    const candidate = join(dir, MARKER)
    if (isFile(candidate)) {
      if (home && dir === home) return candidate
      if (markerDeclaresSettings(candidate)) return candidate
    }
    if (boundary && dir === boundary) return ''
    dir = parent
  }
  return ''
}

/** Parse the nearest marker above `cwd`, or an empty marker. */
export function findMarker(cwd) {
  const path = findMarkerPath(cwd)
  const marker = path ? parseMarker(path) : { path: '', workspace: '', project: '', projectStrategy: '' }
  return { ...marker, serverRouted: serverRoutedFor(cwd) }
}

/** `workspace/project` key used in the settings map. */
export function scopeKey(workspace, project) {
  return `${String(workspace || '').trim()}/${String(project || '').trim()}`
}

/**
 * Shared bounded directory walk (depth and entry caps, dedupe by resolved
 * path). `visit(realDir)` runs once per visited directory; returning `false`
 * makes it a leaf (its children are not walked).
 * @param {string[]} roots
 * @param {number} depthLimit
 * @param {(dir: string) => boolean | void} visit
 * @param {(name: string) => boolean} skipName child names to skip
 */
function walkDirs(roots, depthLimit, visit, skipName) {
  const seen = new Set()
  let visited = 0

  const walk = (dir, depth) => {
    if (visited >= MAX_SCAN_ENTRIES) return
    let real = ''
    try {
      real = resolvePath(dir)
    } catch {
      return
    }
    if (!real || seen.has(real) || !existsSync(real)) return
    let stat
    try {
      stat = statSync(real)
    } catch {
      return
    }
    if (!stat.isDirectory()) return
    seen.add(real)
    visited += 1
    if (visit(real) === false) return
    if (depth >= depthLimit) return
    let entries = []
    try {
      entries = readdirSync(real)
    } catch {
      return
    }
    for (const name of entries) {
      if (skipName(name)) continue
      walk(join(real, name), depth + 1)
    }
  }

  for (const root of roots || []) {
    if (typeof root === 'string' && root.trim()) walk(root.trim(), 0)
  }
}

/**
 * Bounded walk of `roots` looking for marker files.
 * @param {string[]} roots
 * @param {{ depth?: number }} [opts]
 * @returns {{ path: string, dir: string, workspace: string, project: string, projectStrategy: string }[]}
 */
export function scanMarkers(roots, opts = {}) {
  const depthLimit = Number.isFinite(opts.depth) ? opts.depth : MAX_SCAN_DEPTH
  const found = []
  walkDirs(roots, depthLimit, (real) => {
    const markerPath = join(real, MARKER)
    if (existsSync(markerPath)) {
      const parsed = parseMarker(markerPath)
      found.push({ ...parsed, dir: real, path: markerPath, serverRouted: serverRoutedFor(real) })
    }
  }, (name) => name.startsWith('.') && name !== MARKER)
  return found
}

/**
 * Bounded walk of `roots` looking for git repositories (a `.git` directory or
 * file). A repository is a leaf: the walk does not descend into it.
 * @param {string[]} roots
 * @param {{ depth?: number }} [opts]
 * @returns {string[]} resolved repository directories
 */
export function scanRepos(roots, opts = {}) {
  const depthLimit = Number.isFinite(opts.depth) ? opts.depth : MAX_SCAN_DEPTH
  const found = []
  walkDirs(roots, depthLimit, (real) => {
    if (existsSync(join(real, '.git'))) {
      found.push(real)
      return false
    }
    return true
  }, (name) => name.startsWith('.'))
  return found
}

// Nearest directory at or above `dir` that contains `.git` (bounded), or ''.
function nearestRepoRoot(dir) {
  let probe = ''
  try {
    probe = resolvePath(dir)
  } catch {
    return ''
  }
  for (let i = 0; i < MAX_WALK; i += 1) {
    if (existsSync(join(probe, '.git'))) return probe
    const up = dirname(probe)
    if (up === probe) return ''
    probe = up
  }
  return ''
}

/**
 * Scopes derived from git repositories whose nearest settings marker declares
 * a `workspace` but no `project`: one row per repository, with the project
 * taken from `deriveProject`. Rows are NOT deduplicated by scope (two
 * checkouts may share a name) and are sorted by `dir` length, then
 * alphabetically, so a later pick is stable.
 * @param {object} config
 * @param {string[]} [extraDirs]
 * @returns {{ workspace: string, project: string, dir: string, path: string, serverRouted: boolean, source: 'derivado' }[]}
 */
export function deriveRepoScopes(config, extraDirs = []) {
  const dirs = extraDirs || []
  const roots = [
    ...((config && Array.isArray(config.repoRoots) && config.repoRoots) || []),
    ...dirs,
    ...markerRootsFor(dirs),
    ...dirs.map((dir) => nearestRepoRoot(dir)).filter(Boolean),
  ]
  const rows = []
  for (const dir of scanRepos(roots)) {
    const marker = findMarker(dir)
    if (!marker.workspace || marker.project) continue
    const project = deriveProject(dir)
    if (!project) continue
    rows.push({
      workspace: marker.workspace,
      project,
      dir,
      path: dir,
      serverRouted: Boolean(marker.serverRouted),
      source: 'derivado',
    })
  }
  return rows.sort((a, b) => a.dir.length - b.dir.length || a.dir.localeCompare(b.dir))
}

/**
 * For each directory, the directory holding its nearest `.ai-memory.toml`
 * (walking up). Lets a subdirectory cwd such as `<repo>/src` resolve to the
 * repository root marker, matching `collectScopes`.
 * @param {string[]} dirs
 * @returns {string[]}
 */
export function markerRootsFor(dirs) {
  const out = []
  for (const dir of dirs || []) {
    const path = findMarkerPath(dir)
    if (path) out.push(dirname(path))
  }
  return out
}

/**
 * Resolve a local checkout for `workspace`/`project`.
 *
 * Precedence: explicit `projectPathMap`, then a scanned/known marker that
 * declares the same names, then (last) a cwd whose basename already matches
 * and which has no conflicting marker.
 *
 * @param {object} config effective plugin config
 * @param {string} workspace
 * @param {string} project
 * @param {string[]} [extraDirs] recent session cwds / current working directory
 * @returns {{ path: string, source: string, matches?: object[] } | { path: null, source: string, matches: object[] }}
 */
export function resolveProjectPath(config, workspace, project, extraDirs = []) {
  const ws = String(workspace || '').trim()
  const pr = String(project || '').trim()
  if (!ws || !pr) return { path: null, source: 'none', matches: [] }

  const key = scopeKey(ws, pr)
  const mapped = config && config.projectPathMap && config.projectPathMap[key]
  if (typeof mapped === 'string' && mapped.trim() && existsSync(mapped.trim())) {
    return { path: resolvePath(mapped.trim()), source: 'settings' }
  }

  const roots = [
    ...((config && Array.isArray(config.repoRoots) && config.repoRoots) || []),
    ...extraDirs,
    ...markerRootsFor(extraDirs),
  ]
  const markers = scanMarkers(roots)
  // A server-routed checkout is another server's project, not this one.
  const matches = markers.filter((row) => row.workspace === ws && row.project === pr && !row.serverRouted)
  if (matches.length === 1) return { path: matches[0].dir, source: 'marker', matches }
  if (matches.length > 1) {
    // Stable pick: shortest path, but surface every match so the UI can ask.
    const sorted = matches.slice().sort((a, b) => a.dir.length - b.dir.length)
    return { path: sorted[0].dir, source: 'marker-ambiguous', matches: sorted }
  }
  return { path: null, source: 'unmapped', matches: [] }
}

/**
 * Build the panel's project → path table.
 * @param {object} config
 * @param {string[]} [extraDirs]
 */
export function listProjectMap(config, extraDirs = []) {
  const rows = []
  const seen = new Set()
  const push = (workspace, project, path, source, serverRouted = false) => {
    const key = scopeKey(workspace, project)
    if (!workspace || !project || seen.has(key)) return
    seen.add(key)
    rows.push({ workspace, project, key, path: path || null, source, serverRouted })
  }

  const map = (config && config.projectPathMap) || {}
  for (const [key, path] of Object.entries(map)) {
    const [workspace, ...rest] = String(key).split('/')
    const mapped = typeof path === 'string' ? path : ''
    push(workspace, rest.join('/'), mapped, 'settings', mapped ? serverRoutedFor(mapped) : false)
  }
  for (const row of scanMarkers([
    ...((config && config.repoRoots) || []),
    ...extraDirs,
    ...markerRootsFor(extraDirs),
  ])) {
    push(row.workspace, row.project, row.dir, 'marker', Boolean(row.serverRouted))
  }
  // Last, so a declared project always wins the `workspace/project` key.
  for (const row of deriveRepoScopes(config, extraDirs)) {
    push(row.workspace, row.project, row.dir, row.source, row.serverRouted)
  }
  return rows
}

const SCOPE_KEYS = ['workspace', 'project', 'project_strategy']

/**
 * Merge the scope keys into an existing `.ai-memory.toml` without touching
 * anything else. Only top-level `workspace` / `project` / `project_strategy`
 * lines are replaced (duplicates dropped); missing keys are inserted before the
 * first `[table]` header. Comments, `[capture]`, `[profile]`, identity and
 * other settings stay exactly as they were.
 * @param {string} text current marker contents
 * @param {{ workspace?: string, project?: string, projectStrategy?: string }} scope
 * @returns {string}
 */
export function mergeMarkerScope(text, scope) {
  const values = {
    workspace: scope.workspace ? String(scope.workspace) : '',
    project: scope.project ? String(scope.project) : '',
    project_strategy: scope.projectStrategy === 'basename' || scope.projectStrategy === 'repo-root'
      ? scope.projectStrategy
      : '',
  }
  const out = []
  const done = new Set()
  let inTable = false
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) inTable = true
    const match = inTable ? null : line.match(/^\s*(workspace|project|project_strategy)\s*=/)
    if (!match) {
      out.push(line)
      continue
    }
    const key = match[1]
    if (done.has(key)) continue
    done.add(key)
    out.push(values[key] ? `${key} = ${JSON.stringify(values[key])}` : line)
  }
  const additions = SCOPE_KEYS
    .filter((key) => values[key] && !done.has(key))
    .map((key) => `${key} = ${JSON.stringify(values[key])}`)
  if (additions.length) {
    const firstTable = out.findIndex((line) => /^\s*\[/.test(line))
    const at = firstTable === -1 ? out.length : firstTable
    out.splice(at, 0, ...additions)
  }
  const joined = out.join('\n')
  return joined.endsWith('\n') ? joined : joined + '\n'
}

/**
 * Unique existing directories from a mixed list (session cwds, roots, …).
 * @param {unknown[]} dirs
 * @returns {string[]}
 */
export function uniqueExistingDirs(dirs) {
  const out = []
  const seen = new Set()
  for (const raw of dirs || []) {
    if (typeof raw !== 'string' || !raw.trim()) continue
    let dir = ''
    try {
      dir = resolvePath(raw.trim())
    } catch {
      continue
    }
    if (!dir || seen.has(dir) || !existsSync(dir)) continue
    seen.add(dir)
    out.push(dir)
  }
  return out
}

export { MARKER, clearDeriveCache, deriveProject }
