window.__ModuleLoader__.load({ id: "dsh-plugin-ai-memory", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
/**
 * dsh-plugin-ai-memory — browser half, entry.
 *
 * Contributes ONE entry to the shell's global panel rail (`sidebar.panellist`)
 * and the page that entry opens in the layout's keyed `main` slot. The id is
 * shared by both registrations, which is the whole contract: the sidebar row
 * calls `ctx.layout.selectPanel("ai-memory")` for us, and the layout then
 * renders `main` with that key.
 *
 * The page itself — status, hooks, settings and the delivery log — lives in the
 * package-local chunk `client.page.js`, loaded on first open through
 * `require.async` + React.lazy, so the rail entry stays cheap.
 *
 * Everything else is a thin client over the host's authenticated
 * `connection.rpc.call('/api', 'ai-memory.<endpoint>', payload)` channel, so
 * the ai-memory bearer token never reaches the browser.
 */
const React = require("react");
const h = React.createElement;

const PANEL_ID = "ai-memory";
const NS = "aiMemory";
const CSS_ID = "dsh-plugin-ai-memory/styles";
const RPC = "ai-memory";

// ── i18n ────────────────────────────────────────────────────────────────────
const en = {
  "panel.label": "AI Memory",
  "panel.title": "AI Memory",
  "panel.subtitle": "Global capture hooks + MCP for ai-memory",
  "status.checking": "Checking…",
  "status.online": "server online",
  "status.offline": "server unreachable",
  "status.capture": "capture",
  "status.captureOn": "running the ai-memory hooks",
  "status.captureOff": "off",
  "status.mcp": "MCP",
  "status.mcpOn": "row written",
  "status.mcpOff": "not managed",
  "section.server": "Server / workstream",
  "section.capture": "Lifecycle capture",
  "section.mcp": "MCP tools",
  "section.consolidate": "Consolidation",
  "section.marker": "Project marker",
  "field.sessionId": "Session id (optional)",
  "field.sessionId.hint": "Blank consolidates the latest completed session of this project.",
  "hint.consolidate": "This asks the ai-memory server to compile the session into wiki pages. It needs an LLM provider configured on the server (health shows \"llm provider disabled\" otherwise).",
  "btn.consolidate": "Consolidate now",
  "btn.dryRun": "Dry run (no LLM)",
  "consolidate.ok": "Consolidation queued", 
  "section.activity": "Recent deliveries",
  "field.serverUrl": "ai-memory server URL",
  "field.serverUrl.hint": "Local (http://127.0.0.1:49374) or a remote workstream server (https://memory.example:49374).",
  "field.token": "Bearer token",
  "field.token.hint": "Optional. Required when the server runs with auth; the token stays on the host.",
  "field.dataDir": "ai-memory data dir",
  "field.dataDir.hint": "Where the hooks spool offline events and keep session state. Blank uses the platform default.",
  "field.strategy": "Project strategy",
  "field.strategy.hint": "How the server names the project when no .ai-memory.toml marker pins one.",
  "field.captureMode": "Delivery",
  "field.captureMode.hint": "scripts runs ai-memory's own hooks/dsh scripts; native runs the ai-memory CLI hook command.",
  "field.marker.dir": "Repository directory",
  "field.marker.workspace": "workspace",
  "field.marker.project": "project",
  "field.marker.hint": "Writes .ai-memory.toml so this checkout maps to a named workspace/project on the server.",
  "btn.save": "Save",
  "btn.saving": "Saving…",
  "btn.test": "Test connection",
  "btn.testEvent": "Send test event",
  "btn.installHooks": "Re-install hooks",
  "btn.applyMcp": "Write MCP row",
  "btn.removeMcp": "Remove MCP row",
  "btn.marker": "Write marker",
  "btn.refresh": "Refresh",
  "btn.workstreams": "List workstreams",
  "label.enabled": "Plugin enabled",
  "label.capture": "Capture sessions",
  "label.mcp": "Manage the MCP row",
  "label.guidance": "Teach agents when to use the cross-project inbox",
  "label.reuse": "Reuse ai-memory's staged hooks",
  "label.usage": "Report token usage per model response",
  "label.overwrite": "Overwrite an existing marker",
  "value.strategy.default": "server default",
  "value.strategy.basename": "basename(cwd)",
  "value.strategy.reporoot": "repo root",
  "hint.profile": "Profile",
  "hint.staged": "Hooks staged in",
  "hint.patch": "Profile patch",
  "hint.binary": "ai-memory CLI",
  "hint.binary.missing": "not found on PATH (capture still works through the hook scripts)",
  "event.none": "No deliveries yet. Use the harness and this list fills up.",
  "note.reload": "An MCP row change reloads the profile patch live; the tools appear as mcp__<name>__memory_query.",
};
const zh = { ...en, "panel.label": "AI 记忆", "panel.title": "AI 记忆" };

// ── styles ──────────────────────────────────────────────────────────────────
const css = `
.am-root{height:100%;overflow:auto;padding:20px 24px 40px;color:var(--dsw-alias-label-primary,#1f2328);
  background:var(--dsw-alias-bg-base,#fff);font:13px/1.5 var(--dsw-font-family-text,system-ui,sans-serif)}
.am-head{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:4px}
.am-title{margin:0;font-size:17px;font-weight:600}
.am-sub{margin:0 0 16px;color:var(--dsw-alias-label-secondary,#59636e);font-size:12.5px}
.am-chips{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px}
.am-chip{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border-radius:999px;
  border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.28));font-size:12px;
  background:var(--dsw-alias-bg-layer-1,#f6f7f8);color:var(--dsw-alias-label-secondary,#59636e)}
.am-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary,#8a8f98)}
.am-dot.ok{background:var(--dsw-alias-state-success-primary,#1a7f37)}
.am-dot.bad{background:var(--dsw-alias-state-error-primary,#c11)}
.am-dot.warn{background:var(--dsw-alias-state-warn-primary,#b7791f)}
.am-card{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.28));border-radius:10px;
  background:var(--dsw-alias-bg-layer-1,#f6f7f8);padding:14px 16px;margin-bottom:14px}
.am-card h3{margin:0 0 10px;font-size:13px;font-weight:600;letter-spacing:.01em}
.am-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}
.am-row{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}
.am-row>label{font-size:11.5px;color:var(--dsw-alias-label-secondary,#59636e)}
.am-hint{margin:0;font-size:11px;color:var(--dsw-alias-label-secondary,#59636e);opacity:.85}
.am-in,.am-sel{height:30px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.28));border-radius:7px;
  background:var(--dsw-alias-bg-base,#fff);color:inherit;padding:0 9px;font:12.5px/1.4 inherit;outline:none}
.am-in:focus,.am-sel:focus{border-color:var(--dsw-alias-brand-primary,#3b6cf6)}
.am-in.mono{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace)}
.am-check{display:flex;align-items:center;gap:8px;margin:7px 0;color:var(--dsw-alias-label-primary,#1f2328)}
.am-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px}
.am-btn{height:28px;padding:0 12px;border-radius:7px;cursor:pointer;font:12.5px/1.4 inherit;
  border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.28));background:var(--dsw-alias-bg-base,#fff);color:inherit}
.am-btn:hover{border-color:var(--dsw-alias-border-l2,rgba(128,128,128,.5))}
.am-btn.primary{background:var(--dsw-alias-brand-primary,#3b6cf6);border-color:transparent;
  color:var(--dsw-alias-label-primary-inverted,#fff)}
.am-btn:disabled{opacity:.55;cursor:default}
.am-flash{margin-top:10px;font-size:12px}
.am-flash.ok{color:var(--dsw-alias-state-success-primary,#1a7f37)}
.am-flash.bad{color:var(--dsw-alias-state-error-primary,#c11)}
.am-kv{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:11.5px;
  color:var(--dsw-alias-label-secondary,#59636e)}
.am-kv code{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;
  color:var(--dsw-alias-label-primary,#1f2328);word-break:break-all}
.am-list{display:flex;flex-direction:column;gap:4px;max-height:220px;overflow:auto;font-size:11.5px;
  font-family:var(--ds-font-family-code,ui-monospace,monospace)}
.am-list-row{display:grid;grid-template-columns:74px 1fr auto;gap:8px;padding:2px 0;
  border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16))}
.am-empty{color:var(--dsw-alias-label-secondary,#59636e);font-size:12px}
`;

// ── rail glyph ─────────────────────────────────────────────────────────────
/** Shell owns the row, tooltip, label, aria and click; we only draw the glyph. */
function MemoryIcon({ size = 16, active }) {
  return h("svg", {
    width: size, height: size, viewBox: "0 0 16 16", fill: "none",
    stroke: "currentColor", strokeWidth: active ? 1.9 : 1.5,
    strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true",
  }, [
    h("path", { key: "a", d: "M2.5 4.2c0-.6.5-1 1.1-1h3.3c.6 0 1.1.4 1.1 1v8.6c0-.6-.5-1-1.1-1H3.6c-.6 0-1.1.4-1.1 1V4.2Z" }),
    h("path", { key: "b", d: "M13.5 4.2c0-.6-.5-1-1.1-1H9.1c-.6 0-1.1.4-1.1 1v8.6c0-.6.5-1 1.1-1h2.2c.6 0 1.1.4 1.1 1V4.2Z", opacity: active ? 1 : 0.75 }),
    h("path", { key: "c", d: "M6.4 6.2h.01M6.4 8.4h.01M9.6 6.2h.01M9.6 8.4h.01" }),
  ]);
}

// ── plugin entry ───────────────────────────────────────────────────────────
/**
 * Boundary around the page: a render error inside the panel must show a card,
 * never take the host UI down with it.
 */
class PanelBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error: String((error && error.message) || error) };
  }
  render() {
    if (this.state.error) {
      return h("div", { className: "am-root" }, [
        h("h2", { key: "t", className: "am-title" }, "AI Memory"),
        h("p", { key: "e", className: "am-flash bad" }, `panel error: ${this.state.error}`),
        h("p", { key: "h", className: "am-hint" }, "Reload the page; if it persists, check the host log."),
      ]);
    }
    return this.props.children;
  }
}

// ── panel page (package-local chunk) ───────────────────────────────────────
const LazyPanel = React.lazy(async () => ({ default: (await require.async("./client.page.js")).MemoryPanel }));

function PanelView(props) {
  return h(PanelBoundary, null,
    h(React.Suspense, { fallback: h("div", { className: "am-root" }, h("p", { className: "am-empty" }, "Loading…")) },
      h(LazyPanel, props)));
}

const inject = ["slots", "locale", "connection"];

function apply(ctx) {
  const t = ctx.locale.bind(NS);
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), "ai-memory: dictionaries");

  ctx.effect(() => {
    if (document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_ID)}]`)) return () => {};
    const style = document.createElement("style");
    style.dataset.pluginCss = CSS_ID;
    style.textContent = css;
    document.head.appendChild(style);
    return () => style.remove();
  }, "ai-memory: styles");

  const api = async (endpoint, payload) => {
    const result = await ctx.connection.rpc.call("/api", `${RPC}.${endpoint}`, payload ?? {});
    if (!result || !result.ok) throw new Error((result && result.error && result.error.message) || "request failed");
    return result.value;
  };

  // The page in the layout's keyed `main` slot (chunk loads on first open).
  ctx.effect(() => ctx.slots.inject("main", () => ctx.slots.register({
    name: "main",
    key: PANEL_ID,
    locale: NS,
    inject: () => ({ api, t }),
  }, PanelView)), "ai-memory: main panel");

  // The rail icon in the sidebar's global panel list. Same id as the main key.
  ctx.effect(() => ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
    name: "sidebar.panellist",
    id: PANEL_ID,
    order: 30,
    locale: NS,
    label: () => t("panel.label"),
  }, MemoryIcon)), "ai-memory: panellist entry");
}

exports.apply = apply;
exports.inject = inject;
return module.exports; } });
