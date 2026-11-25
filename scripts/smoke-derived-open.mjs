/**
 * `resolveProjectPath` falls back to derived scopes (`source: 'derivado'`) so a
 * message to a derived project opens the right checkout. Precedence: explicit
 * `projectPathMap`, markers declaring the full pair, then derived. Built under
 * a fake home (outside $HOME the marker walk stops at the nearest `.git`).
 * Called from smoke.mjs.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export async function runDerivedOpenChecks({ check, ROOT }) {
  const pm = await import('../lib/project-map.js')
  const inbox = await import('../lib/inbox.js')

  const realHome = process.env.HOME
  const home = join(ROOT, 'derived-open-home')
  const repo = (dir) => mkdirSync(join(dir, '.git'), { recursive: true })
  const marker = (dir, content) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '.ai-memory.toml'), content)
  }
  const cfgFor = (roots, projectPathMap = {}) => ({ projectPathMap, repoRoots: roots })

  rmSync(home, { recursive: true, force: true })
  process.env.HOME = home
  try {
    const acme = join(home, 'work', 'acme')
    marker(acme, 'workspace = "acme"\n')
    repo(join(acme, 'app'))
    pm.clearDeriveCache()

    const one = pm.resolveProjectPath(cfgFor([acme]), 'acme', 'app', [])
    check('a derived project resolves to its repo with source derivado', one.path === join(acme, 'app') && one.source === 'derivado' && one.matches.length === 1, JSON.stringify(one))

    const mappedDir = join(home, 'mapped')
    mkdirSync(mappedDir, { recursive: true })
    const viaMap = pm.resolveProjectPath(cfgFor([acme], { 'acme/app': mappedDir }), 'acme', 'app', [])
    check('an explicit projectPathMap entry still wins over derived', viaMap.path === mappedDir && viaMap.source === 'settings', JSON.stringify(viaMap))

    // A marker declaring the full pair for another checkout wins over the derived one.
    const beta = join(home, 'work', 'beta')
    marker(beta, 'workspace = "beta"\n')
    repo(join(beta, 'app'))
    repo(join(beta, 'own'))
    marker(join(beta, 'own'), 'workspace = "beta"\nproject = "app"\n')
    pm.clearDeriveCache()
    const viaMarker = pm.resolveProjectPath(cfgFor([beta]), 'beta', 'app', [])
    check('a marker declaring the full pair wins over the derived checkout', viaMarker.path === join(beta, 'own') && viaMarker.source === 'marker', JSON.stringify(viaMarker))

    // Two checkouts of the same derived project: shortest path, every match listed.
    const gamma = join(home, 'work', 'gamma')
    marker(gamma, 'workspace = "gamma"\n')
    repo(join(gamma, 'a', 'app'))
    repo(join(gamma, 'bb', 'app'))
    pm.clearDeriveCache()
    const several = pm.resolveProjectPath(cfgFor([gamma]), 'gamma', 'app', [])
    const dirs = (several.matches || []).map((m) => m.dir)
    check('several derived checkouts pick the shortest path', several.path === join(gamma, 'a', 'app') && several.source === 'derivado', JSON.stringify(several))
    check('several derived checkouts return every match', dirs.length === 2 && dirs.includes(join(gamma, 'a', 'app')) && dirs.includes(join(gamma, 'bb', 'app')) && several.matches.every((m) => m.workspace === 'gamma' && m.project === 'app' && m.path), JSON.stringify(several.matches))

    const none = pm.resolveProjectPath(cfgFor([acme, beta, gamma]), 'acme', 'nope', [])
    check('a project without a derived checkout stays unmapped', none.path === null && none.source === 'unmapped' && none.matches.length === 0, JSON.stringify(none))

    // A derived repo under a `server = ...` marker is never resolved.
    const delta = join(home, 'work', 'delta')
    marker(delta, 'workspace = "delta"\nserver = "prod"\n')
    repo(join(delta, 'svc'))
    pm.clearDeriveCache()
    const routed = pm.resolveProjectPath(cfgFor([delta]), 'delta', 'svc', [])
    check('a derived repo under a server marker is not resolved', routed.path === null && routed.source === 'unmapped', JSON.stringify(routed))

    // listInbox forwards the derived resolution as mappedPath / mapSource.
    const spy = async (name, args) => {
      if (args.box === 'inbox') {
        return { messages: [{ id: 'm1', subject: 's', state: 'pending', created_at: '2026-01-01T00:00:00Z', to_workspace: 'acme', to_project: 'app' }] }
      }
      return { messages: [] }
    }
    pm.clearDeriveCache()
    const listed = await inbox.listInbox(spy, cfgFor([acme]), {})
    const msg = listed.messages.find((m) => m.id === 'm1')
    check('listInbox maps a message to a derived project to its checkout', Boolean(msg) && msg.mappedPath === join(acme, 'app') && msg.mapSource === 'derivado', JSON.stringify(listed.messages))
  } finally {
    process.env.HOME = realHome
    pm.clearDeriveCache()
  }
}
