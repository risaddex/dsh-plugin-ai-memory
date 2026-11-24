/**
 * Settings-marker boundaries, ported from ai_memory_find_settings_marker in
 * assets/hooks/_lib.sh: only a capture-only marker is transparent; a strategy,
 * identity, alias or flag marker is a boundary; the walk stops at the git root
 * and at home. Called from smoke.mjs.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export async function runMarkerChecks({ check, ROOT }) {
  const pm = await import('../lib/project-map.js')
  const { guidanceText } = await import('../lib/prompt.js')
  const safe = (fn, fallback) => { try { return fn() } catch (error) { return fallback ?? { error: error.message } } }

  const repo = join(ROOT, 'repo-bound')
  mkdirSync(join(repo, '.git'), { recursive: true })
  writeFileSync(join(repo, '.ai-memory.toml'), 'workspace = "outer"\nproject = "outer-project"\n')
  const child = (name, content) => {
    const dir = join(repo, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '.ai-memory.toml'), content)
    return dir
  }
  const scopeOf = (dir) => safe(() => pm.findMarker(dir), {})

  // 26. Predicate parity: which markers stop the walk.
  const cases = [
    ['strategy-only', 'project_strategy = "basename"\n', true],
    ['identity-only', 'identity = "me"\n', true],
    ['aliases', 'aliases = ["a"]\n', true],
    ['server', 'server = "prod"\n', true],
    ['flag contribute', 'contribute = false\n', true],
    ['flag max_chars bare', 'max_chars = 4000 # cap\n', true],
    ['capture-only', '[capture]\nignore_paths = ["x"]\n', false],
    ['unquoted drop_subagent_captures (hook reads quoted only)', '[capture]\ndrop_subagent_captures = true\n', false],
    ['empty values', 'workspace = ""\nproject = ""\n', false],
    ['comment only', '# nothing here\n', false],
  ]
  for (const [name, content, boundary] of cases) {
    const dir = child(`c-${name.replace(/[^a-z]/gi, '')}`, content)
    const found = safe(() => pm.findMarkerPath(dir), '')
    const stopsHere = found === join(dir, '.ai-memory.toml')
    check(`marker ${name} ${boundary ? 'is' : 'is not'} a boundary`, stopsHere === boundary, found)
  }

  // 27. The reported case: a strategy-only child must not inherit outer scope.
  const strategyDir = child('strategy-child', 'project_strategy = "basename"\n')
  const strategyScope = scopeOf(strategyDir)
  check('strategy-only child does not inherit the outer scope', strategyScope.workspace === '' && strategyScope.project === '', JSON.stringify(strategyScope))
  const captureDir = child('capture-child', '[capture]\nignore_paths = ["x"]\n')
  const captureScope = scopeOf(captureDir)
  check('capture-only child still inherits the outer scope', captureScope.workspace === 'outer' && captureScope.project === 'outer-project', JSON.stringify(captureScope))
  const guidance = guidanceText(strategyScope)
  check('guidance for a strategy-only child does not use the outer names', !guidance.includes('outer-project') && !guidance.includes('Pass these exact names'))

  // 28. Boundaries: git root stops the walk, the home marker always counts.
  const above = join(ROOT, 'above-git')
  mkdirSync(join(above, 'repo', '.git'), { recursive: true })
  mkdirSync(join(above, 'repo', 'src'), { recursive: true })
  writeFileSync(join(above, '.ai-memory.toml'), 'workspace = "parent"\nproject = "parent-project"\n')
  check('a marker above the git root is not inherited', safe(() => pm.findMarkerPath(join(above, 'repo', 'src')), 'x') === '', 'x')
  const bare = join(ROOT, 'no-git', 'sub')
  mkdirSync(bare, { recursive: true })
  writeFileSync(join(ROOT, 'no-git', '.ai-memory.toml'), 'workspace = "g"\nproject = "g-p"\n')
  check('without a git root only the cwd itself is searched', safe(() => pm.findMarkerPath(bare), 'x') === '')

  const realHome = process.env.HOME
  const home = join(ROOT, 'fake-home')
  mkdirSync(join(home, 'work', 'proj'), { recursive: true })
  writeFileSync(join(home, '.ai-memory.toml'), '[capture]\nignore_paths = ["x"]\n')
  writeFileSync(join(ROOT, '.ai-memory.toml'), 'workspace = "above-home"\nproject = "above-home-p"\n')
  process.env.HOME = home
  const underHome = safe(() => pm.findMarkerPath(join(home, 'work', 'proj')), 'x')
  const atHome = safe(() => pm.findMarkerPath(home), 'x')
  process.env.HOME = realHome
  check('the home marker counts even when capture-only', underHome === join(home, '.ai-memory.toml') && atHome === join(home, '.ai-memory.toml'), `${underHome} | ${atHome}`)
  check('the walk never goes above home', underHome !== join(ROOT, '.ai-memory.toml'))
}
