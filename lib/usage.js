/**
 * Token-usage reporting.
 *
 * ai-memory records per-response token usage when a hook body carries
 * `_ai_memory_usage_calls` — an array of
 * `{call_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens}`
 * (`crates/ai-memory-hooks/src/router.rs`: `upsert_token_calls`). Any admitted
 * event may carry it, so the numbers can be reported *while the session works*
 * rather than only at its end. Without it a DSH session shows "no reported
 * usage": the upstream `hooks/dsh` scripts never capture model responses.
 *
 * DSH exposes the numbers on the model stream itself: the `llm/stream`
 * waterfall yields `{type:'usage', usage: TokenUsage}` chunks and its
 * `GenerateOptions` carries `sessionId`, `provider` and `model`. This module
 * collects them per session and drains them into the next hook delivery.
 *
 * @module dsh-plugin-ai-memory/usage
 */

/** Server-side ceiling for one report (`router.rs`: MAX_REPORTED_SESSION_TOKENS). */
const MAX_TOKENS = 1_000_000_000
/** Server-side cap on calls per event (`router.rs`: `.take(256)`). */
const MAX_CALLS_PER_EVENT = 256
/** Server-side cap on the model label. */
const MAX_MODEL_BYTES = 64

const COUNT = (value) => {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.min(Math.floor(n), MAX_TOKENS)
}

/**
 * `call_id` must be `[A-Za-z0-9_:.-]{1,128}` — the server drops anything else
 * (it doubles as a retry/dedupe key, so a stable shape matters more than the
 * exact value).
 */
function callId(sessionId, sequence) {
  const tail = String(sessionId ?? '').replace(/[^A-Za-z0-9_.:-]/g, '').slice(-24)
  return `dsh-${tail}-${sequence}`.slice(0, 128)
}

export class UsageCollector {
  constructor() {
    /** @type {Map<string, object[]>} sessionId → pending calls */
    this.pending = new Map()
    this.sequence = 0
  }

  /**
   * Record one model response's usage.
   *
   * @param {{sessionId?: string, provider?: string, model?: string, purpose?: string}} options
   * @param {{inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number}} usage
   * @returns {boolean} whether anything was stored
   */
  record(options, usage) {
    const sessionId = options && options.sessionId != null ? String(options.sessionId) : ''
    if (!sessionId || !usage) return false
    // `purpose` marks an internal call (compaction, session title). Those are
    // real spend but not the session's work; keep them out of the usage report
    // so the panel number matches what the operator did.
    if (options.purpose) return false
    const input = COUNT(usage.inputTokens)
    const output = COUNT(usage.outputTokens)
    const cacheRead = COUNT(usage.cacheReadTokens)
    const cacheWrite = COUNT(usage.cacheWriteTokens)
    if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return false
    this.sequence += 1
    const call = {
      call_id: callId(sessionId, this.sequence),
      input_tokens: input,
      output_tokens: output,
      cache_write_tokens: cacheWrite,
      cache_read_tokens: cacheRead,
    }
    const model = typeof options.model === 'string' ? options.model.trim() : ''
    if (model) call.model = model.slice(0, MAX_MODEL_BYTES)
    const list = this.pending.get(sessionId) ?? []
    list.push(call)
    // Bound memory: drop the oldest if a session somehow never drains.
    while (list.length > MAX_CALLS_PER_EVENT * 4) list.shift()
    this.pending.set(sessionId, list)
    return true
  }

  /**
   * Remove and return the pending calls for a session, ready to splice into a
   * hook body as `_ai_memory_usage_calls`.
   *
   * @param {string} sessionId
   * @returns {object[]}
   */
  drain(sessionId) {
    const id = sessionId != null ? String(sessionId) : ''
    if (!id) return []
    const list = this.pending.get(id)
    if (!list || list.length === 0) return []
    this.pending.delete(id)
    return list.slice(0, MAX_CALLS_PER_EVENT)
  }

  /** How many calls are queued for a session (panel/debug). */
  pendingCount(sessionId) {
    const list = this.pending.get(String(sessionId ?? ''))
    return list ? list.length : 0
  }

  /** Drop everything (session end, plugin unload). */
  clear() {
    this.pending.clear()
  }
}

/**
 * Wrap a model stream so usage chunks are observed without altering delivery.
 *
 * Returns an `AsyncIterable` synchronously: a waterfall listener must answer
 * with the stream, not with a promise, or the caller would await a value that
 * only resolves after the whole response. `next()` is defensive against both
 * shapes anyway.
 *
 * @param {AsyncIterable<any> | Promise<AsyncIterable<any>>} inner
 * @param {object} options the `llm/stream` GenerateOptions
 * @param {UsageCollector} collector
 * @param {(recorded: boolean) => void} [onUsage]
 */
export async function* tapStreamUsage(inner, options, collector, onUsage) {
  const stream = await inner
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
    yield* stream
    return
  }
  for await (const chunk of stream) {
    if (chunk && chunk.type === 'usage' && chunk.usage) {
      try {
        if (collector.record(options, chunk.usage)) onUsage?.(true)
      } catch {
        /* usage reporting must never break the model stream */
      }
    }
    yield chunk
  }
}
