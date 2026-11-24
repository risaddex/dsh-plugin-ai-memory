/**
 * Inbox and project-map checks for the panel backend. Split out of smoke.mjs
 * to keep both files under the staged-file size gate. Called from smoke.mjs
 * with the same `api`, `check` and `ROOT`.
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export async function runInboxChecks({ api, check, ROOT }) {
  const projectMap = await import('../lib/project-map.js')

// 14. writeMarker is exposed on the API (Config tab "Write marker" button).
  check('api.writeMarker is exposed', typeof api.writeMarker === 'function')

  // 15. resolve from a subdirectory cwd through the ancestor marker.
  const repoB = join(ROOT, 'repo-b')
  mkdirSync(join(repoB, 'src'), { recursive: true })
  writeFileSync(join(repoB, '.ai-memory.toml'), 'workspace = "acme"\nproject = "acme-app"\n')
  const fromSub = projectMap.resolveProjectPath({ projectPathMap: {}, repoRoots: [] }, 'acme', 'acme-app', [join(repoB, 'src')])
  check('resolveProjectPath finds ancestor marker from a subdirectory cwd', fromSub.path === repoB && fromSub.source === 'marker', JSON.stringify({ path: fromSub.path, source: fromSub.source }))

  // 16. composer: recipient reset on workspace change, send requires a listed recipient.
  const pageSource = readFileSync(new URL('../client/client.page.js', import.meta.url), 'utf8')
  check('to_workspace change clears to_project', /to_workspace: event\.target\.value, to_project: ""/.test(pageSource))
  check('send requires a listed recipient', /!projects\.includes\(composer\.to_project\)/.test(pageSource))

  // 17. Workspace-to-cwd matching keeps case (App and app are distinct checkouts).
  const clientSource = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  const resolverBody = clientSource.slice(clientSource.indexOf('async function resolveWorkspaceId'), clientSource.indexOf('async function createAndPrefill'))
  check('resolveWorkspaceId does not lowercase paths', resolverBody.length > 0 && !/toLowerCase/.test(resolverBody))

  // 18. A capture-only nested marker is transparent for scope resolution.
  const capRepo = join(ROOT, 'repo-cap')
  mkdirSync(join(capRepo, 'pkg'), { recursive: true })
  writeFileSync(join(capRepo, '.ai-memory.toml'), 'workspace = "acme"\nproject = "acme-core"\n')
  writeFileSync(join(capRepo, 'pkg', '.ai-memory.toml'), '[capture]\ndrop_subagent_captures = true\n')
  const capScope = projectMap.findMarker(join(capRepo, 'pkg'))
  check('capture-only nested marker keeps the ancestor scope', capScope.workspace === 'acme' && capScope.project === 'acme-core', JSON.stringify(capScope))

  // 19. Inbox failures and truncation are rendered, not shown as an empty inbox.
  const pageForErrors = readFileSync(new URL('../client/client.page.js', import.meta.url), 'utf8')
  check('inbox renders listInbox errors', /inboxProblems/.test(pageForErrors) && /errors\.map/.test(pageForErrors))
  check('inbox distinguishes unavailable from empty', /inbox\.unavailable/.test(pageForErrors) && /inbox\.empty/.test(pageForErrors))
  check('RPC failure does not keep the previous list', /failed: message, messages: \[\]/.test(pageForErrors))

  // 20. Mapping an existing checkout merges scope and keeps other settings.
  const keepRepo = join(ROOT, 'repo-keep')
  mkdirSync(keepRepo, { recursive: true })
  writeFileSync(join(keepRepo, '.ai-memory.toml'), '# mine\nworkspace = "old"\nproject = "old-app"\n\n[capture]\ndrop_subagent_captures = true\n\n[profile]\nname = "keep"\n')
  const keepOut = await api.mapProject({ workspace: 'acme', project: 'acme-keep', dir: keepRepo, writeMarker: true, overwrite: true })
  const keptText = readFileSync(join(keepRepo, '.ai-memory.toml'), 'utf8')
  check('mapProject merges scope into existing marker', keepOut.marker && keepOut.marker.merged === true && keptText.includes('workspace = "acme"') && keptText.includes('project = "acme-keep"') && !keptText.includes('"old"'))
  check('mapProject keeps [capture], [profile] and comments', keptText.includes('drop_subagent_captures = true') && keptText.includes('name = "keep"') && keptText.includes('# mine'))
  check('panel no longer forces overwrite on map', !/writeMarker: true,\s*overwrite: true/.test(pageSource))

  // 21. Inbox routes resolve every helper they use, and panel cwd comes from deps.
  const { createApi: createApiFresh } = await import('../lib/routes.js')
  const panelCwd = join(capRepo, 'pkg')
  const freshApi = createApiFresh({
    getConfig: () => ({ projectPathMap: {}, repoRoots: [], serverUrl: 'http://127.0.0.1:1', token: '' }),
    saveSettings: () => ({}), sync: () => {}, restartCapture: () => {}, recentEvents: () => [], version: 'test',
    getWorkingDirectory: () => panelCwd, listSessionCwds: () => [],
  })
  const undefinedErrors = []
  for (const [name, args] of [['listInbox', {}], ['resolveProjectPath', { workspace: 'a', project: 'b' }], ['listProjectMap', {}], ['cancelMessage', { message_id: 'x' }], ['sendMessage', {}]]) {
    try { await freshApi[name](args) } catch (error) { if (/is not defined/.test(error.message)) undefinedErrors.push(`${name}: ${error.message}`) }
  }
  check('inbox API routes resolve their helpers', undefinedErrors.length === 0, undefinedErrors.join('; '))
  let seenMap = { current: {} }
  try { seenMap = freshApi.listProjectMap({}) } catch { /* reported by the check below */ }
  check('panel cwd comes from getWorkingDirectory', seenMap.current.cwd === panelCwd && seenMap.current.workspace === 'acme', JSON.stringify(seenMap.current))
}
