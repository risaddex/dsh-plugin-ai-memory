/**
 * Lifecycle bridge: turn DSH host events into the seven Claude-Code-shaped
 * events ai-memory's `hooks/dsh` bundle expects, and run that bundle.
 *
 * This is the piece that makes the ai-memory hooks *global* for the harness:
 * one plugin instance sees every session, every prompt, every tool call and
 * every turn stop, regardless of which workspace or profile app the session
 * belongs to. It mirrors the upstream `@deepseek-ai/dsh-hooks-claude-code`
 * bridge's delivery contract (Claude-Code payload on stdin, `{}` on stdout)
 * without requiring that package, so there is exactly one capture producer.
 *
 * Delivery is always fire-and-forget: a hook never delays or fails a turn.
 *
 * @module dsh-plugin-ai-memory/bridge
 */

import { appendFileSync, mkdirSync, statSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import { runHookScript, runNativeHook } from './aimemory.js'
import { logPath } from './paths.js'
import { UsageCollector, tapStreamUsage } from './usage.js'

/** Max bytes of tool text forwarded as `tool_response` (server caps at 2 KB). */
const TOOL_EXCERPT_BYTES = 2000
/** Rotation threshold for the event log. */
const LOG_MAX_BYTES = 512 * 1024

/** Flatten ContentBlocks to plain text for a tool response excerpt. */
function blocksToText(blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    if (typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'image') parts.push('[image]')
  }
  return parts.join('\n')
}

/** Truncate by UTF-16 units, keeping the head; the server caps again anyway. */
function excerpt(text) {
  const value = String(text ?? '')
  return value.length > TOOL_EXCERPT_BYTES ? `${value.slice(0, TOOL_EXCERPT_BYTES)}…[truncated]` : value
}

/** Extract the user prompt text from a claimed inbox message. */
export function promptText(message) {
  if (!message || typeof message !== 'object') return ''
  const content = message.content
  if (typeof content === 'string') return content
  const text = blocksToText(content)
  if (text) return text
  if (typeof message.text === 'string') return message.text
  return ''
}

/** Build the `tool_response` string from a normalized tool result. */
export function toolResponse(result) {
  if (!result || typeof result !== 'object') return ''
  if (result.isError) {
    const message = result.error?.message ?? result.error?.code ?? 'tool failed'
    const detail = blocksToText(result.content)
    return excerpt(detail || String(message))
  }
  const text = blocksToText(result.content)
  if (text) return excerpt(text)
  try {
    return excerpt(JSON.stringify(result.value ?? null))
  } catch {
    return ''
  }
}

export class AiMemoryBridge {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx host context
   * @param {object} deps { config(), hooks: {dir, scripts}, onEvent(info) }
   */
  constructor(ctx, deps) {
    this.ctx = ctx
    this.deps = deps
    this.disposers = []
    this.cwdCache = new Map()
    this.stopped = false
    /** Token usage observed on model streams, drained into hook deliveries. */
    this.usage = new UsageCollector()
  }

  /** Resolve a session's working directory through the host service. */
  cwdOf(agent) {
    const id = agent && agent.id ? String(agent.id) : ''
    if (!id) return Promise.resolve(process.cwd())
    const cached = this.cwdCache.get(id)
    if (cached) return Promise.resolve(cached)
    const service = this.ctx.get('workingDirectory')
    const resolve = async () => {
      try {
        // The synchronous read wins when the Agent exposes its Session; the
        // async `ensure` covers a freshly created agent whose directory has not
        // been materialized yet.
        if (service && agent && agent.session && typeof service.get === 'function') {
          const cwd = service.get(agent.session)
          if (cwd) {
            this.cwdCache.set(id, cwd)
            return cwd
          }
        }
        if (service && typeof service.ensure === 'function') {
          const cwd = await service.ensure(agent)
          if (cwd) {
            this.cwdCache.set(id, cwd)
            return cwd
          }
        }
      } catch {
        /* fall through to the process cwd */
      }
      return process.cwd()
    }
    return resolve()
  }

  /** Record one delivery attempt for the panel and the JSONL trail. */
  record(entry) {
    const info = { at: Date.now(), ...entry }
    try {
      const path = logPath()
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      try {
        if (statSync(path).size > LOG_MAX_BYTES) renameSync(path, `${path}.1`)
      } catch {
        /* no log yet */
      }
      appendFileSync(path, JSON.stringify(info) + '\n', { mode: 0o600 })
    } catch {
      /* logging must never break capture */
    }
    this.deps.onEvent?.(info)
  }

  /** Environment for the upstream scripts: server, token, data dir, strategy. */
  scriptEnv(config) {
    const env = { ...process.env }
    env.AI_MEMORY_HOOK_URL = config.serverUrl
    if (config.dataDir) env.AI_MEMORY_DATA_DIR = config.dataDir
    if (config.projectStrategy) env.AI_MEMORY_PROJECT_STRATEGY = config.projectStrategy
    if (config.token) env.AI_MEMORY_AUTH_TOKEN = config.token
    else delete env.AI_MEMORY_AUTH_TOKEN
    // We are the one capture producer; never let a second owner silently
    // suppress the scripts.
    delete env.AI_MEMORY_CAPTURE_OWNER
    return env
  }

  /**
   * Deliver one lifecycle event. Never throws and never rejects: callers are
   * synchronous event listeners on the hot path of a turn.
   */
  deliver(kind, payload) {
    if (this.stopped) return
    let config
    let hooks
    try {
      config = this.deps.config()
      hooks = this.deps.hooks()
    } catch (error) {
      this.record({ event: kind, ok: false, error: String(error?.message || error) })
      return
    }
    if (!config.enabled || !config.capture) return
    if (!hooks || !hooks.dir) return
    // Token usage rides on whatever event goes out next: ai-memory accepts
    // `_ai_memory_usage_calls` on any admitted hook, which is what makes a
    // session report usage *while it works* instead of only at session end.
    this.attachUsage(payload)
    const script = `${hooks.dir}/${kind}.sh`
    const run = config.captureMode === 'native'
      ? runNativeHook(config, kind, payload)
      : runHookScript(script, payload, this.scriptEnv(config))
    void run
      .then((result) => {
        this.record({ event: kind, ok: Boolean(result && result.ok), code: result?.code, error: result?.error })
      })
      .catch((error) => {
        this.record({ event: kind, ok: false, error: String(error?.message || error) })
      })
  }

  /**
   * Splice pending token usage for this payload's session as
   * `_ai_memory_usage_calls`. A payload with no `session_id` cannot be
   * attributed, so its usage stays queued for the next one.
   */
  attachUsage(payload) {
    try {
      const sessionId = payload && payload.session_id
      if (!sessionId) return
      const calls = this.usage.drain(sessionId)
      if (calls.length === 0) return
      payload._ai_memory_usage_calls = calls
    } catch {
      /* usage must never block a capture */
    }
  }

  /** Attach every listener; each registration is disposed by the caller. */
  start() {
    const ctx = this.ctx
    const on = (name, listener) => {
      const dispose = ctx.on(name, listener)
      if (typeof dispose === 'function') this.disposers.push(dispose)
    }

    // Token usage — tap every model stream. A waterfall listener must hand the
    // caller an AsyncIterable synchronously, so the generator is returned
    // without awaiting the first chunk.
    on('llm/stream', (options, next) => {
      const config = this.deps.config()
      if (!config.enabled || !config.reportUsage) return next()
      return tapStreamUsage(next(), options ?? {}, this.usage)
    })

    // SessionStart — a freshly entered agent.
    on('agent/created', ({ agent, source }) => {
      void this.cwdOf(agent).then((cwd) => {
        this.deliver('session-start', {
          session_id: String(agent?.id ?? ''),
          cwd,
          hook_event_name: 'SessionStart',
          source: source === 'resume' ? 'resume' : 'startup',
        })
      })
    })

    // UserPromptSubmit — one user message left the inbox inside a turn.
    on('agent/inbox/claimed', ({ agent, message }) => {
      const sessionId = String(agent?.id ?? '')
      void this.cwdOf(agent).then((cwd) => {
        this.deliver('user-prompt-submit', {
          session_id: sessionId,
          cwd,
          hook_event_name: 'UserPromptSubmit',
          prompt: excerpt(promptText(message)),
        })
      })
    })

    // PreToolUse — allow immediately; capture happens off the hot path.
    on('tools/pre-execute', (exec, next) => {
      try {
        const agent = exec?.agent
        const sessionId = String(agent?.id ?? '')
        void this.cwdOf(agent).then((cwd) => {
          this.deliver('pre-tool-use', {
            session_id: sessionId,
            cwd,
            hook_event_name: 'PreToolUse',
            tool_name: String(exec?.name ?? ''),
            tool_input: exec?.arguments ?? null,
          })
        })
      } catch {
        /* capture must never veto a call */
      }
      return next()
    })

    // PostToolUse — the frozen, lossless outcome of a dispatch.
    on('tools/result', (exec, result) => {
      const agent = exec?.agent
      const sessionId = String(agent?.id ?? '')
      void this.cwdOf(agent).then((cwd) => {
        this.deliver('post-tool-use', {
          session_id: sessionId,
          cwd,
          hook_event_name: 'PostToolUse',
          tool_name: String(exec?.name ?? ''),
          tool_input: exec?.arguments ?? null,
          tool_response: toolResponse(result),
          tool_is_error: Boolean(result?.isError),
        })
      })
    })

    // Stop — the turn is about to close. Upstream `stop.sh` drops the event if
    // the payload carries `last_assistant_message`, so we never send one.
    on('agent/turn-stopping', ({ agent }) => {
      const sessionId = String(agent?.id ?? '')
      void this.cwdOf(agent).then((cwd) => {
        this.deliver('stop', {
          session_id: sessionId,
          cwd,
          hook_event_name: 'Stop',
        })
      })
    })

    // SubagentStart / SubagentStop — child sessions, advertised by id.
    on('subagent/start', (info) => {
      this.deliver('subagent-start', {
        session_id: String(info?.id ?? ''),
        hook_event_name: 'SubagentStart',
        subagent_type: String(info?.provider ?? info?.label ?? 'subagent'),
        parent_session_id: info?.parentId ? String(info.parentId) : undefined,
      })
    })
    on('subagent/end', (info) => {
      this.deliver('subagent-stop', {
        session_id: String(info?.id ?? ''),
        hook_event_name: 'SubagentStop',
        subagent_type: String(info?.provider ?? info?.label ?? 'subagent'),
      })
    })
  }

  /** Detach every listener; in-flight deliveries finish on their own. */
  stop() {
    this.stopped = true
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose()
      } catch {
        /* already gone */
      }
    }
    this.cwdCache.clear()
    this.usage.clear()
  }
}
