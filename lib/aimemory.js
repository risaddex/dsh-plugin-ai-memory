/**
 * Thin ai-memory client helpers: locate the CLI, read its version, health-check
 * a server, and post one probe event.
 *
 * The plugin never requires the `ai-memory` binary: capture through the
 * upstream `hooks/dsh` scripts only needs `sh` + `curl`, and the MCP row only
 * needs the server to be reachable. The binary is used when present for
 * `workstreams`/`finalize-session` style extras and for the `native` capture
 * mode, and every call degrades to "unavailable" without it.
 *
 * @module dsh-plugin-ai-memory/aimemory
 */

import { execFile, spawn } from 'node:child_process'
import { bearer, mcpUrl, resolveToken } from './settings.js'

/** Client marker header every first-party ai-memory client sends. */
export const CLIENT_HEADER = { 'x-ai-memory-client': 'dsh-plugin' }

/** Names that may satisfy the `ai-memory` lookup, in PATH order. */
const BINARY_NAMES = ['ai-memory']

/**
 * Resolve the ai-memory executable from `PATH` (or an explicit override).
 * @returns {Promise<{ found: boolean, path?: string, version?: string, error?: string }>}
 */
export async function locateBinary(override) {
  const candidate = typeof override === 'string' && override.trim() ? override.trim() : ''
  const names = candidate ? [candidate] : BINARY_NAMES
  for (const name of names) {
    try {
      const version = await new Promise((resolve, reject) => {
        execFile(name, ['--version'], { timeout: 5000, windowsHide: true }, (error, stdout) => {
          if (error) reject(error)
          else resolve(String(stdout || '').trim())
        })
      })
      return { found: true, path: name, version }
    } catch {
      // try the next candidate
    }
  }
  return { found: false }
}

/**
 * Run the ai-memory CLI and capture stdout. Resolves to `{ ok, stdout, stderr }`
 * and never throws, so callers can surface the failure in the panel.
 */
export function runCli(args, { timeout = 10000, env = process.env } = {}) {
  return new Promise((resolve) => {
    execFile(
      'ai-memory',
      args,
      { timeout, windowsHide: true, env, maxBuffer: 4 << 20 },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          error: error ? String(error.message || error) : '',
        })
      },
    )
  })
}

/**
 * `GET /healthz` on an ai-memory server. Unauthenticated by design, so this is
 * the one probe that works before a token is configured.
 * @returns {Promise<{ ok: boolean, status?: number, error?: string, url: string }>}
 */
export async function health(serverUrl, { timeout = 3000 } = {}) {
  const url = `${serverUrl.replace(/\/+$/, '')}/healthz`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetch(url, { signal: controller.signal, headers: CLIENT_HEADER })
    const text = await response.text().catch(() => '')
    return { ok: response.ok, status: response.status, body: text.slice(0, 200), url }
  } catch (error) {
    const message = error?.name === 'AbortError' ? 'timeout' : String(error?.message || error)
    return { ok: false, error: message, url }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Deliver one synthetic event straight to `POST /hook`, the same endpoint the
 * upstream scripts use, and report the wire result. Used by the panel's
 * "send test event" button: it proves auth, reachability and policy in one go.
 */
export async function postTestEvent(config, { event = 'user-prompt', cwd, prompt } = {}) {
  const base = config.serverUrl.replace(/\/+$/, '')
  const query = new URLSearchParams({ event, agent: 'dsh' })
  if (cwd) query.set('cwd', cwd)
  const url = `${base}/hook?${query.toString()}`
  const body = {
    session_id: `dsh-plugin-ai-memory-test-${Date.now()}`,
    hook_event_name: event === 'user-prompt' ? 'UserPromptSubmit' : event,
    ...(cwd ? { cwd } : {}),
    ...(prompt ? { prompt } : { prompt: 'dsh-plugin-ai-memory: connection test' }),
  }
  const headers = { 'content-type': 'application/json', ...CLIENT_HEADER }
  const auth = bearer(resolveToken(config).token)
  if (auth) headers.authorization = auth
  try {
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
    const text = await response.text().catch(() => '')
    return { ok: response.ok, status: response.status, body: text.slice(0, 300), url }
  } catch (error) {
    return { ok: false, error: String(error?.message || error), url }
  }
}

/**
 * Probe the MCP endpoint to learn whether a row would actually connect.
 *
 * `GET /mcp` is not a valid MCP request, so a reachable server answers 405 (or
 * 400/406). A 401 means the machine surface sits behind auth: a row written
 * without a bearer would connect-fail on every boot, which is worse than not
 * writing it. `/healthz` and `/mcp` answer different questions; both are cheap.
 *
 * @returns {Promise<{ reachable: boolean, needsAuth: boolean, status?: number, error?: string }>}
 */
export async function probeMcp(config, { timeout = 3000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  const headers = { ...CLIENT_HEADER }
  const auth = bearer(resolveToken(config).token)
  if (auth) headers.authorization = auth
  try {
    const response = await fetch(mcpUrl(config.serverUrl), { method: 'GET', headers, signal: controller.signal })
    return {
      reachable: response.status !== 401,
      needsAuth: response.status === 401,
      status: response.status,
    }
  } catch (error) {
    const message = error?.name === 'AbortError' ? 'timeout' : String(error?.message || error)
    return { reachable: false, needsAuth: false, error: message }
  } finally {
    clearTimeout(timer)
  }
}

/** The MCP endpoint for the configured server, for display and row writing. */
export function resolveMcpUrl(config) {
  return mcpUrl(config.serverUrl)
}

/**
 * Run one lifecycle hook script with a Claude-Code-shaped payload on stdin.
 *
 * Delivery is fire-and-forget on purpose: an agent turn must never wait on a
 * hook. The child is detached from our process group and killed after
 * `timeoutMs` so a wedged `curl` cannot accumulate processes.
 *
 * @param {string} script absolute path to the staged `*.sh`
 * @param {object} payload Claude-Code-shaped JSON
 * @param {NodeJS.ProcessEnv} env extra environment (server URL, token, data dir)
 */
export function runHookScript(script, payload, env, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('/bin/sh', [script], {
        env,
        stdio: ['pipe', 'ignore', 'ignore'],
        detached: true,
        windowsHide: true,
      })
    } catch (error) {
      resolve({ ok: false, error: String(error?.message || error) })
      return
    }
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      finish({ ok: false, error: 'timeout' })
    }, timeoutMs)
    child.on('error', (error) => finish({ ok: false, error: String(error?.message || error) }))
    child.on('close', (code) => finish({ ok: code === 0, code }))
    try {
      child.stdin.on('error', () => {})
      child.stdin.end(JSON.stringify(payload))
    } catch {
      /* stdin already closed */
    }
    try {
      child.unref()
    } catch {
      /* not fatal */
    }
  })
}

/**
 * Run `ai-memory hook --event … --agent dsh` with the same payload. This is the
 * native capture path: local spool plus OIDC token fallback, no `curl`.
 */
export function runNativeHook(config, event, payload, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    const args = [
      ...(config.dataDir ? ['--data-dir', config.dataDir] : []),
      'hook',
      '--event', event,
      '--agent', 'dsh',
      '--server-url', config.serverUrl,
    ]
    if (config.token) args.push('--auth-token', config.token)
    if (config.projectStrategy) args.push('--project-strategy', config.projectStrategy)
    let child
    try {
      child = spawn('ai-memory', args, {
        env: process.env,
        stdio: ['pipe', 'ignore', 'ignore'],
        detached: true,
        windowsHide: true,
      })
    } catch (error) {
      resolve({ ok: false, error: String(error?.message || error) })
      return
    }
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      finish({ ok: false, error: 'timeout' })
    }, timeoutMs)
    child.on('error', (error) => finish({ ok: false, error: String(error?.message || error) }))
    child.on('close', (code) => finish({ ok: code === 0, code }))
    try {
      child.stdin.on('error', () => {})
      child.stdin.end(JSON.stringify(payload))
    } catch {
      /* stdin already closed */
    }
    try {
      child.unref()
    } catch {
      /* not fatal */
    }
  })
}
