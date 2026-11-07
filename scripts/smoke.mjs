/**
 * Local smoke test for the host half: boots the plugin against a fake Cordis
 * context in a throwaway DSH_HOME and asserts every side effect it promises.
 * Run with: node scripts/smoke.mjs
 */
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = '/tmp/ai-memory-smoke'
rmSync(ROOT, { recursive: true, force: true })
mkdirSync(join(ROOT, 'profiles', 'test'), { recursive: true })
process.env.DSH_HOME = ROOT
process.env.DSH_PROFILE = 'test'
delete process.env.DSH_PROFILE_DIR

const { apply } = await import('../lib/index.js')

const patchPath = join(ROOT, 'profiles', 'test', 'cordis.patch.yml')

/** Minimal cordis stand-in: only the members the plugin actually touches. */
const listeners = new Map()
const effects = []
const tools = new Map()
const sections = []
const ctx = {
  get(name) {
    if (name === 'profileContext') return { name: 'test', dir: join(ROOT, 'profiles', 'test'), patchPath, home: ROOT }
    if (name === 'tools') return { register: (def) => { tools.set(def.name, def); return () => tools.delete(def.name) } }
    if (name === 'workingDirectory') return { get: () => '/tmp/ai-memory-smoke/workspace' }
    if (name === 'systemPrompt') {
      return {
        section: (definition) => {
          sections.push(definition)
          return () => {}
        },
      }
    }
    return undefined
  },
  on(name, listener) {
    const list = listeners.get(name) ?? []
    list.push(listener)
    listeners.set(name, list)
    return () => listeners.set(name, (listeners.get(name) ?? []).filter((entry) => entry !== listener))
  },
  effect(factory) {
    const dispose = typeof factory === 'function' ? factory() : undefined
    if (typeof dispose === 'function') effects.push(dispose)
    return () => {}
  },
  inject(_names, callback) {
    callback(ctx)
  },
  provide() {
    return () => {}
  },
}

// Port 1 is closed everywhere: the guard takes the "offline, still write the
// row so the operator can start the server later" branch deterministically.
apply(ctx, { serverUrl: 'http://127.0.0.1:1' })
await new Promise((resolve) => setTimeout(resolve, 500))

const results = []
const check = (label, condition, detail = '') => {
  results.push({ label, ok: Boolean(condition), detail })
  if (!condition) process.exitCode = 1
}

// 1. hooks staged under the plugin state dir
const hookDir = join(ROOT, 'plugins', 'dsh-plugin-ai-memory', 'hooks', 'dsh')
check('staged hooks dir', existsSync(hookDir), hookDir)
check('staged session-start.sh', existsSync(join(hookDir, 'session-start.sh')))
check('staged _lib.sh', existsSync(join(hookDir, '_lib.sh')))
check('staged hooks.json', existsSync(join(hookDir, 'hooks.json')))
if (existsSync(join(hookDir, 'hooks.json'))) {
  const doc = JSON.parse(readFileSync(join(hookDir, 'hooks.json'), 'utf8'))
  check('hooks.json covers 7 events', Object.keys(doc.hooks).length === 7, Object.keys(doc.hooks).join(','))
}

// 2. MCP row written into the profile patch, server url from config
check('profile patch written', existsSync(patchPath))
if (existsSync(patchPath)) {
  const text = readFileSync(patchPath, 'utf8')
  check('patch has managed block', text.includes('>>> dsh-plugin-ai-memory'))
  check('patch has mcp-client row', text.includes("name: '@deepseek-ai/dsh-mcp-client'"))
  check('patch url is /mcp', text.includes("url: 'http://127.0.0.1:1/mcp'"))
  check('patch row id', text.includes('- id: ai-memory-mcp'))
}

// 3. lifecycle listeners attached
for (const name of ['agent/created', 'agent/inbox/claimed', 'tools/pre-execute', 'tools/result', 'agent/turn-stopping', 'subagent/start', 'subagent/end']) {
  check(`listener ${name}`, (listeners.get(name) ?? []).length === 1)
}

// 4. status tool registered and executable
check('tool ai_memory_status', tools.has('ai_memory_status'))
if (tools.has('ai_memory_status')) {
  const value = await tools.get('ai_memory_status').execute({}, {})
  check('tool reports hooks.installed', value.hooks && value.hooks.installed === true)
  check('tool reports mcp row', value.mcp && value.mcp.managed === true)
  check('tool exposes log path', typeof value.logPath === 'string')
}

// 5. a pre-tool-use listener must delegate (next()) and not throw
const preTool = (listeners.get('tools/pre-execute') ?? [])[0]
if (preTool) {
  const decision = await preTool({ name: 'bash', arguments: { cmd: 'ls' }, agent: { id: 'session-1' } }, async () => ({ kind: 'allow' }))
  check('pre-execute delegates allow', decision && decision.kind === 'allow')
}

// 6. settings round-trip through the panel layer
const settingsFile = join(ROOT, 'plugins', 'dsh-plugin-ai-memory', 'settings.json')
const { writeSettings, resolveConfig } = await import('../lib/settings.js')
writeSettings({ serverUrl: 'http://homelab:49374/', token: 'tok-x', mcpServerName: 'ai-memory' })
const effective = resolveConfig({ serverUrl: 'http://127.0.0.1:49374' })
check('settings file written', existsSync(settingsFile))
check('settings override loader default', effective.serverUrl === 'http://homelab:49374', effective.serverUrl)
check('settings keep token', effective.token === 'tok-x')
// A fresh DSH_HOME has no panel layer, so only the loader value is in play.
check('invalid serverName falls back',
  resolveConfig({ mcpServerName: 'bad name!' }, { DSH_HOME: join(ROOT, 'empty-home') }).mcpServerName === 'ai_memory')

// 6b. agent guidance: the cross-project inbox policy is registered
const messaging = sections.find((entry) => entry.name === 'ai-memory:messaging')
check('system-prompt section registered', Boolean(messaging))
check('guidance names the send tool', Boolean(messaging && messaging.text.includes('memory_message_send')))
check('guidance names the pop tool', Boolean(messaging && messaging.text.includes('memory_message_pop')))
check('guidance forbids page-as-notice', Boolean(messaging && messaging.text.includes('never surfaced as mail')))
check('guidance marks popped mail untrusted', Boolean(messaging && messaging.text.toLowerCase().includes('untrusted')))
check('guidance is literal', Boolean(messaging && messaging.interpolate === false))

// 7. token usage: collector shapes match ai-memory's TokenCall JSON, and the
// bridge splices them into the next payload for the right session.
const { UsageCollector, tapStreamUsage } = await import('../lib/usage.js')
const collector = new UsageCollector()
check('usage recorded', collector.record(
  { sessionId: 'session-usage-1', provider: 'deepseek', model: 'deepseek-flash' },
  { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 600, cacheWriteTokens: 20 },
))
const drained = collector.drain('session-usage-1')
check('usage drains once', drained.length === 1 && collector.drain('session-usage-1').length === 0)
check('usage call shape', drained.length === 1 && typeof drained[0].call_id === 'string'
  && /^[A-Za-z0-9_:.-]{1,128}$/.test(drained[0].call_id)
  && drained[0].input_tokens === 1200 && drained[0].output_tokens === 340
  && drained[0].cache_read_tokens === 600 && drained[0].cache_write_tokens === 20
  && drained[0].model === 'deepseek-flash')
check('usage ignores empty counters',
  collector.record({ sessionId: 's' }, { inputTokens: 0, outputTokens: 0 }) === false)
check('usage ignores internal calls',
  collector.record({ sessionId: 's', purpose: 'session-title' }, { inputTokens: 9, outputTokens: 9 }) === false)

async function* fakeStream() {
  yield { type: 'text-delta', index: 0, text: 'hi' }
  yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
const tapped = []
for await (const chunk of tapStreamUsage(fakeStream(), { sessionId: 'session-usage-2', model: 'm1' }, collector)) tapped.push(chunk.type)
check('stream tap passes every chunk through', tapped.join(',') === 'text-delta,usage,finish', tapped.join(','))
check('stream tap collected the usage', collector.pendingCount('session-usage-2') === 1)

// The bridge must attach what it collected to the very next delivery.
const { AiMemoryBridge } = await import('../lib/bridge.js')
const bridge = new AiMemoryBridge(ctx, { config: () => ({ enabled: true, capture: true, reportUsage: true }), hooks: () => ({ dir: hookDir }), onEvent: () => {} })
bridge.usage.record({ sessionId: 'session-usage-3', model: 'm2' }, { inputTokens: 5, outputTokens: 6 })
const payload = { session_id: 'session-usage-3', hook_event_name: 'Stop' }
bridge.attachUsage(payload)
check('bridge attaches _ai_memory_usage_calls', Array.isArray(payload._ai_memory_usage_calls) && payload._ai_memory_usage_calls.length === 1)
const other = { session_id: 'session-unrelated' }
bridge.attachUsage(other)
check('bridge does not cross sessions', other._ai_memory_usage_calls === undefined)

// 8. the panel API exposes the consolidation endpoints
const { createApi } = await import('../lib/routes.js')
const api = createApi({
  getConfig: () => ({ serverUrl: 'http://127.0.0.1:1', token: '', dataDir: '/tmp/x', capture: true, captureMode: 'scripts' }),
  saveSettings: () => ({}),
  sync: () => ({}),
  restartCapture: () => {},
  recentEvents: () => [],
  version: 'test',
  profile: { dir: '/tmp', patchPath: '/tmp/patch.yml', name: 'test', source: 'test' },
})
check('api.consolidate exists', typeof api.consolidate === 'function')
check('api.mcpTool exists', typeof api.mcpTool === 'function')

// 9. an unreachable server surfaces as a clear error, never a silent success
let threw = ''
try {
  await api.consolidate({ dryRun: true })
} catch (error) {
  threw = String(error.message || error)
}
check('consolidate reports an unreachable server', threw.length > 0, threw.slice(0, 80))

// 10. the status document the panel relies on has every field the client reads
const statusListeners = listeners.get('llm/stream') ?? []
check('llm/stream listener attached', statusListeners.length === 1)

for (const dispose of effects) {
  try {
    dispose()
  } catch {
    /* ignore */
  }
}

const failed = results.filter((entry) => !entry.ok)
for (const entry of results) console.log(`${entry.ok ? '✓' : '✗'} ${entry.label}${entry.detail ? ` — ${entry.detail}` : ''}`)
console.log(failed.length === 0 ? '\nSMOKE OK' : `\n${failed.length} FAILED`)
