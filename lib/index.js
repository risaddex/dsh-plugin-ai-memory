/**
 * dsh-plugin-ai-memory — make ai-memory the harness's global memory layer.
 *
 * Installed into a profile, this plugin:
 *  1. stages the upstream ai-memory `hooks/dsh` lifecycle hooks and RUNS them
 *     for every session (start, prompts, tool calls, turn stops, subagents), so
 *     capture is global instead of a per-project setup step;
 *  2. keeps an `@deepseek-ai/dsh-mcp-client` Loader row in the active profile's
 *     patch layer in sync with the configured server — local, or a remote
 *     ai-memory/workstream server — so the model gets the `memory_*` tools;
 *  3. contributes a left-sidebar panel (`sidebar.panellist` + `main`) where all
 *     of that is configured, tested and inspected.
 *
 * Capture and MCP need no `ai-memory` binary: the vendored hook scripts run on
 * `sh` + `curl`, and MCP is a Loader entry the shipped client already provides.
 * When the binary is present the panel also shows its version and can list
 * workstreams.
 *
 * @module dsh-plugin-ai-memory
 */

import { existsSync, mkdirSync } from 'node:fs'
import { createApi, registerRpc } from './routes.js'
import { AiMemoryBridge } from './bridge.js'
import { health, probeMcp } from './aimemory.js'
import { inspectHooks, stageHooks } from './hooks.js'
import { applyMcp, inspectMcp, removeMcp } from './mcp.js'
import { registerMessagingGuidance } from './prompt.js'
import { resolveConfig, resolveToken, writeSettings, mcpUrl } from './settings.js'
import { logPath, resolveProfile, stateDir } from './paths.js'

/** Package identity; the bundle patch's entry id must match it. */
export const name = 'dsh-plugin-ai-memory'
export const version = '0.2.0'

/**
 * Install the plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx host context
 * @param {Record<string, unknown>} [config] loader-row config from the profile patch
 */
export function apply(ctx, config = {}) {
  let effective = resolveConfig(config)
  /** Profile facts come from `profileContext` when the host is inside a profile. */
  const profile = resolveProfile(ctx)
  const lastEvents = []

  try {
    mkdirSync(stateDir(), { recursive: true, mode: 0o700 })
  } catch {
    /* a read-only home still lets the panel configure a remote server */
  }

  const getConfig = () => effective

  /**
   * Reconcile every derived artifact with the current settings: stage the hook
   * bundle and write the MCP row. Idempotent — called on boot, after a settings
   * change, and from the panel's explicit install buttons.
   */
  /** Last MCP decision, surfaced to the panel so a skipped row is explainable. */
  let mcpGuard = { state: 'unknown', message: '' }

  const sync = () => {
    const report = { staged: null, mcp: null, skipped: null }
    if (!effective.enabled) {
      report.skipped = 'plugin disabled'
      return report
    }
    if (effective.capture) {
      try {
        report.staged = stageHooks(effective)
      } catch (error) {
        report.staged = { error: String(error?.message || error) }
      }
    } else {
      report.skipped = 'capture off'
    }
    // The MCP decision needs one HTTP probe, so it resolves off the boot path.
    void syncMcp()
    report.mcp = { deferred: true }
    return report
  }

  /**
   * Write, refresh or remove the managed MCP row.
   *
   * A reachable server that rejects us with 401 means "no bearer configured":
   * writing the row anyway would make every boot log a connect failure, so we
   * leave the patch untouched and say why. A server that is merely offline is
   * still written — the operator may start it later.
   */
  const syncMcp = async () => {
    if (!effective.enabled) return { ok: false, skipped: 'plugin disabled' }
    if (!effective.mcp) {
      const removed = removeMcp(profile)
      mcpGuard = { state: 'off', message: 'MCP row management is off' }
      return removed
    }
    let probe
    try {
      probe = await probeMcp(effective)
    } catch (error) {
      probe = { reachable: false, needsAuth: false, error: String(error?.message || error) }
    }
    if (probe.needsAuth && !resolveToken(effective).token) {
      mcpGuard = {
        state: 'blocked',
        message: 'server requires a bearer token — set one above to write the MCP row',
      }
      return { ok: false, blocked: 'needs-auth', probe }
    }
    const written = applyMcp(effective, profile)
    mcpGuard = written.ok
      ? { state: 'written', message: probe.reachable ? 'row written' : 'row written (server currently offline)' }
      : { state: 'error', message: written.error || 'could not write the profile patch' }
    return written
  }

  const bridge = new AiMemoryBridge(ctx, {
    config: getConfig,
    hooks: () => inspectHooks(effective),
    onEvent: (info) => {
      lastEvents.push(info)
      if (lastEvents.length > 80) lastEvents.splice(0, lastEvents.length - 80)
    },
  })

  const restartCapture = () => {
    bridge.stop()
    bridge.stopped = false
    if (effective.enabled && effective.capture) bridge.start()
  }

  // ── boot reconciliation ────────────────────────────────────────────────────
  let bootReport = null
  try {
    bootReport = sync()
  } catch (error) {
    bootReport = { error: String(error?.message || error) }
  }
  restartCapture()

  // ── panel backend (authenticated RPC channel) ─────────────────────────────
  const api = createApi({
    getConfig,
    version,
    saveSettings: (patch) => {
      writeSettings(patch)
      effective = resolveConfig(config)
      return effective
    },
    sync,
    syncMcp,
    restartCapture,
    recentEvents: () => lastEvents,
    profile,
    mcpGuard: () => mcpGuard,
  })

  if (typeof ctx.inject === 'function') {
    ctx.inject(['connection'], (rpcCtx) => {
      const connection = rpcCtx.get('connection')
      if (!connection || typeof connection.fetch?.register !== 'function') return
      rpcCtx.effect(() => registerRpc(connection, api), 'ai-memory: /api routes')
    })
  }

  // ── agent guidance: when to use the cross-project inbox ───────────────────
  const guidanceRegistered = registerMessagingGuidance(ctx, getConfig)

  // ── model-facing status tool ──────────────────────────────────────────────
  const tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
  if (tools && typeof tools.register === 'function') {
    try {
      const dispose = tools.register({
        name: 'ai_memory_status',
        description:
          'Report the dsh-plugin-ai-memory wiring: server reachability, staged ai-memory hooks, the MCP row in the profile patch, and recent hook deliveries.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        async execute() {
          const probe = await health(effective.serverUrl)
          // The tool contract requires lossless JSON: drop `undefined` members
          // (probe.status is absent on a connection error) and anything else
          // the JSON encoder would otherwise reject.
          const payload = {
            serverUrl: effective.serverUrl,
            mcpUrl: mcpUrl(effective.serverUrl),
            reachable: probe.ok,
            httpStatus: probe.status,
            capture: effective.capture,
            captureMode: effective.captureMode,
            messagingGuidance: guidanceRegistered,
            hooks: inspectHooks(effective),
            mcp: inspectMcp(profile),
            recentEvents: lastEvents.slice(-5),
            logPath: logPath(),
          }
          return JSON.parse(JSON.stringify(payload))
        },
      })
      if (typeof dispose === 'function') ctx.effect(() => dispose, 'ai-memory: status tool')
    } catch {
      /* the tool is a convenience, never a boot requirement */
    }
  }

  // Expose the async MCP reconciliation for the panel's explicit buttons.
  void syncMcp()

  // ── unload ────────────────────────────────────────────────────────────────
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => bridge.stop(), 'ai-memory: capture bridge')
  }

  // Debug handle: `ctx.aiMemoryPlugin.status()` in a host console.
  try {
    ctx.provide?.('aiMemoryPlugin', {
      version,
      bootReport,
      messagingGuidance: guidanceRegistered,
      status: () => ({
        version,
        serverUrl: effective.serverUrl,
        capture: effective.capture,
        captureMode: effective.captureMode,
        hooks: inspectHooks(effective),
        mcp: inspectMcp(profile),
        stateDir: stateDir(),
        logExists: existsSync(logPath()),
        bootReport,
      messagingGuidance: guidanceRegistered,
      }),
    })
  } catch {
    /* optional */
  }
}

export default { name, version, apply }
