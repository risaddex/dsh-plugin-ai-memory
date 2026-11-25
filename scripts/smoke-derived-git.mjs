/**
 * `deriveProject` follows the hook's `repo-root` rule: a linked git worktree
 * takes the name of the MAIN repository, whatever its own directory is called.
 * Uses real git in temp directories under a fake home (outside $HOME the marker
 * walk stops at the nearest `.git`). Called from smoke.mjs.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// The fake HOME hides the user's gitconfig, so identity and defaults are inline.
const GIT_FLAGS = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main']
const git = (cwd, ...args) => execFileSync('git', [...GIT_FLAGS, ...args], { cwd, stdio: 'ignore' })

function initRepo(dir) {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init')
  git(dir, 'commit', '--allow-empty', '-m', 'x')
}

export async function runDerivedGitChecks({ check, ROOT }) {
  const pm = await import('../lib/project-map.js')
  const inbox = await import('../lib/inbox.js')

  const realHome = process.env.HOME
  const realPath = process.env.PATH
  const home = join(ROOT, 'derived-git-home')
  const keys = (scopes) => scopes.map((s) => `${s.workspace}/${s.project}`).sort()
  const cfgFor = (...roots) => ({ projectPathMap: {}, repoRoots: roots })
  const marker = (dir, content) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '.ai-memory.toml'), content)
  }

  rmSync(home, { recursive: true, force: true })
  process.env.HOME = home
  try {
    // Main repo plus a worktree that is a SIBLING directory under the workspace.
    const acme = join(home, 'work', 'acme')
    marker(acme, 'workspace = "acme"\n')
    const main = join(acme, 'main-repo')
    initRepo(main)
    const sibling = join(acme, 'wt-outside')
    git(main, 'worktree', 'add', '../wt-outside', '-b', 'b1')

    pm.clearDeriveCache()
    check('a worktree outside the repo tree takes the main repo name', pm.deriveProject(sibling) === 'main-repo', pm.deriveProject(sibling))
    check('the main repo derives its own name', pm.deriveProject(main) === 'main-repo')
    const rows = pm.deriveRepoScopes(cfgFor(acme), [])
    check('deriveRepoScopes keeps main repo and worktree rows, both named after main', rows.length === 2 && rows.every((r) => r.project === 'main-repo') && rows.map((r) => r.dir).includes(sibling), JSON.stringify(rows))
    pm.clearDeriveCache()
    const one = inbox.collectScopes(cfgFor(acme), {})
    check('main repo and its sibling worktree yield exactly one scope', JSON.stringify(keys(one.scopes)) === JSON.stringify(['acme/main-repo']), JSON.stringify(one.scopes))

    // A worktree outside every repoRoot, reached only as an extra dir / cwd.
    const far = join(acme, 'x', 'y', 'z', 'wt-extra')
    git(main, 'worktree', 'add', far, '-b', 'b2')
    pm.clearDeriveCache()
    check('a worktree outside every repoRoot resolves to the main repo name', pm.deriveProject(far) === 'main-repo', pm.deriveProject(far))
    const viaExtra = inbox.collectScopes(cfgFor(main), { extraDirs: [far], cwd: far })
    check('an extra-dir worktree is deduped with the main repo', JSON.stringify(keys(viaExtra.scopes)) === JSON.stringify(['acme/main-repo']), JSON.stringify(viaExtra.scopes))
    const viaExtraRows = pm.deriveRepoScopes(cfgFor(main), [far])
    check('the extra-dir worktree is reached and named after main', viaExtraRows.some((r) => r.dir === far && r.project === 'main-repo'), JSON.stringify(viaExtraRows))

    // A renamed clone keeps its directory name, not its remote's name.
    const clones = join(acme, 'clones')
    const orig = join(clones, 'orig-name')
    initRepo(orig)
    git(orig, 'remote', 'add', 'origin', 'https://example.com/acme/other-name.git')
    const renamed = join(clones, 'renamed-dir')
    renameSync(orig, renamed)
    pm.clearDeriveCache()
    check('a renamed clone resolves to its directory, not the remote name', pm.deriveProject(renamed) === 'renamed-dir', pm.deriveProject(renamed))

    // An empty fake .git directory is not a repository: basename, no throw.
    const fake = join(acme, 'fake-repo')
    mkdirSync(join(fake, '.git'), { recursive: true })
    pm.clearDeriveCache()
    let fakeName = ''
    let fakeThrew = false
    try { fakeName = pm.deriveProject(fake) } catch { fakeThrew = true }
    check('an empty fake .git directory falls back to the basename', !fakeThrew && fakeName === 'fake-repo', fakeName)

    // No git on PATH: basename, no throw.
    pm.clearDeriveCache()
    process.env.PATH = ''
    let noGit = ''
    let noGitThrew = false
    try { noGit = pm.deriveProject(sibling) } catch { noGitThrew = true } finally { process.env.PATH = realPath }
    check('without git on PATH deriveProject falls back to the basename', !noGitThrew && noGit === 'wt-outside', noGit)

    // Cache: a deleted worktree still answers from the cache until it is cleared.
    const cached = join(acme, 'wt-cache')
    git(main, 'worktree', 'add', '../wt-cache', '-b', 'b3')
    pm.clearDeriveCache()
    const first = pm.deriveProject(cached)
    rmSync(cached, { recursive: true, force: true })
    const second = pm.deriveProject(cached)
    pm.clearDeriveCache()
    const third = pm.deriveProject(cached)
    check('the first call resolves the main repo name', first === 'main-repo', first)
    check('a second call is served from the cache without running git', second === 'main-repo', second)
    check('clearDeriveCache makes it fall back to the basename', third === 'wt-cache', third)
  } finally {
    process.env.PATH = realPath
    process.env.HOME = realHome
    pm.clearDeriveCache()
  }
}
