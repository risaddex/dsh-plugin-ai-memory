window.__ModuleLoader__.load({ id: "dsh-plugin-ai-memory", chunk: "client.page.js", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
/**
 * dsh-plugin-ai-memory — browser half, page chunk.
 *
 * Loaded on demand by the entry (`client/client.js` ->
 * `require.async("./client.page.js")` behind React.lazy). Holds the panel page
 * and the small presentational helpers it uses; the entry keeps the rail glyph,
 * the dictionaries, the styles and the plugin wiring.
 */
const React = require("react");
const h = React.createElement;

// ── small presentational helpers ───────────────────────────────────────────
function Chip({ state, children }) {
  const cls = state === true ? "ok" : state === false ? "bad" : state === "warn" ? "warn" : "";
  return h("span", { className: "am-chip" }, [h("span", { key: "d", className: `am-dot ${cls}` }), children]);
}

function Field({ id, label, hint, children }) {
  return h("div", { className: "am-row" }, [
    h("label", { key: "l", htmlFor: id }, label),
    children,
    hint ? h("p", { key: "h", className: "am-hint" }, hint) : null,
  ]);
}

const timeOf = (at) => (at ? new Date(at).toLocaleTimeString() : "");

// ── the panel page ─────────────────────────────────────────────────────────
function MemoryPanel(props) {
  const { api, t, host } = props;
  const [status, setStatus] = React.useState(null);
  const [form, setForm] = React.useState(null);
  const [busy, setBusy] = React.useState("");
  const [flash, setFlash] = React.useState(null);
  const [marker, setMarker] = React.useState({ dir: "", overwrite: false });
  const [workstreams, setWorkstreams] = React.useState(null);
  const [consolidate, setConsolidate] = React.useState({ sessionId: "" });
  const [tab, setTab] = React.useState("inbox");
  const [inbox, setInbox] = React.useState(null);
  const [inboxBusy, setInboxBusy] = React.useState(false);
  const [composer, setComposer] = React.useState(null);
  const [cancelRow, setCancelRow] = React.useState(null);
  const [mapRow, setMapRow] = React.useState(null);
  const [mapDir, setMapDir] = React.useState("");

  const load = React.useCallback(async () => {
    try {
      const value = await api("status", {});
      setStatus(value);
      setForm((current) => current ?? {
        serverUrl: value.config.serverUrl,
        token: "",
        tokenRef: value.config.tokenRef || "",
        dataDir: value.config.dataDir,
        projectStrategy: value.config.projectStrategy,
        captureMode: value.config.captureMode,
        enabled: value.config.enabled,
        capture: value.config.capture,
        mcp: value.config.mcp,
        reuseUpstreamHooks: value.config.reuseUpstreamHooks,
        reportUsage: value.config.reportUsage,
        messagingGuidance: value.config.messagingGuidance,
        mcpServerName: value.config.mcpServerName,
        defaultAgentPreset: value.config.defaultAgentPreset || "",
        repoRootsText: Array.isArray(value.config.repoRoots) ? value.config.repoRoots.join("\n") : "",
      });
    } catch (error) {
      setFlash({ ok: false, text: String(error.message || error) });
    }
  }, [api]);

  React.useEffect(() => { void load(); }, [load]);

  const currentCwd = () => {
    try {
      return (props.host && typeof props.host.currentCwd === "function" && props.host.currentCwd()) || "";
    } catch {
      return "";
    }
  };

  const loadInbox = React.useCallback(async () => {
    setInboxBusy(true);
    try {
      const value = await api("listInbox", { cwd: currentCwd() });
      setInbox(value);
    } catch (error) {
      const message = String(error.message || error);
      setFlash({ ok: false, text: message });
      // Host RPC failed: do not keep the previous list as if it were current.
      setInbox({ failed: message, messages: [], pending: 0, errors: [], scopes: [], current: {}, map: [] });
    } finally {
      setInboxBusy(false);
    }
  }, [api]);

  React.useEffect(() => { void loadInbox(); }, [loadInbox]);
  React.useEffect(() => {
    const timer = setInterval(() => { void loadInbox(); }, 20000);
    return () => clearInterval(timer);
  }, [loadInbox]);

  const formatTime = (value) => {
    if (!value) return "";
    try {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      return new Intl.DateTimeFormat("pt-BR", {
        timeZone: "America/Sao_Paulo",
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(date) + " (BRT)";
    } catch {
      return String(value);
    }
  };

  const openAgent = async (row) => {
    if (!row || !row.mappedPath) return;
    if (!props.host || typeof props.host.openSession !== "function") {
      setFlash({ ok: false, text: t("inbox.noSessions") });
      return;
    }
    try {
      const preset = (form && form.defaultAgentPreset) || (status && status.config && status.config.defaultAgentPreset) || "";
      await props.host.openSession({
        cwd: row.mappedPath,
        text: row.openPrompt,
        preset,
      });
      setFlash({ ok: true, text: t("inbox.opened") });
    } catch (error) {
      setFlash({ ok: false, text: String(error.message || error) });
    }
  };
  // Cheap liveness: the rail can stay open for hours.
  React.useEffect(() => {
    const timer = setInterval(() => { void load(); }, 15000);
    return () => clearInterval(timer);
  }, [load]);

/**
 * Recognise the panel's status document.
 *
 * Endpoints answer different shapes: `saveSettings` returns
 * `{report, status: <document>}` while `testEvent` returns
 * `{ok, status: 202, body}` — the HTTP code, not a document. Adopting the
 * number as state replaced every field with a number and the next render threw,
 * taking the whole page down. Only a real document is adopted.
 */
function isStatusDocument(value) {
  return Boolean(value) && typeof value === "object" && Boolean(value.config) && Boolean(value.hooks) && Boolean(value.mcp);
}

  const run = async (name, endpoint, payload) => {
    setBusy(name);
    setFlash(null);
    try {
      const value = await api(endpoint, payload ?? {});
      if (isStatusDocument(value)) setStatus(value);
      else if (isStatusDocument(value && value.status)) setStatus(value.status);
      else await load();
      return value;
    } catch (error) {
      setFlash({ ok: false, text: String(error.message || error) });
      return null;
    } finally {
      setBusy("");
    }
  };

  if (!isStatusDocument(status) || !form) {
    return h("div", { className: "am-root" }, h("p", { className: "am-empty" }, flash ? flash.text : t("status.checking")));
  }

  const set = (key) => (event) => {
    const target = event.target;
    setForm({ ...form, [key]: target.type === "checkbox" ? target.checked : target.value });
  };

  const save = async () => {
    const patch = {
      enabled: form.enabled,
      capture: form.capture,
      mcp: form.mcp,
      captureMode: form.captureMode,
      projectStrategy: form.projectStrategy,
      reuseUpstreamHooks: form.reuseUpstreamHooks,
      reportUsage: form.reportUsage,
      messagingGuidance: form.messagingGuidance,
      mcpServerName: form.mcpServerName,
      serverUrl: form.serverUrl,
      tokenRef: form.tokenRef,
      dataDir: form.dataDir,
    };
    // An empty box means "leave the stored token alone"; `hasToken` drives the hint.
    if (form.token !== "") patch.token = form.token;
    const value = await run("save", "saveSettings", patch);
    if (value) {
      setForm({ ...form, token: "" });
      setFlash({ ok: true, text: t("btn.save") + " ✓" });
    }
  };

  const testConnection = async () => {
    const value = await run("test", "check", {
      serverUrl: form.serverUrl,
      token: form.token || undefined,
      sendTestEvent: false,
    });
    if (value) {
      const health = value.health || {};
      setFlash({
        ok: Boolean(health.ok),
        text: health.ok
          ? `${t("status.online")} — HTTP ${health.status}`
          : `${t("status.offline")} — ${health.error || health.status || "?"}`,
      });
    }
  };

  const testEvent = async () => {
    const value = await run("event", "testEvent", { prompt: "dsh-plugin-ai-memory: connection test" });
    if (value) {
      setFlash({
        ok: Boolean(value.ok),
        text: value.ok
          ? `POST /hook → HTTP ${value.status} ${value.body ? `(${value.body})` : ""}`
          : `POST /hook failed — ${value.error || value.status}`,
      });
      void load();
    }
  };

  const health = (status && status.health) || {};
  const chips = [
    h(Chip, { key: "s", state: health.ok ? true : (health.status ? false : "warn") },
      health.ok ? t("status.online") : `${t("status.offline")}${health.error ? ` (${health.error})` : ""}`),
    h(Chip, { key: "c", state: Boolean(status.hooks && status.hooks.installed) },
      `${t("status.capture")}: ${status.config.capture ? t("status.captureOn") : t("status.captureOff")}`),
    h(Chip, { key: "m", state: Boolean(status.mcp && status.mcp.managed) },
      `${t("status.mcp")}: ${status.mcp && status.mcp.managed ? t("status.mcpOn") : t("status.mcpOff")}`),
  ];


  const grouped = () => {
    const groups = [];
    const index = new Map();
    for (const row of (inbox && inbox.messages) || []) {
      const ws = row.to_workspace || "?";
      if (!index.has(ws)) {
        const g = { workspace: ws, projects: new Map() };
        index.set(ws, g);
        groups.push(g);
      }
      const g = index.get(ws);
      const pr = row.to_project || "?";
      if (!g.projects.has(pr)) g.projects.set(pr, []);
      g.projects.get(pr).push(row);
    }
    return groups;
  };

  const renderInbox = () => {
    const current = (inbox && inbox.current) || {};
    const currentLabel = current.workspace && current.project
      ? `${current.workspace} / ${current.project}`
      : t("inbox.noMarker");
    const groups = grouped();
    const errors = (inbox && inbox.errors) || [];
    const problemLines = inbox && inbox.failed
      ? [t("inbox.failed") + " " + inbox.failed]
      : errors.map((e) => `${e.box || "inbox"} ${e.workspace || "?"}/${e.project || "?"}: ${e.error}`);
    const inboxProblems = problemLines.length > 0;
    return h(React.Fragment, { key: "inbox-pane" }, [
      h("div", { key: "ctx", className: "am-context" }, [
        h("div", { key: "l" }, [
          t("inbox.currentSession"),
          " ",
          h("code", { key: "c" }, currentLabel),
        ]),
        h("button", { key: "n", className: "am-btn primary", type: "button", onClick: () => setComposer({
          from_workspace: current.workspace || "",
          from_project: current.project || "",
          to_workspace: current.workspace || "",
          to_project: "",
          subject: "",
          body: "",
          nature: "reported",
          evidence: "",
        }) }, t("inbox.newHandoff")),
      ]),
      h("section", { key: "list", className: "am-card" }, [
        h("h3", { key: "h" }, `${t("inbox.pending")} · ${((inbox && inbox.pending) || 0)}`),
        inboxBusy && !inbox ? h("p", { key: "l", className: "am-empty" }, t("inbox.loading")) : null,
        inboxProblems ? h("div", { key: "w", className: "am-warn" }, [
          h("p", { key: "t", className: "am-warn-title" }, t("inbox.partial")),
          ...problemLines.map((line, index) => h("p", { key: `p-${index}`, className: "am-warn-line" }, line)),
        ]) : null,
        inbox && !inboxProblems && groups.length === 0 ? h("p", { key: "e", className: "am-empty" }, t("inbox.empty")) : null,
        inbox && inboxProblems && groups.length === 0 ? h("p", { key: "u", className: "am-empty" }, t("inbox.unavailable")) : null,
        ...groups.map((group) => h("div", { key: `g-${group.workspace}`, className: "am-group" }, [
          h("div", { key: "gh", className: "am-group-h" }, [
            "workspace ",
            h("strong", { key: "s" }, group.workspace),
            " · " + String(Array.from(group.projects.values()).reduce((n, a) => n + a.length, 0)),
          ]),
          ...Array.from(group.projects.entries()).flatMap(([project, rows]) => [
            h("div", { key: `ph-${group.workspace}-${project}`, className: "am-group-h" }, ["projeto ", h("code", { key: "c" }, project)]),
            ...rows.map((row) => h("div", { key: row.id, className: "am-msg" + (row.mappedPath ? "" : " unmapped") }, [
              h("div", { key: "m", className: "am-msg-main" }, [
                h("p", { key: "t", className: "am-msg-title" }, row.subject || t("inbox.noSubject")),
                h("p", { key: "meta", className: "am-msg-meta" }, [
                  t("inbox.from"),
                  " ",
                  h("code", { key: "f" }, `${row.from_workspace || "?"}/${row.from_project || "?"}`),
                  h("span", { key: "s", className: "sep" }, "·"),
                  h("span", { key: "tm" }, formatTime(row.created_at)),
                  row.from_workspace && row.to_workspace === row.from_workspace && row.to_project === row.from_project
                    ? h("span", { key: "p", className: "am-pill" }, t("inbox.sameProject"))
                    : null,
                ]),
              ]),
              h("div", { key: "a", className: "am-msg-actions" }, [
                h("button", {
                  key: "open", className: "am-btn primary", type: "button",
                  disabled: !row.mappedPath, title: row.mappedPath ? "" : t("inbox.noCheckout"),
                  onClick: () => openAgent(row),
                }, t("inbox.openAgent")),
                row.mappedPath ? null : h("button", {
                  key: "map", className: "am-btn", type: "button",
                  onClick: () => { setMapRow(row); setMapDir(""); },
                }, t("inbox.mapProject")),
                row.canCancel ? h("button", {
                  key: "c", className: "am-btn danger", type: "button",
                  onClick: () => setCancelRow(row),
                }, t("inbox.cancel")) : null,
              ]),
            ])),
          ]),
        ])),
      ]),
      h("section", { key: "map", className: "am-card" }, [
        h("h3", { key: "h" }, t("inbox.mapTitle")),
        h("table", { key: "t", className: "am-map-table" }, [
          h("thead", { key: "h" }, h("tr", null, [
            h("th", { key: "p" }, t("inbox.mapScope")),
            h("th", { key: "c" }, t("inbox.mapPath")),
          ])),
          h("tbody", { key: "b" }, ((inbox && inbox.map) || []).map((row) => h("tr", { key: row.key }, [
            h("td", { key: "p" }, [
              h("code", { key: "c" }, row.key),
              current.workspace && row.workspace === current.workspace && row.project === current.project
                ? h("span", { key: "n", className: "am-pill" }, t("inbox.currentPill"))
                : null,
            ]),
            h("td", { key: "c" }, row.path
              ? h("code", null, row.path)
              : h("span", { style: { color: "var(--dsw-alias-state-warn-primary,#d29922)" } }, t("inbox.noCheckout"))),
          ]))),
        ]),
      ]),
      composer ? renderComposer() : null,
      cancelRow ? renderCancel() : null,
      mapRow ? renderMapModal() : null,
    ]);
  };

  const modalShell = (title, children, actions) => h("div", { className: "am-overlay", onClick: (event) => {
    if (event.target === event.currentTarget) { setComposer(null); setCancelRow(null); setMapRow(null); }
  } }, h("div", { className: "am-modal", role: "dialog" }, [
    h("h2", { key: "t" }, title),
    ...children,
    h("div", { key: "a", className: "am-modal-actions" }, actions),
  ]));

  const renderComposer = () => {
    const set = (key) => (event) => setComposer({ ...composer, [key]: event.target.value });
    const scopes = Array.from(new Set(((inbox && inbox.scopes) || []).map((s) => s.workspace))).filter(Boolean);
    const projects = ((inbox && inbox.scopes) || []).filter((s) => s.workspace === composer.to_workspace).map((s) => s.project);
    return modalShell(t("inbox.newHandoff"), [
      h("p", { key: "hint", className: "am-hint" }, t("inbox.composerHint")),
      h("div", { key: "g", className: "am-grid" }, [
        h("div", { key: "fw", className: "am-row" }, [
          h("label", { key: "l" }, "from_workspace"),
          h("input", { key: "i", className: "am-in mono", value: composer.from_workspace, readOnly: true }),
          h("p", { key: "h", className: "am-hint" }, t("inbox.fromMarker")),
        ]),
        h("div", { key: "fp", className: "am-row" }, [
          h("label", { key: "l" }, "from_project"),
          h("input", { key: "i", className: "am-in mono", value: composer.from_project, readOnly: true }),
        ]),
        h("div", { key: "tw", className: "am-row" }, [
          h("label", { key: "l" }, "to_workspace"),
          h("select", { key: "s", className: "am-sel", value: composer.to_workspace,
            onChange: (event) => setComposer({ ...composer, to_workspace: event.target.value, to_project: "" }) },
            (scopes.length ? scopes : [composer.to_workspace]).filter(Boolean).map((w) => h("option", { key: w, value: w }, w))),
        ]),
        h("div", { key: "tp", className: "am-row" }, [
          h("label", { key: "l" }, "to_project"),
          h("select", { key: "s", className: "am-sel", value: composer.to_project, onChange: set("to_project") },
            ["", ...projects].map((pr) => h("option", { key: pr || "empty", value: pr }, pr || "—"))),
        ]),
      ]),
      h("div", { key: "s", className: "am-row" }, [
        h("label", { key: "l" }, t("inbox.subject")),
        h("input", { key: "i", className: "am-in", value: composer.subject, onChange: set("subject") }),
      ]),
      h("div", { key: "b", className: "am-row" }, [
        h("label", { key: "l" }, t("inbox.body")),
        h("textarea", { key: "t", className: "am-ta", value: composer.body, onChange: set("body") }),
      ]),
      h("div", { key: "n", className: "am-row", style: { maxWidth: 240 } }, [
        h("label", { key: "l" }, "nature"),
        h("select", { key: "s", className: "am-sel", value: composer.nature, onChange: set("nature") }, [
          h("option", { key: "r", value: "reported" }, "reported"),
          h("option", { key: "m", value: "measured" }, "measured"),
          h("option", { key: "i", value: "inferred" }, "inferred"),
        ]),
      ]),
      composer.nature === "measured" ? h("div", { key: "e", className: "am-row" }, [
        h("label", { key: "l" }, "evidence"),
        h("input", { key: "i", className: "am-in", value: composer.evidence, onChange: set("evidence") }),
      ]) : null,
    ], [
      h("button", { key: "c", className: "am-btn", type: "button", onClick: () => setComposer(null) }, t("inbox.close")),
      h("button", { key: "s", className: "am-btn primary", type: "button",
        disabled: busy !== "" || !composer.to_project || !projects.includes(composer.to_project),
        onClick: async () => {
        if (!composer.to_project || !projects.includes(composer.to_project)) return;
        const value = await run("send", "sendMessage", composer);
        if (value) {
          setFlash({ ok: true, text: t("inbox.sent") });
          setComposer(null);
          await loadInbox();
        }
      } }, t("inbox.send")),
    ]);
  };

  const renderCancel = () => modalShell(t("inbox.cancelTitle"), [
    h("p", { key: "h", className: "am-hint" }, t("inbox.cancelConfirmPrefix") + " “" + (cancelRow.subject || t("inbox.noSubject")) + "” " + t("inbox.cancelConfirmMid") + " " + cancelRow.to_workspace + "/" + cancelRow.to_project + "? " + t("inbox.cancelConfirmSuffix")),
  ], [
    h("button", { key: "b", className: "am-btn", type: "button", onClick: () => setCancelRow(null) }, t("inbox.back")),
    h("button", { key: "c", className: "am-btn danger", type: "button", disabled: busy !== "", onClick: async () => {
      const value = await run("cancel", "cancelMessage", {
        message_id: cancelRow.id,
        workspace: cancelRow.from_workspace,
        project: cancelRow.from_project,
        cwd: currentCwd(),
      });
      if (value) {
        setFlash({ ok: true, text: t("inbox.cancelled") });
        setCancelRow(null);
        await loadInbox();
      }
    } }, t("inbox.retract")),
  ]);

  const renderMapModal = () => modalShell(t("inbox.mapProject"), [
    h("p", { key: "h", className: "am-hint" }, t("inbox.mapHint")),
    h("div", { key: "p", className: "am-row" }, [
      h("label", { key: "l" }, t("inbox.mapScope")),
      h("input", { key: "i", className: "am-in mono", readOnly: true, value: `${mapRow.to_workspace}/${mapRow.to_project}` }),
    ]),
    h("div", { key: "d", className: "am-row" }, [
      h("label", { key: "l" }, t("inbox.mapDir")),
      h("input", { key: "i", className: "am-in mono", value: mapDir, placeholder: "/caminho/do/checkout", onChange: (e) => setMapDir(e.target.value) }),
    ]),
  ], [
    h("button", { key: "c", className: "am-btn", type: "button", onClick: () => setMapRow(null) }, t("inbox.close")),
    h("button", { key: "s", className: "am-btn primary", type: "button", disabled: busy !== "" || !mapDir.trim(), onClick: async () => {
      const value = await run("map", "mapProject", {
        workspace: mapRow.to_workspace,
        project: mapRow.to_project,
        dir: mapDir.trim(),
        writeMarker: true,
      });
      if (value) {
        setFlash({ ok: true, text: t("inbox.mapped") });
        setMapRow(null);
        await loadInbox();
      }
    } }, t("inbox.saveMap")),
  ]);

  return h("div", { className: "am-root" }, [
    h("div", { key: "head", className: "am-head" }, [
      h("h2", { key: "t", className: "am-title" }, t("panel.title")),
      h("span", { key: "v", className: "am-empty" }, `v${status.version}`),
    ]),
    h("p", { key: "sub", className: "am-sub" }, t("panel.subtitle")),
    h("div", { key: "chips", className: "am-chips", hidden: tab === "inbox" }, chips),

    h("div", { key: "tabs", className: "am-tabs", role: "tablist" }, [
      h("button", {
        key: "c", className: "am-tab", role: "tab", type: "button",
        "aria-selected": tab === "config" ? "true" : "false",
        onClick: () => setTab("config"),
      }, t("tab.config")),
      h("button", {
        key: "i", className: "am-tab", role: "tab", type: "button",
        "aria-selected": tab === "inbox" ? "true" : "false",
        onClick: () => setTab("inbox"),
      }, [
        t("tab.inbox"),
        h("span", { key: "b", className: "am-badge" }, String((inbox && inbox.pending) || 0)),
      ]),
    ]),

    tab === "inbox" ? renderInbox() : null,

    // Server / workstream
    h("section", { key: "server", className: "am-card", hidden: tab !== "config" }, [
      h("h3", { key: "h" }, t("section.server")),
      h("div", { className: "am-grid" }, [
        h(Field, { key: "url", id: "am-server", label: t("field.serverUrl"), hint: t("field.serverUrl.hint") },
          h("input", {
            id: "am-server", className: "am-in mono", value: form.serverUrl,
            placeholder: "http://127.0.0.1:49374", onChange: set("serverUrl"),
          })),
        h(Field, { key: "tok", id: "am-token", label: t("field.token"),
          hint: status.config.hasToken ? `${t("field.token.hint")} (stored: ${status.config.tokenMasked})` : t("field.token.hint") },
          h("input", {
            id: "am-token", className: "am-in mono", type: "password", value: form.token,
            placeholder: status.config.hasToken ? "•••••••• (unchanged)" : "optional", onChange: set("token"),
            disabled: Boolean(form.tokenRef),
          })),
        h(Field, { key: "tokref", id: "am-tokenref", label: t("field.tokenRef"), hint: t("field.tokenRef.hint") },
          h("input", {
            id: "am-tokenref", className: "am-in mono", value: form.tokenRef,
            placeholder: "AI_MEMORY_TOKEN", onChange: set("tokenRef"),
          })),
        h(Field, { key: "dir", id: "am-datadir", label: t("field.dataDir"), hint: t("field.dataDir.hint") },
          h("input", {
            id: "am-datadir", className: "am-in mono", value: form.dataDir,
            placeholder: status.config.dataDir, onChange: set("dataDir"),
          })),
        h(Field, { key: "st", id: "am-strategy", label: t("field.strategy"), hint: t("field.strategy.hint") },
          h("select", { id: "am-strategy", className: "am-sel", value: form.projectStrategy, onChange: set("projectStrategy") }, [
            h("option", { key: "", value: "" }, t("value.strategy.default")),
            h("option", { key: "b", value: "basename" }, t("value.strategy.basename")),
            h("option", { key: "r", value: "repo-root" }, t("value.strategy.reporoot")),
          ])),
      ]),
      h("div", { className: "am-actions" }, [
        h("button", { key: "save", className: "am-btn primary", disabled: busy !== "", onClick: save },
          busy === "save" ? t("btn.saving") : t("btn.save")),
        h("button", { key: "test", className: "am-btn", disabled: busy !== "", onClick: testConnection },
          t("btn.test")),
        h("button", { key: "ev", className: "am-btn", disabled: busy !== "", onClick: testEvent },
          t("btn.testEvent")),
        h("button", { key: "ws", className: "am-btn", disabled: busy !== "", onClick: async () => {
          const value = await run("ws", "listWorkstreams", {});
          if (value) setWorkstreams(value);
        } }, t("btn.workstreams")),
      ]),
      workstreams ? h("div", { key: "wsv", className: "am-kv", style: { marginTop: 10 } },
        h("code", null, JSON.stringify(workstreams).slice(0, 1200))) : null,
    ]),

    // Capture
    h("section", { key: "capture", className: "am-card", hidden: tab !== "config" }, [
      h("h3", { key: "h" }, t("section.capture")),
      h("label", { key: "en", className: "am-check" }, [
        h("input", { key: "i", type: "checkbox", checked: Boolean(form.enabled), onChange: set("enabled") }),
        t("label.enabled"),
      ]),
      h("label", { key: "cap", className: "am-check" }, [
        h("input", { key: "i", type: "checkbox", checked: Boolean(form.capture), onChange: set("capture") }),
        t("label.capture"),
      ]),
      h("label", { key: "reuse", className: "am-check" }, [
        h("input", { key: "i", type: "checkbox", checked: Boolean(form.reuseUpstreamHooks), onChange: set("reuseUpstreamHooks") }),
        t("label.reuse"),
      ]),
      h("label", { key: "usage", className: "am-check" }, [
        h("input", { key: "i", type: "checkbox", checked: Boolean(form.reportUsage), onChange: set("reportUsage") }),
        t("label.usage"),
      ]),
      h(Field, { key: "mode", id: "am-mode", label: t("field.captureMode"), hint: t("field.captureMode.hint") },
        h("select", { id: "am-mode", className: "am-sel", value: form.captureMode, onChange: set("captureMode") }, [
          h("option", { key: "s", value: "scripts" }, "scripts (hooks/dsh)"),
          h("option", { key: "n", value: "native" }, "native (ai-memory hook)"),
        ])),
      h("div", { key: "kv", className: "am-kv" }, [
        h("span", { key: "k1" }, t("hint.staged")), h("code", { key: "v1" }, status.hooks.dir),
        h("span", { key: "k2" }, t("hint.binary")),
        h("code", { key: "v2" }, status.aiMemory && status.aiMemory.found
          ? `${status.aiMemory.path} ${status.aiMemory.version || ""}`
          : t("hint.binary.missing")),
      ]),
      h("div", { key: "actions", className: "am-actions" }, [
        h("button", { key: "i", className: "am-btn", disabled: busy !== "", onClick: () => run("hooks", "installHooks", {}) },
          t("btn.installHooks")),
        h("button", { key: "r", className: "am-btn", disabled: busy !== "", onClick: load }, t("btn.refresh")),
      ]),
    ]),

    // MCP
    h("section", { key: "mcp", className: "am-card", hidden: tab !== "config" }, [
      h("h3", { key: "h" }, t("section.mcp")),
      h("label", { key: "m", className: "am-check" }, [
        h("input", { key: "i", type: "checkbox", checked: Boolean(form.mcp), onChange: set("mcp") }),
        t("label.mcp"),
      ]),
      h("label", { key: "g", className: "am-check" }, [
        h("input", { key: "i", type: "checkbox", checked: Boolean(form.messagingGuidance), onChange: set("messagingGuidance") }),
        t("label.guidance"),
      ]),
      h(Field, { key: "name", id: "am-mcpname", label: "serverName", hint: "MCP tools appear as mcp__<serverName>__<tool>." },
        h("input", {
          id: "am-mcpname", className: "am-in mono", value: form.mcpServerName,
          placeholder: "ai_memory", onChange: set("mcpServerName"),
        })),
      h("div", { key: "kv", className: "am-kv" }, [
        h("span", { key: "k1" }, "endpoint"), h("code", { key: "v1" }, status.config.mcpUrl),
        h("span", { key: "k2" }, t("hint.patch")), h("code", { key: "v2" }, status.profile.patchPath || "—"),
      ]),
      h("p", { key: "n", className: "am-hint", style: { marginTop: 8 } }, t("note.reload")),
      h("div", { key: "actions", className: "am-actions" }, [
        h("button", { key: "a", className: "am-btn", disabled: busy !== "", onClick: () => run("mcp", "applyMcp", {}) },
          t("btn.applyMcp")),
        h("button", { key: "r", className: "am-btn", disabled: busy !== "", onClick: () => run("rm", "removeMcp", {}) },
          t("btn.removeMcp")),
      ]),
    ]),

    // Consolidation
    h("section", { key: "consolidate", className: "am-card", hidden: tab !== "config" }, [
      h("h3", { key: "h" }, t("section.consolidate")),
      h(Field, { key: "sid", id: "am-sid", label: t("field.sessionId"), hint: t("field.sessionId.hint") },
        h("input", {
          id: "am-sid", className: "am-in mono", value: consolidate.sessionId,
          placeholder: "session-…", onChange: (e) => setConsolidate({ sessionId: e.target.value }),
        })),
      h("p", { key: "n", className: "am-hint" }, t("hint.consolidate")),
      h("div", { key: "actions", className: "am-actions" }, [
        h("button", { key: "go", className: "am-btn primary", disabled: busy !== "", onClick: async () => {
          const value = await run("consolidate", "consolidate", { sessionId: consolidate.sessionId });
          if (value) setFlash({ ok: true, text: `${t("consolidate.ok")} — ${JSON.stringify(value).slice(0, 300)}` });
        } }, t("btn.consolidate")),
        h("button", { key: "dry", className: "am-btn", disabled: busy !== "", onClick: async () => {
          const value = await run("dry", "consolidate", { dryRun: true, sessionId: consolidate.sessionId });
          if (value) setFlash({ ok: true, text: JSON.stringify(value).slice(0, 400) });
        } }, t("btn.dryRun")),
      ]),
    ]),

    // Project marker
    h("section", { key: "marker", className: "am-card", hidden: tab !== "config" }, [
      h("h3", { key: "h" }, t("section.marker")),
      h("div", { className: "am-grid" }, [
        h(Field, { key: "d", id: "am-mdir", label: t("field.marker.dir"), hint: t("field.marker.hint") },
          h("input", {
            id: "am-mdir", className: "am-in mono", value: marker.dir,
            placeholder: "/path/to/repo", onChange: (e) => setMarker({ ...marker, dir: e.target.value }),
          })),
        h(Field, { key: "w", id: "am-mws", label: t("field.marker.workspace") },
          h("input", {
            id: "am-mws", className: "am-in mono", value: status.config.workspace,
            placeholder: "guedder", onChange: set("workspace"),
          })),
        h(Field, { key: "p", id: "am-mpr", label: t("field.marker.project") },
          h("input", {
            id: "am-mpr", className: "am-in mono", value: status.config.project,
            placeholder: "guedder-api", onChange: set("project"),
          })),
      ]),
      h("label", { key: "ow", className: "am-check" }, [
        h("input", { key: "i", type: "checkbox", checked: marker.overwrite,
          onChange: (e) => setMarker({ ...marker, overwrite: e.target.checked }) }),
        t("label.overwrite"),
      ]),
      h("div", { key: "actions", className: "am-actions" }, [
        h("button", { key: "w", className: "am-btn", disabled: busy !== "" || marker.dir === "", onClick: async () => {
          const value = await run("marker", "writeMarker", {
            dir: marker.dir,
            overwrite: marker.overwrite,
            workspace: form.workspace,
            project: form.project,
            projectStrategy: form.projectStrategy,
          });
          if (value) {
            setFlash(value.written
              ? { ok: true, text: `wrote ${value.path}` }
              : { ok: false, text: value.error || "not written" });
          }
        } }, t("btn.marker")),
      ]),
    ]),

    // Activity
    h("section", { key: "activity", className: "am-card", hidden: tab !== "config" }, [
      h("h3", { key: "h" }, t("section.activity")),
      (status.recentEvents || []).length === 0
        ? h("p", { key: "e", className: "am-empty" }, t("event.none"))
        : h("div", { key: "l", className: "am-list" }, (status.recentEvents || []).slice().reverse().map((event, index) =>
          h("div", { key: `r${index}`, className: "am-list-row" }, [
            h("span", { key: "t" }, timeOf(event.at)),
            h("span", { key: "e" }, event.event),
            h("span", { key: "s", style: { color: event.ok ? "var(--dsw-alias-state-success-primary,#1a7f37)" : "var(--dsw-alias-state-error-primary,#c11)" } },
              event.ok ? "ok" : (event.error || "failed")),
          ]))),
    ]),

    flash ? h("p", { key: "flash", className: `am-flash ${flash.ok ? "ok" : "bad"}` }, flash.text) : null,
  ]);
}

exports.MemoryPanel = MemoryPanel;
return module.exports; } });
