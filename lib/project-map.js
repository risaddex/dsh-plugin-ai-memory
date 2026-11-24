/**
 * Map an ai-memory workspace/project pair to a local checkout, using
 * `.ai-memory.toml` markers, an explicit settings map, and known directories.
 *
 * @module dsh-plugin-ai-memory/project-map
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { homedir } from 'node:os'

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

/**
 * A marker declares scope when it names a workspace or project. A capture-only
 * marker (for example just `[capture]`) is transparent: the walk continues, as
 * `ai_memory_find_settings_marker` does in assets/hooks/_lib.sh.
 * @param {string} path
 */
function declaresScope(path) {
  const parsed = parseMarker(path)
  return Boolean(parsed.workspace || parsed.project)
}

/**
 * Walk up from `cwd` looking for `.ai-memory.toml`. Stops at the home
 * directory's parent or the filesystem root.
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
  const home = (() => {
    try {
      return resolvePath(homedir() || '')
    } catch {
      return ''
    }
  })()
  for (let i = 0; i < MAX_WALK; i += 1) {
    const candidate = join(dir, MARKER)
    if (existsSync(candidate) && declaresScope(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    if (home && dir === home) break
    dir = parent
  }
  return ''
}

/** Parse the nearest marker above `cwd`, or an empty marker. */
export function findMarker(cwd) {
  const path = findMarkerPath(cwd)
  return path ? parseMarker(path) : { path: '', workspace: '', project: '', projectStrategy: '' }
}

/** `workspace/project` key used in the settings map. */
export function scopeKey(workspace, project) {
  return `${String(workspace || '').trim()}/${String(project || '').trim()}`
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
    const markerPath = join(real, MARKER)
    if (existsSync(markerPath)) {
      const parsed = parseMarker(markerPath)
      found.push({ ...parsed, dir: real, path: markerPath })
    }
    if (depth >= depthLimit) return
    let entries = []
    try {
      entries = readdirSync(real)
    } catch {
      return
    }
    for (const name of entries) {
      if (name.startsWith('.') && name !== MARKER) continue
      walk(join(real, name), depth + 1)
    }
  }

  for (const root of roots || []) {
    if (typeof root === 'string' && root.trim()) walk(root.trim(), 0)
  }
  return found
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
  const matches = markers.filter((row) => row.workspace === ws && row.project === pr)
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
  const push = (workspace, project, path, source) => {
    const key = scopeKey(workspace, project)
    if (!workspace || !project || seen.has(key)) return
    seen.add(key)
    rows.push({ workspace, project, key, path: path || null, source })
  }

  const map = (config && config.projectPathMap) || {}
  for (const [key, path] of Object.entries(map)) {
    const [workspace, ...rest] = String(key).split('/')
    push(workspace, rest.join('/'), typeof path === 'string' ? path : '', 'settings')
  }
  for (const row of scanMarkers([
    ...((config && config.repoRoots) || []),
    ...extraDirs,
    ...markerRootsFor(extraDirs),
  ])) {
    push(row.workspace, row.project, row.dir, 'marker')
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

export { MARKER }
