/**
 * Scopes derived from git repositories under a workspace-only marker: one
 * `workspace/<basename>` per repository, shown as `source: 'derivado'`.
 * Built under a fake home because, outside $HOME, the marker walk stops at the
 * nearest `.git` and a marker above a repository would not be inherited.
 * Called from smoke.mjs.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export async function runDerivedChecks({ check, ROOT }) {
  const pm = await import('../lib/project-map.js')
  const inbox = await import('../lib/inbox.js')

  const realHome = process.env.HOME
  const home = join(ROOT, 'derived-home')
  const work = join(home, 'work')
  const repo = (dir) => mkdirSync(join(dir, '.git'), { recursive: true })
  const marker = (dir, content) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '.ai-memory.toml'), content)
  }
  const keys = (scopes) => scopes.map((s) => `${s.workspace}/${s.project}`).sort()
  const calls = []
  const spy = async (name, args) => { calls.push(args); return { messages: [] } }
  const cfgFor = (...roots) => ({ projectPathMap: {}, repoRoots: roots })

  process.env.HOME = home
  try {
    // Workspace-only marker above two repos and a plain directory.
    const acme = join(work, 'acme')
    marker(acme, 'workspace = "acme"\n')
    repo(join(acme, 'repo-one'))
    repo(join(acme, 'repo-two'))
    mkdirSync(join(acme, 'plain-dir', 'inner'), { recursive: true })
    const found = inbox.collectScopes(cfgFor(acme), {})
    check('workspace-only marker lists one derived scope per repo', JSON.stringify(keys(found.scopes)) === JSON.stringify(['acme/repo-one', 'acme/repo-two']), JSON.stringify(found.scopes))
    check('derived scopes carry source derivado', found.scopes.length === 2 && found.scopes.every((s) => s.source === 'derivado'), JSON.stringify(found.scopes))
    check('a non-git directory under the marker yields nothing', !keys(found.scopes).some((k) => /plain-dir|inner/.test(k)), JSON.stringify(found.scopes))
    const rows = pm.deriveRepoScopes(cfgFor(acme), [])
    check('deriveRepoScopes returns dir, path and serverRouted', rows.length === 2 && rows.every((r) => r.dir === r.path && r.serverRouted === false && r.source === 'derivado'), JSON.stringify(rows))
    check('deriveProject is the directory basename', pm.deriveProject(join(acme, 'repo-one')) === 'repo-one')

    // A cwd inside a repo still yields the repo (ancestor .git root).
    const fromSrc = join(acme, 'repo-one', 'src')
    mkdirSync(fromSrc, { recursive: true })
    const viaCwd = pm.deriveRepoScopes(cfgFor(), [fromSrc])
    check('a cwd inside a repo yields its repo', viaCwd.some((r) => r.project === 'repo-one' && r.workspace === 'acme' && r.dir === join(acme, 'repo-one')), JSON.stringify(viaCwd))

    // A repo that declares its own project is not derived, and keeps its source.
    const mixed = join(work, 'mixed')
    marker(mixed, 'workspace = "acme"\n')
    repo(join(mixed, 'derived-repo'))
    repo(join(mixed, 'own'))
    marker(join(mixed, 'own'), 'workspace = "acme"\nproject = "declared-own"\n')
    const mixedScopes = inbox.collectScopes(cfgFor(mixed), {}).scopes
    const own = mixedScopes.find((s) => s.project === 'declared-own')
    check('a repo with its own project keeps source marker', Boolean(own) && own.source === 'marker', JSON.stringify(mixedScopes))
    check('a repo with its own project adds no extra derived scope', JSON.stringify(keys(mixedScopes)) === JSON.stringify(['acme/declared-own', 'acme/derived-repo']) && !mixedScopes.some((s) => s.project === 'own'), JSON.stringify(mixedScopes))

    // A server-routed marker: skipped, never queried.
    const prod = join(work, 'prod')
    marker(prod, 'workspace = "prodws"\nserver = "prod"\n')
    repo(join(prod, 'repo-r'))
    const routed = inbox.collectScopes(cfgFor(prod), {})
    check('a server-routed derived repo is skipped, not a scope', routed.scopes.length === 0 && routed.skipped.some((s) => s.workspace === 'prodws' && s.project === 'repo-r' && s.source === 'derivado'), JSON.stringify(routed))
    calls.length = 0
    const routedList = await inbox.listInbox(spy, cfgFor(prod), {})
    check('a server-routed derived repo is never queried', calls.length === 0, JSON.stringify(calls))
    check('a server-routed derived repo is reported as not queried', routedList.errors.some((e) => /named server/.test(e.error) && e.project === 'repo-r'), JSON.stringify(routedList.errors))

    // Same basename under the same workspace: one scope.
    const dup = join(work, 'dup')
    marker(dup, 'workspace = "acme"\n')
    repo(join(dup, 'a', 'app'))
    repo(join(dup, 'b', 'app'))
    check('two checkouts with the same basename yield one scope', JSON.stringify(keys(inbox.collectScopes(cfgFor(dup), {}).scopes)) === JSON.stringify(['acme/app']))
    check('deriveRepoScopes keeps both checkouts, shortest-then-alphabetical', pm.deriveRepoScopes(cfgFor(dup), []).map((r) => r.dir).join('|') === [join(dup, 'a', 'app'), join(dup, 'b', 'app')].join('|'))

    // Same pair, but the shortest checkout is server-routed: it must not hide the queryable one.
    const mixroute = join(work, 'mixroute')
    marker(join(mixroute, 'a'), 'workspace = "acme"\nserver = "prod"\n')
    repo(join(mixroute, 'a', 'app'))
    marker(join(mixroute, 'longer'), 'workspace = "acme"\n')
    repo(join(mixroute, 'longer', 'app'))
    const mixScopes = inbox.collectScopes(cfgFor(mixroute), {})
    check('a server-routed checkout does not hide a plugin-wide one of the same pair', mixScopes.scopes.length === 1 && mixScopes.scopes[0].workspace === 'acme' && mixScopes.scopes[0].project === 'app' && mixScopes.scopes[0].source === 'derivado' && mixScopes.skipped.length === 0, JSON.stringify(mixScopes))
    calls.length = 0
    await inbox.listInbox(spy, cfgFor(mixroute), {})
    check('the plugin-wide checkout of that pair is queried', calls.length > 0, JSON.stringify(calls))

    // Derived project missing on the server: empty box. Declared one: still an error.
    const missing = join(work, 'missing')
    marker(missing, 'workspace = "acme"\n')
    repo(join(missing, 'repo-one'))
    const declared = join(work, 'decl')
    marker(declared, 'workspace = "acme"\nproject = "declared-proj"\n')
    const throwing = async () => { throw new Error("project 'repo-one' not found in workspace 'acme'") }
    const result = await inbox.listInbox(throwing, cfgFor(missing, declared), {})
    check('both derived and declared scopes are collected', JSON.stringify(keys(result.scopes)) === JSON.stringify(['acme/declared-proj', 'acme/repo-one']), JSON.stringify(result.scopes))
    check('a missing derived project is an empty box, not an error', !result.errors.some((e) => e.project === 'repo-one') && result.messages.length === 0, JSON.stringify(result.errors))
    check('the same error for a declared scope still surfaces', result.errors.filter((e) => e.project === 'declared-proj').length === 2, JSON.stringify(result.errors))
    const wsMissing = async () => { throw new Error("workspace 'acme' not found") }
    const wsResult = await inbox.listInbox(wsMissing, cfgFor(missing), {})
    check('a missing workspace is also an empty box for derived scopes', wsResult.errors.length === 0, JSON.stringify(wsResult.errors))
    const otherErr = async () => { throw new Error('connection refused') }
    const otherResult = await inbox.listInbox(otherErr, cfgFor(missing), {})
    check('other errors on a derived scope still surface', otherResult.errors.length === 2, JSON.stringify(otherResult.errors))

    // A repo too deep for the bounded scan is still found from a cwd inside it
    // (nearest ancestor holding .git), under a marker at home.
    marker(home, 'workspace = "homews"\n')
    const deep = join(home, 'a', 'b', 'c', 'deep-repo')
    repo(deep)
    mkdirSync(join(deep, 'src'), { recursive: true })
    check('the bounded scan alone does not reach a deep repo', !pm.deriveRepoScopes(cfgFor(), [home]).some((r) => r.project === 'deep-repo'))
    const viaDeepCwd = pm.deriveRepoScopes(cfgFor(), [join(deep, 'src')])
    check('a cwd inside a deep repo yields it via the ancestor .git root', viaDeepCwd.some((r) => r.project === 'deep-repo' && r.workspace === 'homews' && r.dir === deep), JSON.stringify(viaDeepCwd))
  } finally {
    process.env.HOME = realHome
  }
}
