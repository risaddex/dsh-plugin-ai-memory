/**
 * Credential-reference checks (`tokenRef`): the managed MCP row carries a
 * `${credential:REF}` template instead of the bearer, host-side calls resolve
 * the value through `ctx.credentials` per call, and no artifact the plugin
 * writes contains the secret. Called from smoke.mjs.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import { join } from 'node:path'

export async function runCredentialChecks({ check, ROOT }) {
  const { renderBlock, applyMcp, MARK_BEGIN, MARK_END } = await import('../lib/mcp.js')
  const settings = await import('../lib/settings.js')
  const { hookEnvPrefix } = await import('../lib/hooks.js')
  const { AiMemoryBridge } = await import('../lib/bridge.js')
  const { createApi } = await import('../lib/routes.js')

  const LITERAL = 'tok-literal-should-not-leak'
  const SECRET = 'cred-value-should-not-leak'
  // An empty data dir keeps the auto-detection off the operator's real files.
  const dataDir = join(ROOT, 'creds-data')
  mkdirSync(dataDir, { recursive: true })
  const base = {
    serverUrl: 'http://127.0.0.1:1',
    mcpServerName: 'ai_memory',
    mcpToolCallTimeoutMs: 120000,
    dataDir,
    token: LITERAL,
  }

  // 1. literal path unchanged when tokenRef is empty
  const literal = renderBlock({ ...base, tokenRef: '' })
  check('literal row keeps the bearer', literal.includes(`Authorization: 'Bearer ${LITERAL}'`))
  check('literal row has no expandTemplates', !literal.includes('expandTemplates'))

  // 2. tokenRef: template, expandTemplates, no literal
  const templated = renderBlock({ ...base, tokenRef: 'AI_MEMORY_TOKEN' })
  check('ref row expands templates', templated.includes('        expandTemplates: true\n        serverName:'))
  check('ref row uses the credential template', templated.includes("Authorization: 'Bearer ${credential:AI_MEMORY_TOKEN}'"))
  check('ref row has no literal token', !templated.includes(LITERAL))
  const expected = [
    MARK_BEGIN,
    '- insert:',
    '    - id: ai-memory-mcp',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        expandTemplates: true',
    "        serverName: 'ai_memory'",
    '        transport: streamable-http',
    "        url: 'http://127.0.0.1:1/mcp'",
    '        headers:',
    "          Authorization: 'Bearer ${credential:AI_MEMORY_TOKEN}'",
    '        toolCallTimeoutMs: 120000',
    MARK_END,
  ].join('\n') + '\n'
  check('ref row is exactly the templated block', templated === expected)

  // 3. the written patch carries the template and no secret
  const patchPath = join(ROOT, 'creds-profile', 'cordis.patch.yml')
  mkdirSync(join(ROOT, 'creds-profile'), { recursive: true })
  writeFileSync(patchPath, '# operator line\n- insert: []\n')
  const written = applyMcp({ ...base, tokenRef: 'AI_MEMORY_TOKEN' }, { patchPath, dir: join(ROOT, 'creds-profile') })
  const patchText = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
  check('applyMcp writes the templated row', written.ok && patchText.includes('${credential:AI_MEMORY_TOKEN}'))
  check('patch keeps the operator line', patchText.startsWith('# operator line'))
  check('patch has no literal token', !patchText.includes(LITERAL))

  // 4. config: grammar, precedence, persistence
  const home = { DSH_HOME: join(ROOT, 'creds-home') }
  check('invalid tokenRef is dropped', settings.resolveConfig({ tokenRef: 'bad-ref!' }, home).tokenRef === '')
  check('valid tokenRef is kept', settings.resolveConfig({ tokenRef: 'AI_MEMORY_TOKEN' }, home).tokenRef === 'AI_MEMORY_TOKEN')
  check('sync resolveToken ignores the literal with a ref',
    settings.resolveToken({ ...base, tokenRef: 'AI_MEMORY_TOKEN' }).token === '')
  settings.writeSettings({ token: LITERAL }, home)
  const saved = settings.writeSettings({ tokenRef: 'AI_MEMORY_TOKEN' }, home)
  const settingsText = readFileSync(join(home.DSH_HOME, 'plugins', 'dsh-plugin-ai-memory', 'settings.json'), 'utf8')
  check('saving tokenRef drops the literal token', saved.token === undefined && !settingsText.includes(LITERAL))
  check('credential template text', settings.credentialTemplate('AI_MEMORY_TOKEN') === '${credential:AI_MEMORY_TOKEN}')

  // 5. live resolution through the credentials seam
  const resolved = []
  const credentials = {
    resolve: async (ref) => { resolved.push(ref); return ref === 'AI_MEMORY_TOKEN' ? { value: SECRET, source: 'store' } : undefined },
    describe: async (ref) => ({ configured: ref === 'AI_MEMORY_TOKEN', source: 'store', writable: true, masked: 'cred-…leak' }),
  }
  const live = await settings.resolveTokenLive({ ...base, tokenRef: 'AI_MEMORY_TOKEN' }, credentials)
  check('resolveTokenLive reads the credential', live.token === SECRET && resolved.includes('AI_MEMORY_TOKEN'))
  const missing = await settings.resolveTokenLive({ ...base, tokenRef: 'AI_MEMORY_TOKEN' }, undefined)
  check('no credentials service yields no token (never the literal)', missing.token === '')
  const literalLive = await settings.resolveTokenLive({ ...base, tokenRef: '' }, credentials)
  check('resolveTokenLive keeps the literal path without a ref', literalLive.token === LITERAL)
  const described = await settings.describeTokenRef({ tokenRef: 'AI_MEMORY_TOKEN' }, credentials)
  check('describeTokenRef never carries the value', described.configured === true && !JSON.stringify(described).includes(SECRET))

  // 6. hooks.json never embeds a credential-backed bearer
  check('hooks.json prefix omits the token with a ref',
    !hookEnvPrefix({ ...base, tokenRef: 'AI_MEMORY_TOKEN' }).includes('AI_MEMORY_AUTH_TOKEN'))
  check('hooks.json prefix keeps the literal without a ref',
    hookEnvPrefix({ ...base, tokenRef: '' }).includes(`AI_MEMORY_AUTH_TOKEN='${LITERAL}'`))

  // 7. the bridge injects the resolved bearer per delivery, in memory only
  const hookDir = join(ROOT, 'creds-hooks')
  mkdirSync(hookDir, { recursive: true })
  const seen = join(ROOT, 'creds-hooks-seen.txt')
  writeFileSync(join(hookDir, 'stop.sh'), `#!/bin/sh\ncat >/dev/null\nprintf '%s' "$AI_MEMORY_AUTH_TOKEN" > '${seen}'\n`)
  chmodSync(join(hookDir, 'stop.sh'), 0o755)
  const bridgeConfig = { ...base, tokenRef: 'AI_MEMORY_TOKEN', enabled: true, capture: true, captureMode: 'scripts' }
  const delivered = new Promise((resolve) => {
    const bridge = new AiMemoryBridge({ get: () => undefined }, {
      config: () => bridgeConfig,
      hooks: () => ({ dir: hookDir }),
      liveToken: (config) => settings.resolveTokenLive(config, credentials),
      onEvent: resolve,
    })
    bridge.deliver('stop', { session_id: 'creds-1', hook_event_name: 'Stop' })
  })
  const event = await Promise.race([delivered, new Promise((resolve) => setTimeout(() => resolve(null), 5000))])
  const seenToken = existsSync(seen) ? readFileSync(seen, 'utf8') : ''
  check('bridge exports the credential to the hook', Boolean(event && event.ok) && seenToken === SECRET, event ? JSON.stringify(event) : 'timeout')
  check('bridge does not fall back to the literal', seenToken !== LITERAL)

  // 8. the panel status reports the ref without the value
  const api = createApi({
    getConfig: () => ({ ...base, tokenRef: 'AI_MEMORY_TOKEN', repoRoots: [] }),
    saveSettings: () => ({}),
    sync: () => ({}),
    restartCapture: () => {},
    recentEvents: () => [],
    version: 'test',
    profile: { dir: join(ROOT, 'creds-profile'), patchPath, name: 'test', source: 'test' },
    credentials: () => credentials,
  })
  const status = await api.status()
  const statusText = JSON.stringify(status)
  check('status reports the credential as configured', status.config.hasToken === true && status.config.tokenRef === 'AI_MEMORY_TOKEN'
    && status.config.tokenSource.startsWith('credential:AI_MEMORY_TOKEN'), status.config.tokenSource)
  check('status never carries the secret or the literal', !statusText.includes(SECRET) && !statusText.includes(LITERAL))
}
