/**
 * Host-side JSON-RPC client for the ai-memory MCP endpoint.
 *
 * The panel cannot mint MCP calls itself (only the model's MCP client can),
 * so the host performs the round trip with the same bearer the hooks use.
 * The caller resolves that bearer per call and passes it in; this module
 * never reads settings or credentials.
 *
 * @module dsh-plugin-ai-memory/mcp-call
 */

import { mcpUrl } from './settings.js'

/**
 * Parse an MCP HTTP response. The server is stateless Streamable HTTP and
 * may answer either as plain JSON or as an SSE stream, so both shapes are
 * accepted; anything else is reported verbatim.
 */
export function parseMcpResponse(text) {
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
 * Call one ai-memory MCP tool over HTTP. Errors keep the server's own
 * wording: a missing LLM provider says exactly that, which is far more
 * useful than "request failed".
 *
 * @param {string} serverUrl ai-memory base URL (no `/mcp` suffix)
 * @param {string} token bearer resolved for this call, or '' for none
 * @param {string} name MCP tool name
 * @param {object} [args] tool arguments
 */
export async function callMcpTool(serverUrl, token, name, args) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'x-ai-memory-client': 'dsh-plugin',
  }
  if (token) headers.authorization = `Bearer ${token}`
  const response = await fetch(mcpUrl(serverUrl), {
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
