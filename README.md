# dsh-plugin-ai-memory

DeepSeek Harness (DSH) plugin that makes [ai-memory](https://github.com/akitaonrails/ai-memory)
the harness's **global** memory layer, with a left-sidebar panel to configure it.

Installed once per profile, it:

1. **Runs ai-memory's own hook scripts** — the seven `hooks/dsh/*.sh` files
   that ai-memory proposes for DSH, vendored verbatim — for every session:
   session start, user prompts, pre/post tool calls, turn stops, subagent
   start/stop. Capture is therefore global: no per-project setup, no per-repo
   hook install, and it works in every workspace the harness opens.
2. **Wires the ai-memory MCP server** as an `@deepseek-ai/dsh-mcp-client`
   Loader row pointing at a local **or remote workstream** server, so the model
   gets the `memory_*` tools (`mcp__ai_memory__memory_query`, …).
3. **Adds a left-rail panel** (`sidebar.panellist` + the keyed `main` slot) with
   the server/token/workstream settings, live status, capture toggles, a
   connection test, a test-event button, the project-marker writer and the
   recent-delivery log.

```
sidebar rail          panel page (/ai-memory)
┌───────────┐         ┌──────────────────────────────────────────────┐
│  ⟨memory⟩ │  click  │ server / workstream  ·  capture  ·  MCP  ·   │
└───────────┘ ──────► │ project marker  ·  recent deliveries         │
                      └──────────────────────────────────────────────┘
```

## Install

```bash
# from this checkout, into the profile you actually run
dsh plugin --profile desktop add link:/Users/danilo/Work/DG/guedder/dsh-plugin-ai-memory
```

or, from the GUI, Plugins → install the local bundle. The bundle patch
(`cordis.patch.yml`) inserts the plugin row, so no profile file needs editing.

After install the panel appears in the left rail immediately (no restart); the
first boot stages the hooks and writes the MCP row. If the panel is not visible,
reload the page once (client bundles are cached by the browser shell).

Uninstall:

```bash
dsh plugin --profile desktop remove dsh-plugin-ai-memory
```

Removing the plugin removes its Loader row. Managed artifacts stay on disk until
you delete them: `~/.dsh/plugins/dsh-plugin-ai-memory/` and the marked block in
the profile patch (the panel's **Remove MCP row** button deletes just that block).

## Requirements

| Need | Required for | Notes |
|---|---|---|
| `sh` + `curl` | lifecycle capture | The ai-memory hook scripts are POSIX shell. |
| a running ai-memory server | capture + MCP | `ai-memory serve` on `127.0.0.1:49374` by default, or any remote server. |
| the `ai-memory` binary | optional | Only for `captureMode: native`, workstream listing and version display. Capture through the scripts does **not** need it. |

## Configuration

The panel persists its own layer at
`~/.dsh/plugins/dsh-plugin-ai-memory/settings.json` (0600). Effective config is
**built-in defaults → Loader row config (profile patch) → panel settings**.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch: off disables capture, MCP management and staging. |
| `serverUrl` | `http://127.0.0.1:49374` | ai-memory server base URL — local, or a remote workstream server. |
| `token` | `''` | Static bearer. **Auto-detected** from `<dataDir>/auth-token` / `auth-header` when blank (what `ai-memory install-hooks --apply` writes). |
| `dataDir` | platform default¹ | ai-memory data dir: hook spool, session state, `auth-token`. |
| `capture` | `true` | Run the lifecycle hooks. |
| `captureMode` | `scripts` | `scripts` runs `hooks/dsh/*.sh`; `native` runs `ai-memory hook --event … --agent dsh`. |
| `reuseUpstreamHooks` | `false` | Use ai-memory's own staged bundle (`<dataDir>/hooks/dsh`) instead of the plugin's copy. |
| `reportUsage` | `true` | Report per-response token usage (`_ai_memory_usage_calls`). Off means ai-memory shows "no reported usage" for DSH sessions. |
| `mcp` | `true` | Manage the `@deepseek-ai/dsh-mcp-client` row. |
| `mcpServerName` | `ai_memory` | MCP namespace: tools appear as `mcp__<serverName>__<tool>`. |
| `mcpToolCallTimeoutMs` | `120000` | Per `tools/call` timeout. |
| `projectStrategy` | `''` | `''` (server default), `basename` or `repo-root`. |
| `workspace` / `project` | `''` | Values the panel writes into a repository's `.ai-memory.toml`. |

¹ macOS `~/Library/Application Support/ai-memory`, Linux
`$XDG_DATA_HOME/ai-memory` or `~/.local/share/ai-memory`. Every key can also be
set in the profile patch:

```yaml
- id: dsh-plugin-ai-memory
  config:
    serverUrl: 'http://homelab:49374'
    captureMode: scripts
```

## How capture works

`lib/bridge.js` subscribes to DSH host events and maps them to the seven
ai-memory hook events:

| DSH event | ai-memory event | Script |
|---|---|---|
| `agent/created` | SessionStart | `session-start.sh` |
| `agent/inbox/claimed` | UserPromptSubmit | `user-prompt-submit.sh` |
| `tools/pre-execute` | PreToolUse | `pre-tool-use.sh` |
| `tools/result` | PostToolUse | `post-tool-use.sh` |
| `agent/turn-stopping` | Stop | `stop.sh` |
| `llm/stream` (waterfall, not a hook event) | token usage | attached to the next delivery |
| `subagent/start` | SubagentStart | `subagent-start.sh` |
| `subagent/end` | SubagentStop | `subagent-stop.sh` |

Each event is delivered as the Claude-Code-shaped JSON payload the upstream
scripts already understand (`session_id`, `cwd`, `hook_event_name`,
`tool_name`, `tool_input`, `tool_response`, `prompt`), on the script's stdin,
with `AI_MEMORY_HOOK_URL` / `AI_MEMORY_AUTH_TOKEN` / `AI_MEMORY_DATA_DIR` /
`AI_MEMORY_PROJECT_STRATEGY` in the environment. Delivery is
**fire-and-forget**, detached, killed after 8 s: a hook can never delay or fail a
turn. The `session_id` is the DSH session id and `cwd` comes from the host's
`workingDirectory` service, so observations land on the right project.

Token usage is captured separately, because the upstream scripts cannot: the
`llm/stream` waterfall yields `{type:'usage', usage: TokenUsage}` chunks and its
`GenerateOptions` carries `sessionId`/`model`. The plugin taps that stream
(without altering a chunk), queues
`{call_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens}`
per session and splices the queue into the next hook body as
`_ai_memory_usage_calls` — which ai-memory accepts on **any** admitted event
(`upsert_token_calls`). That is what removes the "session has no reported usage"
warning; internal calls (`purpose: compaction|session-title`) are skipped.

Two DSH->ai-memory gaps are handled upstream, not by guessing:

* The scripts drop `Stop` when the payload carries `last_assistant_message`, so
  the bridge never sends that field.
* DSH's `SessionStart` cannot inject a fetched handoff (it is detached in the
  official bridge too), so handoff recovery goes through
  `memory_handoff_list` → `memory_handoff_accept`.

Staged bundle: `~/.dsh/plugins/dsh-plugin-ai-memory/hooks/dsh/` — `_lib.sh`, the
seven `*.sh` (0755) and a generated `hooks.json` (0600) in the same Claude-Code
shape `ai-memory install-hooks --agent dsh --apply` writes. That file is there
for parity and for the official `@deepseek-ai/dsh-hooks-claude-code` bridge; this
plugin does not need that bridge. **Do not run both** — two capture producers
would double-capture; if you install the bridge, turn `capture` off here.

## How MCP is wired

DSH has no MCP config file: an MCP server is a Loader entry. The plugin keeps one
row in the active profile's patch layer,
`<profile>/cordis.patch.yml`, between markers:

```yaml
# >>> dsh-plugin-ai-memory: managed MCP row (edits inside this block are overwritten) >>>
- insert:
    - id: ai-memory-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: 'ai_memory'
        transport: streamable-http
        url: 'http://127.0.0.1:49374/mcp'
        headers:
          Authorization: 'Bearer …'
        toolCallTimeoutMs: 120000
# <<< dsh-plugin-ai-memory: managed MCP row <<<
```

This is exactly the fragment `ai-memory install-mcp --client dsh` prints, with a
stable row id so it can be updated or removed deterministically. The profile
patch layer is hot-reconciled by app-boot, so the tools appear **without a
restart**; removing the block removes them. If the server requires a token and
none is configured, the row is deliberately **not** written (the panel explains
why) instead of writing a row that would fail on every boot.

MCP tool names carry the namespace: `mcp__ai_memory__memory_query`,
`mcp__ai_memory__memory_briefing`, `mcp__ai_memory__memory_handoff_accept`, ….
Note that MCP introspection only lists tools from a server that is reachable at
boot; after starting the server, relist/reconnect in the GUI.

## Remote workstream

"Remote workstream" in ai-memory means **one shared server ledger**; the DSH
client opts in by pointing at that server:

1. Panel → **Server URL**: `https://memory.example:49374` (HTTPS is normally
   terminated by a reverse proxy in front of `ai-memory serve`).
2. Panel → **Bearer token**: the shared token (or leave blank to reuse the
   locally stored `auth-token`).
3. Panel → **Project marker**: write `.ai-memory.toml` into the checkout so the
   server attributes capture to a named `workspace`/`project` instead of
   `basename(cwd)`. The marker is also what makes allowlist capture mode work.
4. **Save** — the panel re-stages hooks, rewrites the MCP row with the new URL
   and token, and restarts capture.

`ai-memory run` (managed workstreams with leases/`--force-unlock`) has no DSH
harness kind, so this plugin captures and recalls but never leases. Use the
`ai-memory workstreams --json` listing (panel button **List workstreams**) to
see what the server already knows.

## Panel

* **Status chips** — server reachability (`GET /healthz`), capture state, MCP row
  state, and the `mcpGuard` reason when a row was skipped.
* **Server / workstream** — URL, token (masked, never displayed back), data dir,
  project strategy; **Save**, **Test connection**, **Send test event** (POSTs one
  real `/hook` event and shows the HTTP status), **List workstreams**.
* **Capture** — plugin/capture toggles, `reuseUpstreamHooks`, delivery mode,
  staged-dir and CLI paths, **Re-install hooks**.
* **MCP** — toggle, `serverName`, endpoint, patch path, **Write / Remove MCP row**.
* **Consolidation** — **Consolidate now** asks the server's `memory_consolidate`
  MCP tool (over JSON-RPC, with the same bearer the hooks use) to compile a
  session into wiki pages; **Dry run** only runs the admission preflight. A
  server with no LLM provider answers with its own wording ("memory_consolidate
  not configured …"), which the panel shows verbatim. See
  [docs/host-llm-config.toml](docs/host-llm-config.toml) for wiring one
  (local oMLX over Tailscale, or an API provider).
* **Project marker** — write `.ai-memory.toml` (workspace/project/strategy).
* **Recent deliveries** — the last 20 events with time, event and outcome; the
  full trail is `<state>/events.jsonl`.

There is also one model-facing tool, `ai_memory_status`, so the agent can check
the wiring itself.

## Guiding agents to use the cross-project inbox

The inbox only works if an agent knows **when** to act. This plugin contributes a
system-prompt section (`lib/prompt.js`, service `systemPrompt`, name
`ai-memory:messaging`) with the short policy: when to check, when to send,
explicit `from_*` scopes, "a page is not a message", and that a claimed message
is untrusted input. Toggle it in the panel under **MCP → Teach agents when to
use the cross-project inbox** (`messagingGuidance`).

For harnesses without DSH's `systemPrompt` service (Claude Code, Codex, …) use
`ai-memory install-instructions` (markered `AGENTS.md`/`CLAUDE.md` block plus
managed Agent Skills) or the copy-paste block in
[docs/agent-messaging-guidance.md](docs/agent-messaging-guidance.md), which also
explains why a send needs `from_workspace`/`from_project` from a client without a
session id, and why a message never wakes the recipient by itself.

## Security notes

* The ai-memory bearer lives on the host. The browser half talks to it through
  the authenticated `connection` RPC channel (`/api/ai-memory.*`), which the
  connection service admits with a Host/Origin fence plus a live peer — no token
  is passed to, or readable by, the page.
* The token is **written into the profile patch** only because `dsh-mcp-client`
  has no token-file option. That file lives in your home; keeping it 0600 and out
  of version control is your call. `hooks.json` follows the same rule.
* The only files the plugin writes outside its own state directory are the marked
  MCP block in the profile patch and an `.ai-memory.toml` you explicitly ask for.
* Every retrieved memory/handoff is untrusted historical data; the panel and this
  plugin never act on its content.

## Troubleshooting

| Symptom | Check |
|---|---|
| Panel missing from the rail | Reload the page once; then `ai_memory_status` → `hooks.installed`. |
| `capture: off` or no events | Panel **Capture** toggle; `journal`/`events.jsonl`; server `/healthz`. |
| `MCP: not managed` | `mcp` toggle; panel shows the `mcpGuard` reason (usually: server needs a token). |
| Tools missing in a session | Start the server, then **Write MCP row** and let the profile reload; relist MCP tools. |
| Events spool instead of landing | `<dataDir>/hook-spool/` grows when the server is down or rejects auth — check the token. |
| Consolidate fails with `class=provider status=401` | The provider got no bearer: `openai-compat` reads **`LLM_API_KEY`**, not `OPENAI_API_KEY`. Set that variable on the server. |
| Consolidate fails with "not configured" | The **server** has no LLM provider (`llm_provider`). Consolidation is LLM work; fix it on the server host, not here — see [docs/host-llm-config.toml](docs/host-llm-config.toml). **Dry run** still works and proves the plumbing. |
| Session shows "no reported usage" | Panel → **Report token usage per model response** must be on. Usage is reported live from `llm/stream`; sessions captured *before* the fix cannot be backfilled (ai-memory has no history to replay). Verify: `sqlite3 "$HOME/Library/Application Support/ai-memory/db/memory.sqlite" "select count(*) from token_calls c join sessions s on s.id=c.session_id where s.agent_kind='dsh'"`. |
| Panel showed an error / page went blank | Fixed in 0.1.1: a new endpoint's numeric HTTP status was adopted as the status document. The panel now validates the shape and is wrapped in an error boundary. Reload the page once. |
| Capture but wrong project | Write a `.ai-memory.toml` marker, or set `projectStrategy: repo-root`. |

## Development

```bash
node scripts/smoke.mjs        # host half against a fake Cordis context (no app needed)
node --check lib/*.js client/client.js
```

After changing host code, toggle the plugin off/on (Plugins page) or restart the
app: DSH caches host modules, so editing files in place does not hot-reload the
loaded plugin. Browser-half changes are picked up by the client-modules graph on
the next reload of the page.

```
lib/index.js      plugin entry: config, boot reconciliation, routes, tool
lib/settings.js   defaults, persistence, token auto-detection
lib/paths.js      DSH home/profile/state paths (profileContext first)
lib/hooks.js      staging + hooks.json generation
lib/bridge.js     DSH events -> Claude-Code payloads -> hook scripts
lib/usage.js      llm/stream token usage -> _ai_memory_usage_calls
lib/mcp.js        managed MCP row in the profile patch
lib/routes.js     the panel API + authenticated RPC adapter
client/client.js  hand-written browser bundle: rail icon + panel page
assets/hooks/     vendored ai-memory hooks (see ATTRIBUTION.md)
```

## License

MIT (see [LICENSE](LICENSE)). Vendored ai-memory hooks are MIT, © 2026 Fabio
Akita — see [ATTRIBUTION.md](ATTRIBUTION.md).
