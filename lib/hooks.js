/**
 * Hook staging: materialize the upstream ai-memory `hooks/dsh` bundle plus a
 * generated Claude-Code-shaped `hooks.json` under the plugin state directory.
 *
 * The scripts are vendored verbatim from akitaonrails/ai-memory (`hooks/dsh/*.sh`
 * and `hooks/_lib.sh`, MIT). Keeping our own copy means capture works without
 * the `ai-memory` binary and without a previous `install-hooks --agent dsh`
 * run; the operator can still point us at ai-memory's staged bundle with
 * `reuseUpstreamHooks`.
 *
 * `hooks.json` is written for parity with `ai-memory install-hooks --apply`:
 * if the official `@deepseek-ai/dsh-hooks-claude-code` bridge is ever installed
 * it can be pointed at this file, and it documents what the bridge runs.
 *
 * @module dsh-plugin-ai-memory/hooks
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, chmodSync, existsSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assetHooksDir, hooksDir as stagedHooksDir, upstreamHooksDir } from './paths.js'

/**
 * The seven lifecycle events ai-memory proposes for DSH, in the order upstream
 * declares them: `hooks.json` event name → POSIX script file. `PreCompact` and
 * `SessionEnd` are deliberately absent — DSH's bridge never delivers them.
 * @see https://github.com/akitaonrails/ai-memory/blob/main/hooks/dsh
 */
export const DSH_EVENTS = [
  ['SessionStart', 'session-start.sh'],
  ['UserPromptSubmit', 'user-prompt-submit.sh'],
  ['PreToolUse', 'pre-tool-use.sh'],
  ['PostToolUse', 'post-tool-use.sh'],
  ['Stop', 'stop.sh'],
  ['SubagentStart', 'subagent-start.sh'],
  ['SubagentStop', 'subagent-stop.sh'],
]

/** Script file → `POST /hook?event=` token. */
export const EVENT_TOKEN = {
  'session-start.sh': 'session-start',
  'user-prompt-submit.sh': 'user-prompt',
  'pre-tool-use.sh': 'pre-tool-use',
  'post-tool-use.sh': 'post-tool-use',
  'stop.sh': 'stop',
  'subagent-start.sh': 'subagent-start',
  'subagent-stop.sh': 'subagent-stop',
}

/** Package root, resolved from this module's own URL (works under link: installs). */
export function packageRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)))
}

/** Single-quote a shell word for the generated command line. */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/** Environment prefix baked into each generated `hooks.json` command. */
export function hookEnvPrefix(config) {
  const parts = [`AI_MEMORY_HOOK_URL=${shellQuote(config.serverUrl)}`]
  if (config.dataDir) parts.push(`AI_MEMORY_DATA_DIR=${shellQuote(config.dataDir)}`)
  if (config.projectStrategy) parts.push(`AI_MEMORY_PROJECT_STRATEGY=${shellQuote(config.projectStrategy)}`)
  if (config.token) parts.push(`AI_MEMORY_AUTH_TOKEN=${shellQuote(config.token)}`)
  return parts.join(' ')
}

/**
 * Build the Claude-Code-shaped hooks document for a set of staged scripts.
 * Shape and command form mirror `ai-memory install-hooks --agent dsh` with
 * `AI_MEMORY_HOOK_PLATFORM=posix` (the script form).
 */
export function buildHooksJson(config, dir) {
  const prefix = hookEnvPrefix(config)
  const hooks = {}
  for (const [event, script] of DSH_EVENTS) {
    hooks[event] = [
      {
        matcher: '',
        hooks: [{ type: 'command', command: `${prefix} ${shellQuote(join(dir, script))}` }],
      },
    ]
  }
  return { hooks }
}

/**
 * Resolve where the scripts should live. `reuseUpstreamHooks` prefers an
 * ai-memory-managed bundle when one exists; otherwise the plugin's own copy.
 */
export function resolveScriptDir(config, env = process.env) {
  if (config.reuseUpstreamHooks) {
    const upstream = upstreamHooksDir(config.dataDir, env)
    if (existsSync(join(upstream, 'session-start.sh'))) return { dir: upstream, source: 'ai-memory' }
  }
  return { dir: stagedHooksDir(env), source: 'plugin' }
}

/**
 * Copy the vendored bundle into `dir` (idempotent), write `hooks.json`, and
 * report what landed. Leaves permissions as upstream does: scripts 0755, the
 * config 0600 because the command lines may carry a bearer.
 */
export function stageHooks(config, env = process.env) {
  const root = packageRoot()
  const assets = assetHooksDir(root)
  const { dir, source } = resolveScriptDir(config, env)
  if (source === 'plugin') {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const libSource = join(assets, '_lib.sh')
    if (existsSync(libSource)) writeFileSync(join(dir, '_lib.sh'), readFileSync(libSource))
    const scripts = join(assets, 'dsh')
    for (const name of readdirSync(scripts)) {
      if (!name.endsWith('.sh')) continue
      const target = join(dir, name)
      copyFileSync(join(scripts, name), target)
      chmodSync(target, 0o755)
    }
  }
  const hooksJsonPath = join(dir, 'hooks.json')
  const document = buildHooksJson(config, dir)
  writeFileSync(hooksJsonPath, JSON.stringify(document, null, 2) + '\n', { mode: 0o600 })
  chmodSync(hooksJsonPath, 0o600)
  return { dir, source, hooksJsonPath, scripts: DSH_EVENTS.map(([, script]) => join(dir, script)) }
}

/** Read back what a previous stage produced, for the panel's status view. */
export function inspectHooks(config, env = process.env) {
  const { dir, source } = resolveScriptDir(config, env)
  const scripts = DSH_EVENTS.map(([, script]) => {
    const path = join(dir, script)
    let present = false
    let size = 0
    try {
      present = statSync(path).isFile()
      size = statSync(path).size
    } catch {
      present = false
    }
    return { event: DSH_EVENTS.find(([, name]) => name === script)?.[0], script, path, present, size }
  })
  const hooksJsonPath = join(dir, 'hooks.json')
  return {
    dir,
    source,
    hooksJsonPath,
    hooksJsonPresent: existsSync(hooksJsonPath),
    installed: scripts.every((entry) => entry.present),
    scripts,
  }
}

/** Remove only the plugin's own staged bundle; never an ai-memory-managed one. */
export function removeStagedHooks(env = process.env) {
  const dir = stagedHooksDir(env)
  if (!existsSync(dir)) return { removed: false, dir }
  rmSync(dir, { recursive: true, force: true })
  return { removed: true, dir }
}
