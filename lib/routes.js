/**
 * The panel's backend: one API object plus the wire adapter that exposes it to
 * the browser half.
 *
 * Transport: the authenticated `connection` RPC channel, not a raw route. The
 * browser calls `connection.rpc.call('/api', 'ai-memory.<endpoint>', payload)`
 * and the host answers a `client-request`/`server-response` envelope on an
 * exact `/api` route that the connection service admits (Host/Origin fence +
 * authenticated peer). That keeps the ai-memory bearer token on the host — the
 * browser only ever sees a masked hint — and it keeps working when the GUI is
 * reached through remote access, where loopback-only prefix routes are not
 * admitted.
 *
 * @module dsh-plugin-ai-memory/routes
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import { health, locateBinary, postTestEvent, runCli } from './aimemory.js'
import { inspectHooks, stageHooks, removeStagedHooks } from './hooks.js'
import { inspectMcp, applyMcp, removeMcp } from './mcp.js'
import { stateDir, settingsPath, logPath } from './paths.js'
import { mcpUrl, resolveToken } from './settings.js'

/** Wire method prefix: `ai-memory.status`, `ai-memory.saveSettings`, … */
export const RPC_NAMESPACE = 'ai-memory'

/** Mask a token for display: `abcd…wxyz`, never the full value. */
export function maskToken(token) {
  const text = String(token ?? '')
  if (!text) return ''
  if (text.length <= 8) return '…'
  return `${text.slice(0, 4)}…${text.slice(-4)}`
}

/** Tail the JSONL delivery log, newest last, bounded. */
export function readLog(limit = 60) {
  try {
    const text = readFileSync(logPath(), 'utf8')
    const lines = text.trim().split('\n').filter(Boolean)
    return lines.slice(-limit).map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return { raw: line }
      }
    })
  } catch {
    return []
  }
}

/**
 * Build every endpoint. Handlers are plain functions returning JSON-able
 * values; the adapter below handles envelopes and error mapping.
 *
 * @param {object} deps
 * @param {() => object} deps.getConfig effective configuration
 * @param {(patch: object) => object} deps.saveSettings persist + reload config
 * @param {() => object} deps.sync reconcile staged hooks + MCP row
 * @param {() => void} deps.restartCapture re-attach lifecycle listeners
 * @param {() => object[]} deps.recentEvents in-memory recent deliveries
 * @param {string} deps.version plugin version
 */
export function createApi(deps) {
  const { getConfig, saveSettings, sync, restartCapture, recentEvents, version, profile, mcpGuard } = deps

  const status = async () => {
    const config = getConfig()
    const binary = await locateBinary()
    const probe = await health(config.serverUrl)
    const token = resolveToken(config)
    return {
      version,
      profile: { name: profile?.name ?? '', dir: profile?.dir ?? '', patchPath: profile?.patchPath ?? '', source: profile?.source ?? '' },
      state: { dir: stateDir(), settingsPath: settingsPath(), logPath: logPath() },
      config: {
        enabled: config.enabled,
        serverUrl: config.serverUrl,
        mcpUrl: mcpUrl(config.serverUrl),
        tokenMasked: maskToken(token.token),
        hasToken: Boolean(token.token),
        tokenSource: token.source,
        dataDir: config.dataDir,
        capture: config.capture,
        captureMode: config.captureMode,
        reuseUpstreamHooks: config.reuseUpstreamHooks,
        reportUsage: config.reportUsage,
        messagingGuidance: config.messagingGuidance,
        mcp: config.mcp,
        mcpServerName: config.mcpServerName,
        mcpToolCallTimeoutMs: config.mcpToolCallTimeoutMs,
        projectStrategy: config.projectStrategy,
        workspace: config.workspace,
        project: config.project,
      },
      health: probe,
      hooks: inspectHooks(config),
      mcp: { ...inspectMcp(profile), guard: (mcpGuard && mcpGuard()) || { state: 'unknown', message: '' } },
      aiMemory: binary,
      recentEvents: recentEvents().slice(-20),
    }
  }

  /**
   * Parse an MCP HTTP response. The server is stateless Streamable HTTP and
   * may answer either as plain JSON or as an SSE stream, so both shapes are
   * accepted; anything else is reported verbatim.
   */
  const parseMcpResponse = (text) => {
    const tryParse = (value) => {
      try {
        return JSON.parse(value)
      } catch {
        return null
      }
    }
    const direct = tryParse(text)
    if (direct) return direct
    for (const line of String(text).split(/\r?\n/)) {
      const trimmed = line.trimStart()
      if (!trimmed.startsWith('data:')) continue
      const parsed = tryParse(trimmed.slice(5).trim())
      if (parsed) return parsed
    }
    throw new Error(`unexpected MCP response: ${String(text).slice(0, 200)}`)
  }

  /**
   * Call one ai-memory MCP tool over HTTP.
   *
   * The panel cannot mint MCP calls itself (only the model's MCP client can),
   * so the host performs the JSON-RPC round trip with the same bearer the
   * hooks use. Errors keep the server's own wording: a missing LLM provider
   * says exactly that, which is far more useful than "request failed".
   */
  const callMcpTool = async (name, args) => {
    const config = getConfig()
    const token = resolveToken(config)
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-ai-memory-client': 'dsh-plugin',
    }
    if (token.token) headers.authorization = `Bearer ${token.token}`
    const response = await fetch(mcpUrl(config.serverUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `dsh-plugin-${Date.now()}`,
        method: 'tools/call',
        params: { name, arguments: args ?? {} },
      }),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${text.slice(0, 300)}`)
    const message = parseMcpResponse(text)
    if (message.error) throw new Error(message.error.message || String(message.error))
    const result = message.result ?? {}
    const content = Array.isArray(result.content) ? result.content : []
    const payload = content.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('\n')
    if (result.isError) throw new Error(payload || 'the MCP tool reported an error')
    const parsed = (() => {
      try {
        return JSON.parse(payload)
      } catch {
        return null
      }
    })()
    return parsed ?? { text: payload }
  }

  return {
    /** Full status document: everything the panel renders. */
    status,

    /** Persist panel settings, then reconcile every derived artifact. */
    async saveSettings(patch) {
      if (!patch || typeof patch !== 'object') throw new Error('expected a settings object')
      saveSettings(patch)
      restartCapture()
      const report = sync()
      await deps.syncMcp?.()
      return { report, status: await status() }
    },

    /** Health-check a candidate server (and optionally push one probe event). */
    async check(body) {
      const config = getConfig()
      const target = typeof body?.serverUrl === 'string' && body.serverUrl.trim()
        ? body.serverUrl.trim().replace(/\/+$/, '')
        : config.serverUrl
      const token = typeof body?.token === 'string' ? body.token : config.token
      const probe = await health(target)
      const testEvent = body?.sendTestEvent
        ? await postTestEvent({ ...config, serverUrl: target, token })
        : undefined
      return { health: probe, testEvent }
    },

    /** POST one synthetic `user-prompt` event through the real `/hook` path. */
    async testEvent(body) {
      const config = getConfig()
      return postTestEvent(config, {
        cwd: typeof body?.cwd === 'string' && body.cwd ? body.cwd : undefined,
        prompt: typeof body?.prompt === 'string' ? body.prompt : undefined,
      })
    },

    /** Re-stage the vendored ai-memory `hooks/dsh` bundle and its hooks.json. */
    installHooks() {
      const report = stageHooks(getConfig())
      restartCapture()
      return report
    },

    /** Delete only the plugin's own staged bundle. */
    removeHooks() {
      return removeStagedHooks()
    },

    /** Write or refresh the managed MCP row in the profile patch. */
    async applyMcp() {
      const report = deps.syncMcp ? await deps.syncMcp() : applyMcp(getConfig(), profile)
      return { report, guard: (mcpGuard && mcpGuard()) || null }
    },

    /** Remove the managed MCP row, leaving the rest of the patch untouched. */
    removeMcp() {
      return removeMcp(profile)
    },

    /**
     * Write (or remove) a per-repository `.ai-memory.toml` marker. This is the
     * only place the plugin touches a user directory, and only on request.
     */
    writeMarker(body) {
      const dir = typeof body?.dir === 'string' ? resolvePath(body.dir) : ''
      if (!dir || !existsSync(dir)) throw new Error('directory does not exist')
      const target = join(dir, '.ai-memory.toml')
      if (body?.remove) {
        rmSync(target, { force: true })
        return { removed: true, path: target }
      }
      if (existsSync(target) && !body?.overwrite) {
        return { written: false, path: target, error: '.ai-memory.toml already exists (pass overwrite to replace it)' }
      }
      const lines = ['# ai-memory project marker — written by dsh-plugin-ai-memory']
      if (body.workspace) lines.push(`workspace = ${JSON.stringify(String(body.workspace))}`)
      if (body.project) lines.push(`project = ${JSON.stringify(String(body.project))}`)
      if (body.projectStrategy === 'basename' || body.projectStrategy === 'repo-root') {
        lines.push(`project_strategy = ${JSON.stringify(body.projectStrategy)}`)
      }
      mkdirSync(dir, { recursive: true })
      writeFileSync(target, lines.join('\n') + '\n', 'utf8')
      return { written: true, path: target, content: lines.join('\n') }
    },

    /** List the server's workstreams through the ai-memory CLI, best effort. */
    async listWorkstreams(body) {
      const args = ['workstreams', '--json', '--limit', '25']
      if (typeof body?.cwd === 'string' && body.cwd) args.push('--workspace', body.cwd)
      const result = await runCli(args, { timeout: 8000 })
      if (!result.ok) throw new Error(result.stderr || result.error || 'ai-memory workstreams failed')
      try {
        return JSON.parse(result.stdout)
      } catch {
        return { raw: result.stdout }
      }
    },

    /**
     * Consolidate a session into wiki pages through the server's MCP tool.
     * `dryRun` only runs the admission preflight (no LLM call), which is the
     * cheap way to prove the server has a provider without spending tokens.
     */
    async consolidate(body) {
      const args = {}
      if (body?.dryRun) args.dry_run = true
      if (typeof body?.sessionId === 'string' && body.sessionId.trim()) args.session_id = body.sessionId.trim()
      if (typeof body?.instructions === 'string' && body.instructions.trim()) args.instructions = body.instructions.trim()
      return callMcpTool('memory_consolidate', args)
    },

    /** Read one MCP tool directly (panel diagnostics). */
    async mcpTool(body) {
      const name = typeof body?.name === 'string' ? body.name.trim() : ''
      if (!name) throw new Error('missing tool name')
      const allowed = new Set(['memory_status', 'memory_briefing', 'memory_recent'])
      if (!allowed.has(name)) throw new Error(`tool ${name} is not exposed to the panel`)
      return callMcpTool(name, body?.arguments && typeof body.arguments === 'object' ? body.arguments : {})
    },

    /** The recent delivery trail (panel "Activity" list). */
    log() {
      return readLog(80)
    },

    /** Support paste-in: effective config with the token redacted. */
    rawConfig() {
      const config = getConfig()
      return {
        config: { ...config, token: config.token ? '<set>' : '' },
        env: {
          DSH_HOME: process.env.DSH_HOME ?? '',
          DSH_PROFILE: process.env.DSH_PROFILE ?? '',
          DSH_PROFILE_DIR: process.env.DSH_PROFILE_DIR ?? '',
        },
      }
    },
  }
}

/**
 * Expose `api` on the authenticated connection RPC channel.
 *
 * The envelope is the shared gateway's: the browser posts a
 * `{type:'client-request', rpcId, method, payload}` message to an exact
 * `/api/<method>` route, and the host answers
 * `{type:'server-response', rpcId, result}` where `result` is
 * `{ok:true, value}` or `{ok:false, error}`.
 *
 * @returns {() => void} disposer for every registration
 */
export function registerRpc(connection, api, effect) {
  const disposers = []
  for (const [endpoint, handler] of Object.entries(api)) {
    const method = `${RPC_NAMESPACE}.${endpoint}`
    const dispose = connection.fetch.register({
      path: `/api/${method}`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body
        try {
          body = await request.json()
        } catch {
          return new Response('body is not JSON', { status: 400 })
        }
        const rpcId = typeof body?.rpcId === 'string' ? body.rpcId : 'invalid-request'
        if (body?.type !== 'client-request' || body.method !== method) {
          return Response.json({
            type: 'server-response',
            rpcId,
            result: {
              ok: false,
              error: { code: 'gateway/bad-request', message: 'invalid client-request message', details: { issues: [] } },
            },
          })
        }
        let result
        try {
          result = { ok: true, value: (await handler(body.payload ?? {})) ?? null }
        } catch (error) {
          result = {
            ok: false,
            error: { code: 'internal', message: String(error?.message ?? error), details: {} },
          }
        }
        return Response.json({ type: 'server-response', rpcId, result })
      },
    })
    if (typeof dispose === 'function') disposers.push(dispose)
    effect?.(dispose, `ai-memory: /api/${method}`)
  }
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* already gone */
      }
    }
  }
}
