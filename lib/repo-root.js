/**
 * Project name for a repository directory, following the hook's `repo-root`
 * rule (`ai_memory_repo_root_project` in assets/hooks/_lib.sh). Kept apart from
 * project-map.js so the git calls and their cache live in one small module.
 *
 * @module dsh-plugin-ai-memory/repo-root
 */

import { execFileSync } from 'node:child_process'
import { basename, dirname, resolve as resolvePath } from 'node:path'

const DERIVE_TTL_MS = 5000
const DERIVE_CACHE_MAX = 500
const GIT_OPTS = { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }
const deriveCache = new Map()

/** Drop every cached `deriveProject` result (tests, or after git state changes). */
export function clearDeriveCache() {
  deriveCache.clear()
}

// Port of `ai_memory_repo_root_project` (assets/hooks/_lib.sh): the basename of
// the MAIN repository root, following the worktree common dir. Returns '' when
// git is missing, times out, fails, `dir` is not in a work tree, or the result
// is empty or `/`. No shell is involved and nothing throws.
function gitRepoRootName(dir) {
  try {
    const inside = execFileSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], GIT_OPTS)
    if (String(inside).trim() !== 'true') return ''
    const common = String(execFileSync(
      'git',
      ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      GIT_OPTS,
    )).trim()
    if (!common) return ''
    const root = dirname(common)
    if (!root || root === '/') return ''
    const name = basename(root)
    return name === '/' ? '' : name
  } catch {
    return ''
  }
}

/**
 * The project name derived for a repository directory, following the hook's
 * `repo-root` rule: a linked worktree takes the name of its MAIN repository
 * (the parent of the git common dir). Falls back to `basename(dir)` whenever
 * git cannot answer. Results are cached per resolved directory for a few
 * seconds because the Inbox derives on every list.
 * @param {string} dir
 * @returns {string}
 */
export function deriveProject(dir) {
  let real = ''
  try {
    real = resolvePath(dir)
  } catch {
    return ''
  }
  const now = Date.now()
  const hit = deriveCache.get(real)
  if (hit && now - hit.at < DERIVE_TTL_MS) return hit.value
  const value = gitRepoRootName(real) || basename(real)
  if (deriveCache.size >= DERIVE_CACHE_MAX) deriveCache.clear()
  deriveCache.set(real, { value, at: now })
  return value
}
