/**
 * dsh-prompt-library — browser half.
 *
 * Three surfaces, all riding official extension points:
 *
 * - `conversation.input.left`  — a compact trigger button in the composer tool row;
 * - `conversation.input.overlay` — the picker popup above the composer, which
 *   writes the chosen text back through the session's standard `inputActions`
 *   prop (`captureInsertion()` + `insertText()`), the supported composer-write
 *   path — no DOM poking;
 * - `sidebar.panellist` + `main` — a full library page for browsing, previewing,
 *   copying and configuring sources.
 *
 * Failure policy: registration problems are logged, never thrown — the web
 * shell fails its whole boot when a plugin `apply` throws, and an external
 * plugin must not take the GUI down.
 */
window.__ModuleLoader__.load({
  id: "dsh-prompt-library",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;
    const {
      useCallback,
      useEffect,
      useMemo,
      useRef,
      useState,
      useSyncExternalStore,
    } = React;

    /* ---------------------------------------------------------------- */
    /* Constants                                                         */
    /* ---------------------------------------------------------------- */

    /** Route paths mirrored from the host half. Document-relative on purpose. */
    const API = {
      list: "api/dsh-prompt-library/list",
      health: "api/dsh-prompt-library/health",
    };

    /** The center-column panel id shared by the sidebar row and the page. */
    const PANEL_ID = "prompt-library";

    /** Sidebar row order (after the shipped panels). */
    const PANEL_ORDER = 35;

    const SETTINGS_KEY = "dsh-prompt-library/settings/v1";

    /** Freshness window before a popup open re-fetches the catalog. */
    const CACHE_MS = 15000;

    const DEFAULT_SETTINGS = {
      /** Drop the leading `<!-- … -->` maintenance comment before inserting. */
      stripHeadComment: true,
      /** Append the align fragment (`01-align.md`) when it is not already there. */
      appendAlign: true,
      /** Row clicks toggle a selection instead of inserting immediately. */
      multi: false,
      /** Extra directories the user added, sent to the host on every list call. */
      extraDirs: [],
    };

    /* ---------------------------------------------------------------- */
    /* Small stores                                                      */
    /* ---------------------------------------------------------------- */

    /** A minimal external store for `useSyncExternalStore`. */
    function createStore(initial) {
      let state = initial;
      const listeners = new Set();
      return {
        getSnapshot: () => state,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        set: (updater) => {
          const next = typeof updater === "function" ? updater(state) : updater;
          if (Object.is(next, state)) return;
          state = next;
          for (const listener of Array.from(listeners)) {
            try {
              listener();
            } catch {
              /* one broken subscriber must not break the others */
            }
          }
        },
      };
    }

    /**
     * Subscribe a component to one of the stores above. The third argument
     * keeps the hook usable under a server renderer as well as the browser.
     */
    function useStore(store) {
      return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    }

    /** The scanned catalog. */
    const libraryStore = createStore({
      status: "idle",
      items: [],
      sources: [],
      suffixId: null,
      error: null,
      at: 0,
    });

    /** Whether the composer picker is open. */
    const pickerStore = createStore(false);

    /** A transient line rendered in the picker footer. */
    const noticeStore = createStore({ text: "", tone: "info", seq: 0 });

    function notify(text, tone = "info") {
      noticeStore.set((prev) => ({ text, tone, seq: prev.seq + 1 }));
    }

    /** Persisted preferences. */
    function readSettings() {
      try {
        const raw = window.localStorage?.getItem(SETTINGS_KEY);
        if (typeof raw === "string" && raw !== "") {
          const parsed = JSON.parse(raw);
          if (parsed !== null && typeof parsed === "object") {
            return { ...DEFAULT_SETTINGS, ...parsed };
          }
        }
      } catch {
        /* a corrupt or unavailable store falls back to defaults */
      }
      return { ...DEFAULT_SETTINGS };
    }

    const settingsStore = createStore(readSettings());

    function updateSettings(patch) {
      settingsStore.set((prev) => {
        const next = { ...prev, ...patch };
        try {
          window.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(next));
        } catch {
          /* persistence is best-effort */
        }
        return next;
      });
    }

    /* ---------------------------------------------------------------- */
    /* Host API                                                          */
    /* ---------------------------------------------------------------- */

    /** Fetch the catalog; the `dirs` query carries the user's extra directories. */
    async function loadLibrary(force = false) {
      const current = libraryStore.getSnapshot();
      if (!force && current.status === "loading") return;
      if (!force && current.status === "ready" && Date.now() - current.at < CACHE_MS) return;

      const settings = settingsStore.getSnapshot();
      const extra = Array.isArray(settings.extraDirs)
        ? settings.extraDirs.map((dir) => String(dir).trim()).filter(Boolean)
        : [];
      const query = extra.length === 0 ? "" : `?dirs=${encodeURIComponent(extra.join("\n"))}`;

      libraryStore.set((prev) => ({ ...prev, status: "loading", error: null }));
      try {
        const response = await fetch(`${API.list}${query}`, {
          // The route sits behind the Host's admission gate; the browser session
          // cookie is what authenticates it.
          credentials: "same-origin",
          headers: { accept: "application/json" },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        libraryStore.set({
          status: "ready",
          items: Array.isArray(data?.items) ? data.items : [],
          sources: Array.isArray(data?.sources) ? data.sources : [],
          suffixId: typeof data?.suffixId === "string" ? data.suffixId : null,
          error: null,
          at: Date.now(),
        });
        // A truncated scan has to say so: the list would otherwise just look
        // like the library has fewer templates than it does.
        if (data?.truncated === true) {
          notify("扫描已截断：目录或模板过多，本次列表不完整", "error");
        }
      } catch (error) {
        libraryStore.set((prev) => ({
          ...prev,
          status: "error",
          error: error instanceof Error ? error.message : String(error),
          at: Date.now(),
        }));
      }
    }

    /* ---------------------------------------------------------------- */
    /* Composer write                                                    */
    /* ---------------------------------------------------------------- */

    /**
     * Insert text at the composer caret through the session's standard
     * `inputActions` prop. The insertion is one undoable plain-text edit and
     * only applies while the captured revision is still current.
     * @returns 'ok' | 'no-input' | 'rejected' | 'error'
     */
    function insertIntoComposer(inputActions, text) {
      if (inputActions === undefined || inputActions === null) return "no-input";
      let span;
      try {
        span = inputActions.captureInsertion();
      } catch {
        return "error";
      }
      if (span === undefined || span === null) return "no-input";
      try {
        return inputActions.insertText(text, span) === true ? "ok" : "rejected";
      } catch {
        return "error";
      }
    }

    /** Copy through the clipboard API, falling back to a hidden textarea. */
    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        /* the Electron file:// origin often denies the async clipboard */
      }
      try {
        const area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "true");
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(area);
        return ok === true;
      } catch {
        return false;
      }
    }

    /* ---------------------------------------------------------------- */
    /* Composition                                                       */
    /* ---------------------------------------------------------------- */

    /** The text a template contributes, honouring the strip preference. */
    function bodyOf(item, settings) {
      const text = settings.stripHeadComment ? item.body : item.raw;
      return String(text ?? "").trim();
    }

    /** CRLF and CR are the same line break for the "already ends with it" test. */
    function normalizeNewlines(text) {
      return text.replace(/\r\n?/g, "\n");
    }

    /**
     * Join the chosen templates in order, then append the align fragment when
     * the preference asks for it and the fragment is not already in the text —
     * either because the tail template ends with it (02), or because the user
     * picked the fragment itself (01).
     *
     * Containment is tested on normalized line endings: a template saved with LF
     * and a fragment saved with CRLF are the same sentence, and comparing raw
     * text appended it a second time. An empty selection never earns a fragment
     * on its own.
     */
    function composeText(items, settings, suffixItem) {
      const parts = items.map((item) => bodyOf(item, settings)).filter((part) => part !== "");
      let text = parts.join("\n\n");
      if (settings.appendAlign && suffixItem !== undefined && suffixItem !== null) {
        const tail = bodyOf(suffixItem, settings);
        const alreadyThere = normalizeNewlines(text).includes(normalizeNewlines(tail));
        if (tail !== "" && text !== "" && !alreadyThere) {
          text = `${text.trimEnd()}\n\n${tail}`;
        }
      }
      return text;
    }

    /** Case-insensitive substring match across the searchable fields. */
    function matchesQuery(item, query) {
      if (query === "") return true;
      const needle = query.toLowerCase();
      const haystack = [
        item.title,
        item.slug,
        item.note,
        item.sourceLabel,
        item.file,
        (item.placeholders ?? []).join(" "),
      ]
        .join("\n")
        .toLowerCase();
      return haystack.includes(needle);
    }

    /* ---------------------------------------------------------------- */
    /* Icons (inline SVG — no extra module requests)                     */
    /* ---------------------------------------------------------------- */

    function IconLibrary({ size = 16 }) {
      return h(
        "svg",
        {
          viewBox: "0 0 16 16",
          width: size,
          height: size,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: "1.3",
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
        },
        h("path", { d: "M3 2.5h7.5a1.5 1.5 0 0 1 1.5 1.5v9.5H4.5A1.5 1.5 0 0 1 3 12z" }),
        h("path", { d: "M3 12a1.5 1.5 0 0 1 1.5-1.5H12" }),
        h("path", { d: "M6 5.5h4" }),
      );
    }

    function IconSearch({ size = 14 }) {
      return h(
        "svg",
        {
          viewBox: "0 0 16 16",
          width: size,
          height: size,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: "1.4",
          strokeLinecap: "round",
          "aria-hidden": "true",
        },
        h("circle", { cx: "7", cy: "7", r: "4.2" }),
        h("path", { d: "M10.2 10.2 13.5 13.5" }),
      );
    }

    function IconRefresh({ size = 14 }) {
      return h(
        "svg",
        {
          viewBox: "0 0 16 16",
          width: size,
          height: size,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: "1.4",
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
        },
        h("path", { d: "M13 8a5 5 0 1 1-1.6-3.7" }),
        h("path", { d: "M13 2.5V5h-2.5" }),
      );
    }

    function IconCheck({ size = 14 }) {
      return h(
        "svg",
        {
          viewBox: "0 0 16 16",
          width: size,
          height: size,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: "1.8",
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
        },
        h("path", { d: "M3.5 8.5 6.5 11.5 12.5 5" }),
      );
    }

    function IconCopy({ size = 14 }) {
      return h(
        "svg",
        {
          viewBox: "0 0 16 16",
          width: size,
          height: size,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: "1.3",
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
        },
        h("rect", { x: "5.5", y: "5.5", width: "8", height: "8", rx: "1.5" }),
        h("path", { d: "M10.5 5.5v-1a1.5 1.5 0 0 0-1.5-1.5H4a1.5 1.5 0 0 0-1.5 1.5V9A1.5 1.5 0 0 0 4 10.5h1" }),
      );
    }

    /* ---------------------------------------------------------------- */
    /* Styles                                                            */
    /* ---------------------------------------------------------------- */

    /*
     * Colour discipline: every foreground/background pair below is a semantic
     * alias token pair, never a literal. `--dsw-alias-brand-primary` INVERTS
     * between themes (near-black in light, near-white in dark), so it may only
     * be used as a fill — text on it must be `--dsw-alias-label-primary-foreground`,
     * which inverts the other way. That is the official button pattern
     * (`button-primary-fill` + `label-primary-foreground`).
     */
    const CSS = `
.pl-trigger{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none;font-family:inherit}
.pl-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary)}
.pl-trigger[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-brand-text)}

.pl-popup{position:absolute;bottom:calc(100% + 6px);left:0;right:0;z-index:100;display:flex;flex-direction:column;max-height:min(60vh,440px);background:var(--dsw-specific-menu,var(--dsw-alias-bg-overlay));backdrop-filter:var(--dsw-menu-backdrop-filter,none);-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,none);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;box-shadow:var(--dsw-elevation-prominent,0 8px 28px rgba(0,0,0,.22));overflow:hidden;color:var(--dsw-alias-label-primary)}
.pl-popup-head{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.pl-search{flex:1;min-width:0;border:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;padding:0;font-family:inherit}
.pl-search::placeholder{color:var(--dsw-alias-label-secondary)}
.pl-icon-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:24px;min-width:24px;padding:0 6px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;flex:none;font-family:inherit}
.pl-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary)}
.pl-icon-btn[data-on="true"]{color:var(--dsw-alias-brand-text);border-color:var(--dsw-alias-brand-text)}
.pl-list{flex:1;min-height:0;overflow-y:auto;padding:4px}
.pl-group-title{position:sticky;top:0;z-index:1;background:var(--dsw-specific-menu,var(--dsw-alias-bg-overlay));padding:6px 8px 2px;font-size:11px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.pl-row{display:flex;align-items:flex-start;gap:8px;width:100%;padding:6px 8px;border:0;border-radius:6px;background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit}
.pl-row:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.pl-row[data-active="true"]{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.pl-row-check{flex:none;width:16px;height:16px;margin-top:2px;border:1px solid var(--dsw-alias-border-l3);border-radius:4px;display:inline-flex;align-items:center;justify-content:center;color:transparent}
.pl-row-check[data-on="true"]{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.pl-row-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.pl-row-title{font-size:13px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pl-row-note{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pl-row-tags{display:flex;gap:4px;flex:none;align-items:center}
.pl-tag{font-size:10px;line-height:16px;padding:0 5px;border-radius:4px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.pl-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 10px;border-top:1px solid var(--dsw-alias-border-l1);flex:none;font-size:11px;color:var(--dsw-alias-label-secondary)}
.pl-primary{display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 10px;border:0;border-radius:6px;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font-size:12px;cursor:pointer;font-family:inherit}
.pl-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.pl-primary:disabled{opacity:.4;cursor:default}
.pl-ghost{display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 8px;border:1px solid var(--dsw-alias-border-l3);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer;font-family:inherit}
.pl-ghost:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l4);background:var(--dsw-alias-interactive-bg-hover)}
.pl-ghost:disabled{opacity:.4;cursor:default}
.pl-notice{padding:4px 10px 4px 8px;font-size:11px;line-height:16px;border-top:1px solid var(--dsw-alias-border-l1);border-left:3px solid transparent;flex:none;color:var(--dsw-alias-label-secondary)}
.pl-notice[data-tone="error"]{border-left-color:var(--dsw-alias-state-error-primary)}
.pl-notice[data-tone="success"]{border-left-color:var(--dsw-alias-state-success-primary)}
.pl-empty{padding:24px 12px;text-align:center;font-size:12px;color:var(--dsw-alias-label-secondary)}

.pl-page{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.pl-page-head{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.pl-page-title{font-size:14px;font-weight:600;margin:0}
.pl-tabs{display:inline-flex;gap:2px;padding:2px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}
.pl-tab{height:24px;padding:0 10px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer;font-family:inherit}
.pl-tab:hover{color:var(--dsw-alias-label-primary)}
.pl-tab[data-on="true"]{background:var(--dsw-alias-button-ghost-active-fill);border-color:var(--dsw-alias-button-ghost-active-border);color:var(--dsw-alias-label-primary)}
.pl-page-body{flex:1;min-height:0;display:flex}
.pl-side{width:300px;flex:none;display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--dsw-alias-border-l1)}
.pl-side-head{padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none;display:flex;flex-direction:column;gap:6px}
.pl-detail{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0}
.pl-detail-head{padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none;display:flex;flex-direction:column;gap:4px}
.pl-detail-title{font-size:13px;font-weight:600}
.pl-detail-meta{font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all}
.pl-chips{display:flex;flex-wrap:wrap;gap:4px}
.pl-chip{font-size:10px;line-height:18px;padding:0 6px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-family:ui-monospace,Consolas,monospace}
.pl-pre{flex:1;min-height:0;overflow:auto;margin:0;padding:12px 14px;font-size:12px;line-height:1.65;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,Consolas,monospace;color:var(--dsw-alias-label-primary)}
.pl-detail-foot{display:flex;gap:8px;padding:8px 14px;border-top:1px solid var(--dsw-alias-border-l1);flex:none}
.pl-settings{flex:1;min-height:0;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:16px;max-width:720px}
.pl-field{display:flex;flex-direction:column;gap:6px}
.pl-label{font-size:12px;font-weight:600}
.pl-hint{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.6}
.pl-textarea{width:100%;box-sizing:border-box;min-height:96px;padding:8px;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;font-family:ui-monospace,Consolas,monospace;resize:vertical}
.pl-textarea::placeholder{color:var(--dsw-alias-label-secondary)}
.pl-switch{display:flex;align-items:flex-start;gap:8px;cursor:pointer;font-size:12px}
.pl-switch input{margin:2px 0 0;accent-color:var(--dsw-alias-button-primary-fill)}
.pl-table{width:100%;border-collapse:collapse;font-size:11px}
.pl-table th,.pl-table td{text-align:left;padding:5px 6px;border-bottom:1px solid var(--dsw-alias-border-l1);word-break:break-all}
.pl-table th{color:var(--dsw-alias-label-secondary);font-weight:500}

/* One visible focus ring for every control, in both themes. */
.pl-trigger:focus-visible,.pl-icon-btn:focus-visible,.pl-row:focus-visible,.pl-primary:focus-visible,.pl-ghost:focus-visible,.pl-tab:focus-visible,.pl-search:focus-visible,.pl-textarea:focus-visible,.pl-switch input:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
`;

    const CSS_TAG = "dsh-prompt-library/panel.css";

    /** Inject the stylesheet once per page, refreshing it on a hot reload. */
    function ensureStyles() {
      if (typeof document === "undefined") return;
      const existing = document.querySelector(`style[data-plugin-css="${CSS_TAG}"]`);
      if (existing !== null) {
        // A rebuilt bundle re-runs apply(); the old tag must not survive it.
        if (existing.textContent !== CSS) existing.textContent = CSS;
        return;
      }
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-prompt-library";
      tag.dataset.pluginCss = CSS_TAG;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /* ---------------------------------------------------------------- */
    /* Composer trigger + picker                                         */
    /* ---------------------------------------------------------------- */

    /** The compact trigger button in the composer tool row. */
    function PromptTrigger() {
      const open = useStore(pickerStore);
      return h(
        "button",
        {
          type: "button",
          className: "pl-trigger",
          "data-prompt-library": "trigger",
          title: "Prompt 库 — 插入预设提示词",
          "aria-label": "Prompt 库",
          "aria-expanded": open ? "true" : "false",
          // Keep the composer's caret: never let the button take focus.
          onMouseDown: (event) => event.preventDefault(),
          onClick: () => {
            const next = !pickerStore.getSnapshot();
            pickerStore.set(next);
            noticeStore.set({ text: "", tone: "info", seq: 0 });
            if (next) void loadLibrary(false);
          },
        },
        h(IconLibrary, { size: 15 }),
      );
    }

    /** The picker popup rendered inside the composer card. */
    function PromptPicker({ inputActions }) {
      const open = useStore(pickerStore);
      const library = useStore(libraryStore);
      const settings = useStore(settingsStore);
      const notice = useStore(noticeStore);

      const [query, setQuery] = useState("");
      const [selected, setSelected] = useState([]);
      const [cursor, setCursor] = useState(0);
      const rootRef = useRef(null);
      const inputRef = useRef(null);

      const close = useCallback(() => {
        pickerStore.set(false);
        noticeStore.set({ text: "", tone: "info", seq: 0 });
      }, []);

      // Reset the transient interaction state every time the picker opens.
      useEffect(() => {
        if (!open) return;
        setQuery("");
        setSelected([]);
        setCursor(0);
        const timer = window.setTimeout(() => {
          try {
            inputRef.current?.focus();
          } catch {
            /* focus is an enhancement; a hostile host must not break the popup */
          }
        }, 0);
        return () => window.clearTimeout(timer);
      }, [open]);

      // Dismiss on an outside pointer press or Escape.
      useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event) => {
          const target = event.target;
          if (target instanceof Element && target.closest("[data-prompt-library]") !== null) return;
          close();
        };
        const onKeyDown = (event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            close();
          }
        };
        document.addEventListener("mousedown", onPointerDown, true);
        document.addEventListener("keydown", onKeyDown, true);
        return () => {
          document.removeEventListener("mousedown", onPointerDown, true);
          document.removeEventListener("keydown", onKeyDown, true);
        };
      }, [open, close]);

      const items = library.items ?? [];
      const filtered = useMemo(
        () => items.filter((item) => matchesQuery(item, query)),
        [items, query],
      );
      const suffixItem = useMemo(
        () => items.find((item) => item.id === library.suffixId) ?? null,
        [items, library.suffixId],
      );
      const groups = useMemo(() => {
        const out = [];
        const byLabel = new Map();
        for (const item of filtered) {
          const label = item.sourceLabel ?? item.sourceKey ?? "?";
          let group = byLabel.get(label);
          if (group === undefined) {
            group = { label, items: [] };
            byLabel.set(label, group);
            out.push(group);
          }
          group.items.push(item);
        }
        return out;
      }, [filtered]);

      const activeIndex = filtered.length === 0 ? -1 : Math.min(cursor, filtered.length - 1);

      /** Insert the given items and close; report the clipboard outcome honestly. */
      const commit = useCallback(
        async (chosen) => {
          if (chosen.length === 0) return;
          const text = composeText(chosen, settings, suffixItem);
          const result = insertIntoComposer(inputActions, text);
          if (result === "ok") {
            close();
            return;
          }
          // Announcing "已复制到剪贴板" before knowing the outcome left the user
          // pasting whatever happened to be on the clipboard already.
          const copied = await copyText(text);
          const reason =
            result === "no-input"
              ? "当前输入框不可写入"
              : result === "rejected"
                ? "插入被拒绝（草稿已变化或正在提交）"
                : "插入失败";
          notify(
            copied ? `${reason}；已复制到剪贴板` : `${reason}；复制到剪贴板也失败`,
            "error",
          );
        },
        [settings, suffixItem, inputActions, close],
      );

      const pick = useCallback(
        (item) => {
          if (settings.multi) {
            setSelected((prev) =>
              prev.includes(item.id) ? prev.filter((id) => id !== item.id) : [...prev, item.id],
            );
            return;
          }
          commit([item]);
        },
        [settings.multi, commit],
      );

      if (!open) return null;

      const selectedItems = selected
        .map((id) => items.find((item) => item.id === id))
        .filter((item) => item !== undefined);

      const onSearchKeyDown = (event) => {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setCursor((prev) => Math.min(prev + 1, Math.max(0, filtered.length - 1)));
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          setCursor((prev) => Math.max(prev - 1, 0));
        } else if (event.key === "Enter") {
          event.preventDefault();
          if (settings.multi) {
            const target = filtered[activeIndex];
            if (target !== undefined) pick(target);
          } else if (filtered.length > 0) {
            commit([filtered[Math.max(0, activeIndex)]]);
          }
        } else if (event.key === "Tab") {
          event.preventDefault();
        }
      };

      return h(
        "div",
        {
          className: "pl-popup",
          "data-prompt-library": "popup",
          role: "dialog",
          "aria-label": "Prompt 库",
          ref: rootRef,
        },
        h(
          "div",
          { className: "pl-popup-head" },
          h(IconSearch, { size: 14 }),
          h("input", {
            ref: inputRef,
            className: "pl-search",
            type: "text",
            value: query,
            placeholder: "搜索模板（标题 / 描述 / 来源 / 占位符）",
            "aria-label": "搜索模板",
            onChange: (event) => {
              setQuery(event.target.value);
              setCursor(0);
            },
            onKeyDown: onSearchKeyDown,
          }),
          h(
            "button",
            {
              type: "button",
              className: "pl-icon-btn",
              "data-on": settings.multi ? "true" : "false",
              title: "多选：点击累积，再一次性按顺序插入",
              onMouseDown: (event) => event.preventDefault(),
              onClick: () => {
                setSelected([]);
                updateSettings({ multi: !settings.multi });
              },
            },
            "多选",
          ),
          h(
            "button",
            {
              type: "button",
              className: "pl-icon-btn",
              title: "重新扫描来源目录",
              "aria-label": "刷新",
              onMouseDown: (event) => event.preventDefault(),
              onClick: () => void loadLibrary(true),
            },
            h(IconRefresh, { size: 14 }),
          ),
        ),
        h(
          "div",
          { className: "pl-list" },
          library.status === "loading" && items.length === 0
            ? h("div", { className: "pl-empty" }, "正在扫描…")
            : null,
          library.status === "error"
            ? h(
                "div",
                { className: "pl-empty" },
                `读取失败：${library.error ?? "未知错误"}`,
              )
            : null,
          library.status === "ready" && filtered.length === 0
            ? h(
                "div",
                { className: "pl-empty" },
                query === ""
                  ? "没有找到模板。请检查来源目录，或在「设置」里添加目录。"
                  : "没有匹配的模板。",
              )
            : null,
          groups.map((group) =>
            h(
              "div",
              { key: group.label },
              h("div", { className: "pl-group-title" }, `${group.label} · ${group.items.length}`),
              group.items.map((item) => {
                const index = filtered.indexOf(item);
                const isSelected = selected.includes(item.id);
                return h(
                  "button",
                  {
                    key: item.id,
                    type: "button",
                    className: "pl-row",
                    "data-active": index === activeIndex && !settings.multi ? "true" : "false",
                    title: item.note || item.path,
                    onMouseEnter: () => setCursor(index),
                    onMouseDown: (event) => event.preventDefault(),
                    onClick: () => pick(item),
                  },
                  settings.multi
                    ? h(
                        "span",
                        { className: "pl-row-check", "data-on": isSelected ? "true" : "false" },
                        isSelected ? h(IconCheck, { size: 12 }) : null,
                      )
                    : null,
                  h(
                    "span",
                    { className: "pl-row-main" },
                    h("span", { className: "pl-row-title" }, item.title),
                    item.note !== ""
                      ? h("span", { className: "pl-row-note" }, item.note)
                      : null,
                  ),
                  h(
                    "span",
                    { className: "pl-row-tags" },
                    item.kind === "suffix" ? h("span", { className: "pl-tag" }, "追加片段") : null,
                    (item.placeholders ?? []).length > 0
                      ? h(
                          "span",
                          { className: "pl-tag" },
                          `占位符 ${(item.placeholders ?? []).length}`,
                        )
                      : null,
                  ),
                );
              }),
            ),
          ),
        ),
        notice.text !== ""
          ? h("div", { className: "pl-notice", "data-tone": notice.tone }, notice.text)
          : null,
        h(
          "div",
          { className: "pl-foot" },
          h(
            "span",
            null,
            settings.multi
              ? `已选 ${selectedItems.length} 条`
              : settings.appendAlign && suffixItem !== null
                ? `点击插入 · 自动追加「${suffixItem.slug}」`
                : "点击插入到输入框",
          ),
          settings.multi
            ? h(
                "span",
                { style: { display: "inline-flex", gap: "6px" } },
                h(
                  "button",
                  {
                    type: "button",
                    className: "pl-ghost",
                    disabled: selectedItems.length === 0,
                    onClick: () => setSelected([]),
                  },
                  "清空",
                ),
                h(
                  "button",
                  {
                    type: "button",
                    className: "pl-primary",
                    disabled: selectedItems.length === 0,
                    onMouseDown: (event) => event.preventDefault(),
                    onClick: () => commit(selectedItems),
                  },
                  `插入 ${selectedItems.length} 条`,
                ),
              )
            : null,
        ),
      );
    }

    /* ---------------------------------------------------------------- */
    /* Library page                                                      */
    /* ---------------------------------------------------------------- */

    function LibraryPage() {
      const library = useStore(libraryStore);
      const settings = useStore(settingsStore);
      const notice = useStore(noticeStore);
      const [tab, setTab] = useState("browse");
      const [query, setQuery] = useState("");
      const [activeId, setActiveId] = useState(null);
      const [draft, setDraft] = useState((settings.extraDirs ?? []).join("\n"));

      useEffect(() => {
        void loadLibrary(false);
      }, []);

      useEffect(() => {
        setDraft((settings.extraDirs ?? []).join("\n"));
      }, [settings.extraDirs]);

      useEffect(() => {
        // The picker shares this notice line; do not inherit a stale message.
        notify("");
      }, []);

      const items = library.items ?? [];
      const filtered = useMemo(
        () => items.filter((item) => matchesQuery(item, query)),
        [items, query],
      );
      const active = useMemo(
        () => filtered.find((item) => item.id === activeId) ?? filtered[0] ?? null,
        [filtered, activeId],
      );
      const suffixItem = useMemo(
        () => items.find((item) => item.id === library.suffixId) ?? null,
        [items, library.suffixId],
      );

      // The picker and this page share one transient notice line; render it here
      // as well, or a failed copy on this page reports nothing at all.
      const noticeLine =
        notice.text !== ""
          ? h("div", { className: "pl-notice", "data-tone": notice.tone }, notice.text)
          : null;

      const copyActive = async (strip) => {
        if (active === null) return;
        const text = composeText([active], { ...settings, stripHeadComment: strip }, suffixItem);
        const copied = await copyText(text);
        notify(copied ? "已复制" : "复制失败", copied ? "success" : "error");
      };

      const head = h(
        "div",
        { className: "pl-page-head" },
        h(IconLibrary, { size: 16 }),
        h("h2", { className: "pl-page-title" }, "Prompt 库"),
        h(
          "div",
          { className: "pl-tabs" },
          h(
            "button",
            {
              type: "button",
              className: "pl-tab",
              "data-on": tab === "browse" ? "true" : "false",
              onClick: () => setTab("browse"),
            },
            "模板",
          ),
          h(
            "button",
            {
              type: "button",
              className: "pl-tab",
              "data-on": tab === "settings" ? "true" : "false",
              onClick: () => setTab("settings"),
            },
            "设置",
          ),
        ),
        h("span", { style: { flex: "1" } }),
        h(
          "span",
          { className: "pl-hint" },
          `${items.length} 个模板 · ${(library.sources ?? []).length} 个来源`,
        ),
        h(
          "button",
          {
            type: "button",
            className: "pl-ghost",
            onClick: () => void loadLibrary(true),
          },
          h(IconRefresh, { size: 13 }),
          "重新扫描",
        ),
      );

      if (tab === "settings") {
        const sourceRows = (library.sources ?? []).map((source) =>
          h(
            "tr",
            { key: source.key },
            h("td", null, source.label),
            h("td", null, source.kind),
            h("td", null, String(source.count)),
            h("td", null, source.dir),
          ),
        );
        return h(
          "div",
          { className: "pl-page", "data-dsh-prompt-library-view": "" },
          head,
          h(
            "div",
            { className: "pl-settings" },
            h(
              "div",
              { className: "pl-field" },
              h("span", { className: "pl-label" }, "插入行为"),
              h(
                "label",
                { className: "pl-switch" },
                h("input", {
                  type: "checkbox",
                  checked: settings.stripHeadComment === true,
                  onChange: (event) => updateSettings({ stripHeadComment: event.target.checked }),
                }),
                h(
                  "span",
                  null,
                  "剥离文件头的 <!-- --> 维护注释",
                  h(
                    "div",
                    { className: "pl-hint" },
                    "模板文件开头的元数据注释是给维护者看的，按目录约定不应进入提示词。",
                  ),
                ),
              ),
              h(
                "label",
                { className: "pl-switch" },
                h("input", {
                  type: "checkbox",
                  checked: settings.appendAlign === true,
                  onChange: (event) => updateSettings({ appendAlign: event.target.checked }),
                }),
                h(
                  "span",
                  null,
                  "自动追加对齐片段",
                  h(
                    "div",
                    { className: "pl-hint" },
                    suffixItem === null
                      ? "当前来源里没有识别到 align 片段。"
                      : `已识别：${suffixItem.sourceLabel} / ${suffixItem.file}（末尾已存在时不重复追加）。`,
                  ),
                ),
              ),
              h(
                "label",
                { className: "pl-switch" },
                h("input", {
                  type: "checkbox",
                  checked: settings.multi === true,
                  onChange: (event) => updateSettings({ multi: event.target.checked }),
                }),
                h("span", null, "选择器默认多选（点击累积，再一次性插入）"),
              ),
            ),
            h(
              "div",
              { className: "pl-field" },
              h("span", { className: "pl-label" }, "额外来源目录"),
              h(
                "div",
                { className: "pl-hint" },
                "每行一个绝对路径，指向存放 *.md 提示词模板的目录。skill 的 assets/prompts 会自动扫描，这里只加额外的。",
              ),
              h("textarea", {
                className: "pl-textarea",
                value: draft,
                spellCheck: false,
                placeholder: "C:\\path\\to\\my-prompts",
                onChange: (event) => setDraft(event.target.value),
              }),
              h(
                "div",
                { style: { display: "flex", gap: "8px" } },
                h(
                  "button",
                  {
                    type: "button",
                    className: "pl-primary",
                    onClick: () => {
                      const dirs = draft
                        .split("\n")
                        .map((line) => line.trim())
                        .filter(Boolean);
                      updateSettings({ extraDirs: dirs });
                      void loadLibrary(true);
                    },
                  },
                  "保存并重新扫描",
                ),
                h(
                  "button",
                  {
                    type: "button",
                    className: "pl-ghost",
                    onClick: () => setDraft(""),
                  },
                  "清空输入",
                ),
              ),
            ),
            h(
              "div",
              { className: "pl-field" },
              h("span", { className: "pl-label" }, "本次扫描到的来源"),
              h(
                "table",
                { className: "pl-table" },
                h(
                  "thead",
                  null,
                  h(
                    "tr",
                    null,
                    h("th", null, "名称"),
                    h("th", null, "类型"),
                    h("th", null, "模板数"),
                    h("th", null, "路径"),
                  ),
                ),
                h("tbody", null, sourceRows.length > 0 ? sourceRows : h("tr", null, h("td", { colSpan: 4 }, "（无）"))),
              ),
              h(
                "div",
                { className: "pl-hint" },
                "自动来源：DSH_HOME/skills/*/assets/prompts、AGENTS_HOME/skills/*/assets/prompts、以及每个活动工作区的 docs/prompts、prompts、.dsh/prompts。",
              ),
            ),
          ),
          noticeLine,
        );
      }

      return h(
        "div",
        { className: "pl-page", "data-dsh-prompt-library-view": "" },
        head,
        h(
          "div",
          { className: "pl-page-body" },
          h(
            "div",
            { className: "pl-side" },
            h(
              "div",
              { className: "pl-side-head" },
              h("input", {
                className: "pl-search",
                style: {
                  border: "1px solid var(--dsw-alias-border-l1)",
                  borderRadius: "6px",
                  padding: "4px 8px",
                },
                type: "text",
                value: query,
                placeholder: "搜索模板…",
                onChange: (event) => setQuery(event.target.value),
              }),
            ),
            h(
              "div",
              { className: "pl-list" },
              library.status === "loading" && items.length === 0
                ? h("div", { className: "pl-empty" }, "正在扫描…")
                : null,
              library.status === "error"
                ? h("div", { className: "pl-empty" }, `读取失败：${library.error ?? ""}`)
                : null,
              library.status === "ready" && filtered.length === 0
                ? h("div", { className: "pl-empty" }, "没有模板")
                : null,
              filtered.map((item) =>
                h(
                  "button",
                  {
                    key: item.id,
                    type: "button",
                    className: "pl-row",
                    "data-active": active !== null && active.id === item.id ? "true" : "false",
                    onClick: () => setActiveId(item.id),
                  },
                  h(
                    "span",
                    { className: "pl-row-main" },
                    h("span", { className: "pl-row-title" }, item.title),
                    h(
                      "span",
                      { className: "pl-row-note" },
                      `${item.sourceLabel} · ${item.file}`,
                    ),
                  ),
                  item.kind === "suffix" ? h("span", { className: "pl-tag" }, "片段") : null,
                ),
              ),
            ),
          ),
          h(
            "div",
            { className: "pl-detail" },
            active === null
              ? h("div", { className: "pl-empty" }, "从左侧选一个模板")
              : [
                  h(
                    "div",
                    { className: "pl-detail-head", key: "head" },
                    h("div", { className: "pl-detail-title" }, active.title),
                    h(
                      "div",
                      { className: "pl-detail-meta" },
                      `${active.sourceLabel} · ${active.file} · ${active.bytes} 字节`,
                    ),
                    h("div", { className: "pl-detail-meta" }, active.path),
                    active.note !== ""
                      ? h("div", { className: "pl-hint" }, active.note)
                      : null,
                    (active.placeholders ?? []).length > 0
                      ? h(
                          "div",
                          { className: "pl-chips" },
                          (active.placeholders ?? []).map((token) =>
                            h("span", { className: "pl-chip", key: token }, `<${token}>`),
                          ),
                        )
                      : null,
                  ),
                  h(
                    "pre",
                    { className: "pl-pre", key: "body" },
                    settings.stripHeadComment ? active.body : active.raw,
                  ),
                  h(
                    "div",
                    { className: "pl-detail-foot", key: "foot" },
                    h(
                      "button",
                      {
                        type: "button",
                        className: "pl-primary",
                        onClick: () => void copyActive(settings.stripHeadComment === true),
                      },
                      h(IconCopy, { size: 13 }),
                      "复制全文",
                    ),
                    h(
                      "button",
                      {
                        type: "button",
                        className: "pl-ghost",
                        onClick: () => void copyActive(false),
                      },
                      "复制（含注释头）",
                    ),
                    h("span", { style: { flex: "1" } }),
                    h(
                      "span",
                      { className: "pl-hint" },
                      "插入到输入框请用输入框左下角的 Prompt 按钮",
                    ),
                  ),
                ],
          ),
          noticeLine,
        ),
      );
    }

    /* ---------------------------------------------------------------- */
    /* Registration                                                      */
    /* ---------------------------------------------------------------- */

    /** The sidebar row glyph (the shell owns the button and label). */
    function LibraryPanelIcon({ size = 16 }) {
      return h(
        "svg",
        {
          "data-dsh-panel-entry": PANEL_ID,
          viewBox: "0 0 16 16",
          width: size,
          height: size,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: "1.3",
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
        },
        h("path", { d: "M3 2.5h7.5A1.5 1.5 0 0 1 12 4v9.5H4.5A1.5 1.5 0 0 1 3 12z" }),
        h("path", { d: "M3 12a1.5 1.5 0 0 1 1.5-1.5H12" }),
        h("path", { d: "M6 5.5h4" }),
      );
    }

    /**
     * Register every surface. Each seat is wrapped in `ctx.slots.inject`, so a
     * shell that never declares one leaves that surface simply absent instead
     * of failing the plugin load.
     */
    function registerSurfaces(ctx) {
      const slots = ctx.slots;
      const disposers = [];

      disposers.push(
        slots.inject("conversation.input.left", () =>
          slots.register({ name: "conversation.input.left", id: PANEL_ID, order: 20 }, PromptTrigger),
        ),
      );

      disposers.push(
        slots.inject("conversation.input.overlay", () =>
          slots.register({ name: "conversation.input.overlay", id: PANEL_ID, order: 40 }, PromptPicker),
        ),
      );

      disposers.push(
        slots.inject("sidebar.panellist", () =>
          slots.register(
            {
              name: "sidebar.panellist",
              id: PANEL_ID,
              order: PANEL_ORDER,
              label: () => "Prompt 库",
            },
            LibraryPanelIcon,
          ),
        ),
      );

      disposers.push(
        slots.inject("main", () =>
          slots.register({ name: "main", key: PANEL_ID }, LibraryPage),
        ),
      );

      return () => {
        for (const dispose of disposers.splice(0)) {
          try {
            dispose();
          } catch {
            /* teardown is best-effort */
          }
        }
      };
    }

    /* ---------------------------------------------------------------- */
    /* Plugin contract                                                   */
    /* ---------------------------------------------------------------- */

    /** Required client services (the slot registry must be up first). */
    const inject = ["slots"];

    /** Mount the prompt library surfaces. */
    function apply(ctx) {
      try {
        ensureStyles();
      } catch (error) {
        console.warn("[prompt-library] style injection failed:", error);
      }
      ctx.effect(() => {
        let release = () => {};
        try {
          release = registerSurfaces(ctx);
        } catch (error) {
          console.warn("[prompt-library] surface registration failed:", error);
        }
        return () => release();
      }, "prompt-library: surfaces");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
