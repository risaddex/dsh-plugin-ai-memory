/**
 * Server-routed markers and partial-scope guidance. Separate file to keep the
 * smoke scripts under the staged-file size gate. Called from smoke.mjs.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Run a check body that may hit a missing export on old code: report, don't crash.
const attempt = async (fn, fallback) => {
  try {
    return await fn()
  } catch (error) {
    return fallback === undefined ? { error: error.message } : fallback
  }
}

export async function runServerRoutedChecks({ api, check, ROOT }) {
  const projectMap = await import('../lib/project-map.js')
  const inbox = await import('../lib/inbox.js')
  const { guidanceText } = await import('../lib/prompt.js')

  const routed = join(ROOT, 'repo-routed')
  mkdirSync(join(routed, 'src'), { recursive: true })
  writeFileSync(join(routed, '.ai-memory.toml'), 'workspace = "acme"\nproject = "acme-routed"\nserver = "production"\n')
  const plain = join(ROOT, 'repo-plain-srv')
  mkdirSync(plain, { recursive: true })
  writeFileSync(join(plain, '.ai-memory.toml'), 'workspace = "acme"\nproject = "acme-plain"\nserver_url = "http://x"\n')
  const emptyCfg = { projectPathMap: {}, repoRoots: [] }

  // 22. Detection mirrors the hook: `server = ...`, not `server_url`, ancestors count.
  check('marker with server = is detected', projectMap.markerDeclaresServer?.(join(routed, '.ai-memory.toml')) === true)
  check('server_url is not a server selection', projectMap.markerDeclaresServer?.(join(plain, '.ai-memory.toml')) === false)
  check('ancestor server marker routes a subdirectory', projectMap.serverRoutedFor?.(join(routed, 'src')) === true)
  const routedMarker = projectMap.findMarker(routed)
  check('findMarker flags a routed checkout and keeps its names', routedMarker.serverRouted === true && routedMarker.workspace === 'acme')

  // 23. The panel does not query, or attribute mail to, a routed checkout.
  const calls = []
  const spy = async (name, args) => { calls.push(args); return { messages: [] } }
  const onlyRouted = await attempt(() => inbox.listInbox(spy, emptyCfg, { cwd: routed, extraDirs: [routed] }), { errors: [], current: {} })
  check('routed checkout is not queried', calls.length === 0, JSON.stringify(calls))
  const notes = (onlyRouted.errors || []).filter((e) => /named server/.test(e.error))
  check('routed checkout is reported once, not shown as empty', notes.length === 1, JSON.stringify(onlyRouted.errors))
  check('routed current scope is blank and flagged', onlyRouted.current && onlyRouted.current.workspace === '' && onlyRouted.current.serverRouted === true, JSON.stringify(onlyRouted.current))

  calls.length = 0
  await attempt(() => inbox.listInbox(spy, emptyCfg, { cwd: plain, extraDirs: [plain, routed] }), {})
  check('only the non-routed scope is queried', calls.length === 2 && calls.every((a) => a.project === 'acme-plain'), JSON.stringify(calls))

  // 24. Resolution and cancel respect routing.
  const viaRouted = projectMap.resolveProjectPath(emptyCfg, 'acme', 'acme-routed', [routed])
  const viaPlain = projectMap.resolveProjectPath(emptyCfg, 'acme', 'acme-plain', [plain])
  check('a routed checkout is not offered as the project path', viaRouted.path === null, JSON.stringify(viaRouted))
  check('a non-routed checkout still resolves', viaPlain.path === plain, JSON.stringify(viaPlain))
  const cancelled = await attempt(() => api.cancelMessage({ cwd: routed, message_id: 'm1', workspace: 'acme', project: 'acme-routed' }))
  check('cancel is refused for a server-routed checkout', /named server/.test((cancelled && cancelled.error) || ''), JSON.stringify(cancelled))

  // 25. Guidance prescribes exact names only when both are known.
  const full = guidanceText({ workspace: 'a', project: 'b' })
  const onlyWorkspace = guidanceText({ workspace: 'acme', project: '' })
  const onlyProject = guidanceText({ workspace: '', project: 'acme-app' })
  const viaServer = guidanceText({ workspace: 'acme', project: 'acme-routed', serverRouted: true })
  check('full marker still prescribes exact names', full.includes('Pass these exact names'))
  check('workspace-only marker names the missing project, no placeholder', onlyWorkspace.includes('declares only the workspace "acme"') && onlyWorkspace.includes('the project is not declared') && !onlyWorkspace.includes('"?"') && !onlyWorkspace.includes('Pass these exact names'))
  check('project-only marker names the missing workspace, no placeholder', onlyProject.includes('declares only the project "acme-app"') && onlyProject.includes('the workspace is not declared') && !onlyProject.includes('"?"') && !onlyProject.includes('Pass these exact names'))
  check('server-routed guidance does not prescribe the scope', viaServer.includes('named server') && !viaServer.includes('Pass these exact names'))
}
