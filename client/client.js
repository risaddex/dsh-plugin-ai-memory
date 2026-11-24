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

  "tab.config": "Config",
  "tab.inbox": "Inbox",
  "inbox.currentSession": "Sessão atual (marker .ai-memory.toml):",
  "inbox.noMarker": "nenhum marker neste checkout",
  "inbox.newHandoff": "Novo handoff",
  "inbox.pending": "Pendentes",
  "inbox.loading": "Carregando a caixa de entrada…",
  "inbox.empty": "Nenhuma mensagem pendente nos projetos conhecidos.",
  "inbox.from": "de",
  "inbox.noSubject": "(sem assunto)",
  "inbox.sameProject": "mesmo projeto",
  "inbox.openAgent": "Abrir agente",
  "inbox.mapProject": "Mapear projeto",
  "inbox.cancel": "Cancelar",
  "inbox.noCheckout": "sem checkout local",
  "inbox.noSessions": "O host não expõe sessions.create — não foi possível abrir o agente.",
  "inbox.opened": "Nova sessão aberta com o prompt pré-preenchido (não enviado).",
  "inbox.mapTitle": "Mapeamento projeto → caminho local",
  "inbox.mapScope": "workspace / projeto",
  "inbox.mapPath": "caminho",
  "inbox.currentPill": "sessão atual",
  "inbox.composerHint": "O destinatário não vê esta sessão. O corpo precisa ser autocontido (arquivos, contrato, critério de aceite). from_* vem do marker e não pode ser inferido — o servidor recusa envio sem eles.",
  "inbox.fromMarker": "Preenchido a partir de .ai-memory.toml da sessão atual.",
  "inbox.subject": "Assunto",
  "inbox.body": "Corpo",
  "inbox.close": "Fechar",
  "inbox.send": "Enviar para o inbox",
  "inbox.sent": "Mensagem enviada.",
  "inbox.cancelTitle": "Cancelar mensagem",
  "inbox.cancelConfirmPrefix": "Retratar",
  "inbox.cancelConfirmMid": "enviada para",
  "inbox.cancelConfirmSuffix": "Só o remetente pode cancelar, e só enquanto o estado for pending.",
  "inbox.back": "Voltar",
  "inbox.retract": "Retratar",
  "inbox.cancelled": "Mensagem retratada.",
  "inbox.mapHint": "Não há checkout local para este projeto nesta máquina. Informe o caminho e, se quiser, grave um .ai-memory.toml.",
  "inbox.mapDir": "Caminho local",
  "inbox.saveMap": "Salvar mapa e marker",
  "inbox.mapped": "Projeto mapeado.",
  "inbox.partial": "Atualização incompleta: algumas caixas não foram lidas ou estão truncadas.",
  "inbox.failed": "Falha ao consultar a caixa de entrada:",
  "inbox.unavailable": "Não foi possível consultar as caixas. Sem resposta não dá para afirmar que não há mensagens.",
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
.am-warn{margin:0 0 10px;padding:8px 10px;border:1px solid rgba(154,103,0,.45);border-radius:7px;background:rgba(210,153,34,.08);font-size:12px}
.am-warn-title{margin:0 0 4px;font-weight:600}
.am-warn-line{margin:0;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;word-break:break-word}

.am-tabs{display:flex;gap:2px;margin:0 0 16px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.28))}
.am-tab{appearance:none;background:transparent;border:0;border-bottom:2px solid transparent;color:var(--dsw-alias-label-secondary,#59636e);
  padding:7px 14px 8px;margin-bottom:-1px;cursor:pointer;font:12.5px/1.4 inherit;display:inline-flex;align-items:center;gap:7px}
.am-tab:hover{color:var(--dsw-alias-label-primary,#1f2328)}
.am-tab[aria-selected="true"]{color:var(--dsw-alias-label-primary,#1f2328);border-bottom-color:var(--dsw-alias-brand-primary,#3b6cf6);font-weight:600}
.am-badge{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 5px;border-radius:999px;
  background:var(--dsw-alias-brand-primary,#3b6cf6);color:#fff;font-size:10px;font-weight:650;line-height:1}
.am-context{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:0 0 14px;padding:8px 12px;
  border:1px dashed var(--dsw-alias-border-l1,rgba(128,128,128,.28));border-radius:8px;background:rgba(88,166,255,.05)}
.am-context code{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11.5px;color:var(--dsw-alias-interactive-bg-primary,#3b6cf6)}
.am-group{margin-bottom:12px}
.am-group-h{display:flex;align-items:baseline;gap:8px;margin:0 0 6px;font-size:12px;color:var(--dsw-alias-label-secondary,#59636e)}
.am-group-h strong{color:var(--dsw-alias-label-primary,#1f2328);font-weight:600;font-size:13px}
.am-group-h code{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px}
.am-msg{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:8px 12px;margin-bottom:6px;
  border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.28));border-radius:8px;background:var(--dsw-alias-bg-base,#fff)}
.am-msg-main{min-width:0;flex:1}
.am-msg-title{margin:0 0 4px;font-size:13px;font-weight:600}
.am-msg-meta{margin:0;font-size:11.5px;color:var(--dsw-alias-label-secondary,#59636e)}
.am-msg-meta .sep{margin:0 6px;opacity:.45}
.am-pill{display:inline-flex;align-items:center;height:18px;padding:0 7px;margin-left:6px;border-radius:999px;
  border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.28));font-size:10.5px;color:var(--dsw-alias-label-secondary,#59636e);vertical-align:1px}
.am-msg-actions{display:flex;gap:6px;flex-wrap:wrap;flex:none;justify-content:flex-end;align-items:center}
.am-btn.danger{color:var(--dsw-alias-state-error-primary,#c11);border-color:rgba(193,17,17,.35)}
.am-map-table{width:100%;border-collapse:collapse;font-size:12px}
.am-map-table th,.am-map-table td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.28));vertical-align:middle}
.am-map-table th{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary,#59636e)}
.am-map-table code{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px}
.am-ta{width:100%;min-height:110px;resize:vertical;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.28));
  border-radius:7px;background:var(--dsw-alias-bg-base,#fff);color:inherit;padding:8px 9px;font:12.5px/1.5 inherit;outline:none}
.am-ta:focus{border-color:var(--dsw-alias-brand-primary,#3b6cf6)}
.am-overlay{position:fixed;inset:0;background:rgba(8,10,14,.55);display:flex;align-items:center;justify-content:center;z-index:40;padding:24px}
.am-modal{width:min(640px,94vw);max-height:90vh;overflow:auto;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1,#f6f7f8));
  border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.28));border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.25);padding:16px 18px 18px}
.am-modal h2{margin:0 0 8px;font-size:15px}
.am-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}
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


// ── new-session draft (plugin-owned; not a public DSH API) ─────────────────
// skills-deck uses storeOf(sid).incomingDraft + inputActions.setDraft. We
// keep our own map so we do not depend on that plugin being installed.
const incomingDrafts = new Map();

function mountDraft(sid, text) {
  if (sid && text) incomingDrafts.set(String(sid), text);
}

function consumeDraft(sid) {
  const key = String(sid || "");
  const text = incomingDrafts.get(key);
  if (text) incomingDrafts.delete(key);
  return text || "";
}

function DraftApplier(props) {
  const consumed = React.useRef(null);
  React.useEffect(() => {
    const sid = props && props.sessionId;
    const setDraft = props && props.inputActions && props.inputActions.setDraft;
    if (!sid || typeof setDraft !== "function") return;
    if (consumed.current === sid) return;
    const text = consumeDraft(sid);
    if (!text) return;
    consumed.current = sid;
    setDraft(text.endsWith("\n") ? text : text + "\n");
  }, [props && props.sessionId, props && props.inputActions]);
  return null;
}

function currentSessionCwd(ctx) {
  try {
    const sessions = ctx.get && ctx.get("sessions");
    const snap = sessions && sessions.list && typeof sessions.list.getSnapshot === "function" && sessions.list.getSnapshot();
    const currentId = (snap && (snap.currentId || snap.activeId || snap.selectedId)) || "";
    if (currentId && snap.byId && snap.byId[currentId] && snap.byId[currentId].cwd) return snap.byId[currentId].cwd;
    if (snap && snap.cwd) return snap.cwd;
  } catch (error) { /* host surface varies */ }
  return "";
}

function inheritPreset(ctx) {
  try {
    const sessions = ctx.get && ctx.get("sessions");
    const snap = sessions && sessions.list && typeof sessions.list.getSnapshot === "function" && sessions.list.getSnapshot();
    const currentId = snap && (snap.currentId || snap.activeId || snap.selectedId);
    const row = currentId && snap.byId ? snap.byId[currentId] : null;
    if (!row) return "";
    if (row.projectionValues && typeof row.projectionValues.agentPreset === "string") return row.projectionValues.agentPreset;
    if (row.header && typeof row.header.agentPreset === "string") return row.header.agentPreset;
    if (typeof row.agentPreset === "string") return row.agentPreset;
  } catch (error) { /* optional */ }
  return "";
}

function buildCreateOpts(workspaceId, cwd, preset) {
  const opts = workspaceId ? { workspaceId } : { cwd };
  if (preset) opts.agentPreset = preset;
  return opts;
}

async function resolveWorkspaceId(ctx, cwd) {
  try {
    const workspaces = ctx.get && ctx.get("workspaces");
    if (!workspaces || !cwd) return null;
    const snap = workspaces.list && (typeof workspaces.list.getSnapshot === "function" ? workspaces.list.getSnapshot() : null);
    const items = [];
    if (snap) {
      const rows = Array.isArray(snap) ? snap : Object.values(snap.byId || snap.workspaces || snap.items || {});
      for (const row of rows) if (row && typeof row === "object") items.push(row);
    }
    // Exact, case-sensitive match only: /repos/App and /repos/app are distinct
    // checkouts on case-sensitive filesystems. No match returns null, and the
    // caller then opens by cwd.
    const want = String(cwd).replace(/\\/g, "/").replace(/\/+$/, "");
    for (const row of items) {
      const rowCwd = String(row.cwd || row.path || row.workingDirectory || "").replace(/\\/g, "/").replace(/\/+$/, "");
      if (rowCwd && rowCwd === want) return row.workspaceId || row.id || row.workspace_id || null;
    }
  } catch (error) { /* optional */ }
  return null;
}

async function createAndPrefill(ctx, { cwd, text, preset }) {
  const sessions = ctx.get && ctx.get("sessions");
  if (!sessions || typeof sessions.create !== "function") throw new Error("sessions.create is not available on this host");
  const workspaceId = await resolveWorkspaceId(ctx, cwd);
  const inherited = preset || inheritPreset(ctx) || "";
  const attempt = async (opts) => {
    const sid = await Promise.resolve(sessions.create(opts));
    if (sid) mountDraft(sid, text);
    return sid;
  };
  let sid;
  try {
    sid = await attempt(buildCreateOpts(workspaceId, cwd, inherited));
  } catch (error) {
    const msg = String((error && error.message) || error || "");
    if (workspaceId && /workspaceId|workspace/i.test(msg)) {
      sid = await attempt(buildCreateOpts(null, cwd, inherited));
    } else if (inherited && /agentPreset|preset/i.test(msg)) {
      const keys = ["presetId", "agentPresetId", "preset"];
      let last = error;
      for (const key of keys) {
        try {
          const opts = workspaceId ? { workspaceId, [key]: inherited } : { cwd, [key]: inherited };
          sid = await attempt(opts);
          last = null;
          break;
        } catch (inner) {
          last = inner;
        }
      }
      if (last) sid = await attempt(workspaceId ? { workspaceId } : { cwd });
    } else {
      throw error;
    }
  }
  const ui = (ctx.get && (ctx.get("uiWorkspace") || ctx.uiWorkspace)) || null;
  if (ui && typeof ui.openSession === "function") await ui.openSession(sid);
  else if (typeof sessions.open === "function") await sessions.open(sid);
  return sid;
}

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

  const host = {
    currentCwd: () => currentSessionCwd(ctx),
    openSession: (opts) => createAndPrefill(ctx, opts),
  };

  // Apply a prefilled composer draft once the new session's input mounts.
  ctx.effect(() => ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
    name: "conversation.input.dock",
    id: "dsh-plugin-ai-memory",
    order: 10,
  }, DraftApplier)), "ai-memory: draft dock");

  // The page in the layout's keyed `main` slot (chunk loads on first open).
  ctx.effect(() => ctx.slots.inject("main", () => ctx.slots.register({
    name: "main",
    key: PANEL_ID,
    locale: NS,
    inject: () => ({ api, t, host }),
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
