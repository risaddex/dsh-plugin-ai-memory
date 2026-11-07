/**
 * MCP integration: keep one `@deepseek-ai/dsh-mcp-client` loader row in the
 * active profile's patch layer in sync with the panel's server settings.
 *
 * DSH has no MCP config file — an MCP server is a Loader entry, exactly what
 * `ai-memory install-mcp --client dsh` prints for the operator to paste. This
 * module pastes and updates it for you inside a clearly marked block, so the
 * row is reviewable in `$DSH_PROFILE_DIR/cordis.patch.yml` and removable
 * without touching the rest of the file. The profile patch layer is reconciled
 * into the running Loader tree by app-boot, so a write applies live.
 *
 * @module dsh-plugin-ai-memory/mcp
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { profileDir, resolveProfile } from './paths.js'
import { bearer, mcpUrl, resolveToken } from './settings.js'

/** Stable Loader entry id for our managed row. */
export const MCP_ROW_ID = 'ai-memory-mcp'

export const MARK_BEGIN = '# >>> dsh-plugin-ai-memory: managed MCP row (edits inside this block are overwritten) >>>'
export const MARK_END = '# <<< dsh-plugin-ai-memory: managed MCP row <<<'

/** Single-quote a YAML scalar, doubling embedded quotes (upstream does the same). */
export function yamlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * Render the managed block for a configuration. Mirrors the patch fragment
 * `ai-memory install-mcp --client dsh` prints, with the row id fixed so we can
 * update or remove it deterministically.
 */
export function renderBlock(config) {
  const lines = [MARK_BEGIN, '- insert:', `    - id: ${MCP_ROW_ID}`, "      name: '@deepseek-ai/dsh-mcp-client'", '      config:']
  lines.push(`        serverName: ${yamlQuote(config.mcpServerName)}`)
  lines.push('        transport: streamable-http')
  lines.push(`        url: ${yamlQuote(mcpUrl(config.serverUrl))}`)
  const auth = bearer(resolveToken(config).token)
  if (auth) {
    lines.push('        headers:')
    lines.push(`          Authorization: ${yamlQuote(auth)}`)
  }
  lines.push(`        toolCallTimeoutMs: ${config.mcpToolCallTimeoutMs}`)
  lines.push(MARK_END)
  return lines.join('\n') + '\n'
}

/** Split a patch document into the text before and after our managed block. */
function stripBlock(text) {
  const begin = text.indexOf(MARK_BEGIN)
  if (begin === -1) return { before: text, after: '', had: false }
  const endIndex = text.indexOf(MARK_END, begin)
  if (endIndex === -1) return { before: text, after: '', had: false }
  const after = text.slice(endIndex + MARK_END.length)
  return { before: text.slice(0, begin), after: after.replace(/^\r?\n/, ''), had: true }
}

/** Read the profile patch, or an empty document when there is no profile. */
export function readPatch(profile = resolveProfile()) {
  const path = profile?.patchPath ?? ''
  if (!path) return { path: '', text: '', exists: false }
  try {
    return { path, text: readFileSync(path, 'utf8'), exists: true }
  } catch {
    return { path, text: '', exists: false }
  }
}

/** What the profile patch currently says about our managed row. */
export function inspectMcp(profile = resolveProfile()) {
  const patch = readPatch(profile)
  const { before, after, had } = stripBlock(patch.text)
  const begin = patch.text.indexOf(MARK_BEGIN)
  const end = begin === -1 ? -1 : patch.text.indexOf(MARK_END, begin)
  const block = begin !== -1 && end !== -1 ? patch.text.slice(begin, end) : ''
  const rowId = new RegExp(`^\\s*- id: ${MCP_ROW_ID}\\s*$`, 'm')
  return {
    profileDir: profile?.dir ?? '',
    patchPath: patch.path,
    patchExists: patch.exists,
    managed: had,
    // The row lives inside the managed block, so its presence is checked
    // there — a copy outside the block is an operator edit we never overwrite.
    rowPresent: rowId.test(block),
    duplicateRowOutsideBlock: rowId.test((before + after).trim()),
    url: (() => {
      const match = /^\s*url:\s*'?([^'\n]+)'?\s*$/m.exec(patch.text)
      return match ? match[1] : ''
    })(),
  }
}

/**
 * Write (or refresh) the managed row. Leaves the operator's own entries alone,
 * preserving their formatting and comments byte for byte.
 * @returns {{ ok: boolean, patchPath: string, backup?: string, error?: string }}
 */
export function applyMcp(config, profile = resolveProfile()) {
  const patch = readPatch(profile)
  if (!patch.path) return { ok: false, patchPath: '', error: 'no active DSH profile (DSH_PROFILE_DIR is unset)' }
  const { before, after } = stripBlock(patch.text)
  let head = before.replace(/\s+$/, '')
  let tail = after.replace(/^\s+/, '')
  // A patch file whose whole content is the empty sequence cannot be appended
  // to: `[]` followed by a `- insert:` item is invalid YAML. Drop the marker.
  if (head.trim() === '[]') head = ''
  const parts = []
  if (head.trim()) parts.push(head)
  parts.push(renderBlock(config).trimEnd())
  if (tail.trim()) parts.push(tail.trimEnd())
  const next = parts.join('\n\n') + '\n'
  let backup = ''
  try {
    mkdirSync(dirname(patch.path), { recursive: true })
    if (patch.exists) {
      backup = `${patch.path}.dsh-plugin-ai-memory.bak`
      copyFileSync(patch.path, backup)
    }
    writeFileSync(patch.path, next, 'utf8')
    return { ok: true, patchPath: patch.path, backup, changed: next !== patch.text }
  } catch (error) {
    return { ok: false, patchPath: patch.path, error: String(error?.message || error) }
  }
}

/** Remove the managed row, restoring the rest of the file untouched. */
export function removeMcp(profile = resolveProfile()) {
  const patch = readPatch(profile)
  if (!patch.path) return { ok: false, patchPath: '', error: 'no active DSH profile' }
  const { before, after, had } = stripBlock(patch.text)
  if (!had) return { ok: true, patchPath: patch.path, changed: false }
  const head = before.replace(/\s+$/, '')
  const tail = after.replace(/^\s+/, '')
  const next = [head, tail].filter((part) => part.trim()).join('\n') + '\n'
  try {
    writeFileSync(patch.path, next || '[]\n', 'utf8')
    return { ok: true, patchPath: patch.path, changed: true }
  } catch (error) {
    return { ok: false, patchPath: patch.path, error: String(error?.message || error) }
  }
}

/** True when the patch file exists, for the status card. */
export function patchExists(profile = resolveProfile()) {
  const path = profile?.patchPath ?? ''
  return Boolean(path && existsSync(path))
}
