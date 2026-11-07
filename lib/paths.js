/**
 * Path resolution for dsh-plugin-ai-memory.
 *
 * Everything the plugin writes lives under one state directory so uninstalling
 * the plugin is `rm -rf` on a single folder. Nothing outside it is touched
 * except the two files we deliberately manage:
 *   - `<profile>/cordis.patch.yml` (the managed MCP row block)
 *   - an optional per-repository `.ai-memory.toml` marker, only when the user
 *     asks for it from the panel.
 *
 * @module dsh-plugin-ai-memory/paths
 */

import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

/** Root of the DSH home directory (`$DSH_HOME`, default `~/.dsh`). */
export function dshHome(env = process.env) {
  return env.DSH_HOME && env.DSH_HOME.length > 0 ? env.DSH_HOME : join(homedir(), '.dsh')
}

/** Active profile name, when the host exported it. */
export function profileName(env = process.env) {
  return env.DSH_PROFILE && env.DSH_PROFILE.length > 0 ? env.DSH_PROFILE : ''
}

/** Active profile directory (`$DSH_PROFILE_DIR`, else `$DSH_HOME/profiles/<name>`). */
export function profileDir(env = process.env) {
  if (env.DSH_PROFILE_DIR && env.DSH_PROFILE_DIR.length > 0) return env.DSH_PROFILE_DIR
  const name = profileName(env)
  return name ? join(dshHome(env), 'profiles', name) : ''
}

/** The profile patch layer that carries user overrides (`cordis.patch.yml`). */
export function profilePatchPath(env = process.env) {
  const dir = profileDir(env)
  return dir ? join(dir, 'cordis.patch.yml') : ''
}

/**
 * Profile facts for the running host.
 *
 * Inside a profile the launcher provides the `profileContext` service with the
 * authoritative `dir`/`patchPath`/`home`; the environment fallback only exists
 * for tooling that runs without a profile (tests, a manual `node` smoke test).
 * Host code never sees `DSH_PROFILE_DIR` — that is a shell-tool convenience,
 * not a plugin contract.
 *
 * @param {object} [ctx] host context (`ctx.get('profileContext')`)
 */
export function resolveProfile(ctx, env = process.env) {
  try {
    const service = ctx && typeof ctx.get === 'function' ? ctx.get('profileContext') : undefined
    if (service && (service.patchPath || service.dir)) {
      return {
        name: service.name ?? profileName(env),
        dir: service.dir ?? profileDir(env),
        patchPath: service.patchPath ?? profilePatchPath(env),
        home: service.home ?? dshHome(env),
        source: 'profileContext',
      }
    }
  } catch {
    /* fall through to the environment */
  }
  return {
    name: profileName(env),
    dir: profileDir(env),
    patchPath: profilePatchPath(env),
    home: dshHome(env),
    source: 'env',
  }
}

/**
 * Plugin-owned state directory. Lives beside other DSH plugin data so it
 * survives profile reinstalls and is easy to inspect.
 */
export function stateDir(env = process.env) {
  return join(dshHome(env), 'plugins', 'dsh-plugin-ai-memory')
}

/** Persisted panel settings (the panel's own layer, above loader config). */
export function settingsPath(env = process.env) {
  return join(stateDir(env), 'settings.json')
}

/** Staged copy of the upstream ai-memory `hooks/dsh` bundle. */
export function hooksDir(env = process.env) {
  return join(stateDir(env), 'hooks', 'dsh')
}

/** Diagnostic log written by the bridge (one JSON line per delivered event). */
export function logPath(env = process.env) {
  return join(stateDir(env), 'events.jsonl')
}

/**
 * ai-memory's own data directory, by platform. Mirrors `ai_memory_state_dir`
 * in the upstream `hooks/_lib.sh` so a value the user leaves blank still points
 * the hook scripts at the same spool/state the ai-memory CLI uses.
 */
export function defaultDataDir(env = process.env) {
  if (env.AI_MEMORY_DATA_DIR) return env.AI_MEMORY_DATA_DIR
  if (env.XDG_DATA_HOME) return join(env.XDG_DATA_HOME, 'ai-memory')
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', 'ai-memory')
  return join(homedir(), '.local', 'share', 'ai-memory')
}

/**
 * ai-memory's staged hook bundle for DSH when the operator ran
 * `ai-memory install-hooks --agent dsh --apply`. We reuse it when it exists so
 * one install serves both the official bridge and this plugin.
 */
export function upstreamHooksDir(dataDir, env = process.env) {
  return join(dataDir || defaultDataDir(env), 'hooks', 'dsh')
}

/** Where the bundled hook assets ship inside this package. */
export function assetHooksDir(packageRoot) {
  return join(packageRoot, 'assets', 'hooks')
}

export { existsSync }
