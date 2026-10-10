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
      read: "api/dsh-prompt-library/read",
      write: "api/dsh-prompt-library/write",
      create: "api/dsh-prompt-library/create",
      rename: "api/dsh-prompt-library/rename",
      remove: "api/dsh-prompt-library/delete",
      reveal: "api/dsh-prompt-library/reveal",
      open: "api/dsh-prompt-library/open",
    };

    /** The center-column panel id shared by the sidebar row and the page. */
    const PANEL_ID = "prompt-library";

    /** Sidebar row order (after the shipped panels). */
    const PANEL_ORDER = 35;

    const SETTINGS_KEY = "dsh-prompt-library/settings/v1";

    /**
     * How long an open is coalesced with the one before it.
     *
     * This is a debounce, not a cache: it never decides whether the catalog is
     * fresh enough. It only keeps a rapid open/close/open from issuing three
     * scans. A scan costs well under a millisecond on a real library, so there
     * is nothing to gain by reusing an older answer — and a freshness window
     * turns "what is on disk now" into a random number.
     */
    const OPEN_DEBOUNCE_MS = 1000;

    const DEFAULT_SETTINGS = {
      /** Append the align fragment when it is not already there. */
      appendAlign: true,
      /**
       * Which template to append: `"auto"` takes the first declared fragment,
       * any other string is a template id the user picked, `""` appends none.
       */
      alignTarget: "auto",
      /** Ask for parameter values before inserting a template with placeholders. */
      fillParams: true,
      /** Leave an unfilled placeholder in the text instead of deleting it. */
      keepEmptyPlaceholders: true,
      /** Source labels the user has folded shut in the picker. */
      collapsedSources: [],
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
      suffixIds: [],
      writable: true,
      error: null,
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

    /** When the last scan was started, for the open debounce only. */
    let lastScanAt = 0;

    /** Fetch the catalog; the `dirs` query carries the user's extra directories. */
    async function loadLibrary(force = false, quiet = false) {
      const current = libraryStore.getSnapshot();
      if (!force && current.status === "loading") return;
      if (!force && Date.now() - lastScanAt < OPEN_DEBOUNCE_MS) return;
      lastScanAt = Date.now();

      const settings = settingsStore.getSnapshot();
      const extra = Array.isArray(settings.extraDirs)
        ? settings.extraDirs.map((dir) => String(dir).trim()).filter(Boolean)
        : [];
      const query = extra.length === 0 ? "" : `?dirs=${encodeURIComponent(extra.join("\n"))}`;

      // A quiet refresh keeps the current list on screen: after a write the user
      // is looking at it, and flashing a loading state for a scan that takes
      // under a millisecond is noise.
      if (!quiet) libraryStore.set((prev) => ({ ...prev, status: "loading", error: null }));
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
          suffixIds: Array.isArray(data?.suffixIds) ? data.suffixIds : [],
          // The page has to know whether writing is available before it offers
          // an editor; the host is the authority on that, not a local switch.
          writable: data?.writable !== false,
          error: null,
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
        }));
      }
    }

    /* ---------------------------------------------------------------- */
    /* Write routes                                                      */
    /* ---------------------------------------------------------------- */

    /** The `dirs` query every route needs, so the host scans the same sources. */
    function dirsQuery() {
      const settings = settingsStore.getSnapshot();
      const extra = Array.isArray(settings.extraDirs)
        ? settings.extraDirs.map((dir) => String(dir).trim()).filter(Boolean)
        : [];
      return extra.length === 0 ? "" : `?dirs=${encodeURIComponent(extra.join("\n"))}`;
    }

    /**
     * Call one route and hand back its status with whatever body it produced.
     *
     * The status comes back rather than throwing: 409 and 403 are answers the
     * interface has to show, not failures to swallow.
     */
    async function callRoute(name, body) {
      const response = await fetch(`${API[name]}${dirsQuery()}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      let data = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      return { ok: response.ok, status: response.status, data };
    }

    /**
     * Rescan after a write without flashing the loading state.
     *
     * The write routes answer with the file's new identity rather than the
     * rebuilt catalog entry, so the list is re-read instead of patched. A full
     * scan is well under a millisecond at this scale, and re-reading cannot
     * drift out of sync with the disk.
     */
    const refreshQuietly = () => loadLibrary(true, true);

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

    /**
     * The text a template contributes.
     *
     * The picker inserts the body, never the maintenance comment: the two
     * explicit copy buttons on the library page are how the raw file is asked
     * for, and that one is read on demand.
     */
    function bodyOf(item) {
      return String(item.body ?? "").trim();
    }

    /** CRLF and CR are the same line break for the "already ends with it" test. */
    function normalizeNewlines(text) {
      return text.replace(/\r\n?/g, "\n");
    }

    /** Escape a placeholder so it can be matched literally in a regular expression. */
    function escapeRegExp(value) {
      return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    /** The alternation that matches every placeholder of these tokens. */
    function placeholderPattern(tokens) {
      return tokens
        .slice()
        .sort((a, b) => b.length - a.length)
        .map((token) => `<${escapeRegExp(token)}>|(?<![\\w<])${escapeRegExp(token)}(?![\\w>])`)
        .join("|");
    }

    /**
     * Put the typed values in place of their placeholders.
     *
     * One pass over the original text, replacing through a function: replacing
     * token by token let an earlier value be scanned again by a later token, so
     * typing `项目名：测试` into `<项目名>` came out as `项目名：测试：测试`.
     *
     * A placeholder is written either as `<token>` or, for the older `xxxxx`
     * form, as the bare token; longer tokens are matched first and a bare token
     * only matches on its own.
     */
    function fillPlaceholders(text, values, keepEmpty) {
      const source = String(text ?? "");
      const tokens = Object.keys(values ?? {}).filter((token) => token !== "");
      if (tokens.length === 0) return source;
      return source.replace(new RegExp(placeholderPattern(tokens), "g"), (raw) => {
        const token = raw.startsWith("<") ? raw.slice(1, -1) : raw;
        const value = String(values[token] ?? "").trim();
        if (value !== "") return value;
        return keepEmpty ? raw : "";
      });
    }

    /**
     * Split the *unsubstituted* text into literal runs and placeholder runs, so
     * the preview can show each placeholder as the value it will become — or as
     * the placeholder itself while it is still empty.
     */
    function previewParts(text, values, keepEmpty) {
      const tokens = Object.keys(values ?? {}).filter((token) => token !== "");
      const source = String(text ?? "");
      if (tokens.length === 0) return [{ text: source }];
      const parts = [];
      let last = 0;
      for (const match of source.matchAll(new RegExp(placeholderPattern(tokens), "g"))) {
        if (match.index > last) parts.push({ text: source.slice(last, match.index) });
        const raw = match[0];
        const token = raw.startsWith("<") ? raw.slice(1, -1) : raw;
        const value = String(values[token] ?? "").trim();
        const filled = value !== "";
        parts.push({ text: filled ? value : keepEmpty ? raw : "", token, filled });
        last = match.index + raw.length;
      }
      if (last < source.length) parts.push({ text: source.slice(last) });
      return parts;
    }

    /**
     * The head-comment labels, mirroring the host's table.
     *
     * The editor reads the file it just loaded rather than the catalog entry,
     * because the catalog may be older than the disk; that means parsing the
     * comment on this side too.
     */
    const META_LABELS = {
      summary: "summary",
      detail: "detail",
      source: "source",
      placeholder: "placeholder",
      kind: "kind",
      用途: "summary",
      来源: "source",
      占位符: "placeholder",
    };

    /** The fields the editor form owns, in the order the comment writes them. */
    const META_FIELDS = ["summary", "detail", "source", "placeholder", "kind"];

    /** Split a template into its head-comment fields and its body. */
    function parseTemplate(raw) {
      const text = String(raw ?? "").replace(/^\uFEFF/, "");
      const closed = /^\s*<!--([\s\S]*?)-->[ \t]*\r?\n?/.exec(text);
      const open = closed === null ? /^[ \t]*<!--([^\n]*)\r?\n?/.exec(text) : null;
      const meta = closed !== null ? closed[1] : open !== null ? open[1] : "";
      const body =
        closed !== null ? text.slice(closed[0].length) : open !== null ? text.slice(open[0].length) : text;
      const fields = { summary: "", detail: "", source: "", placeholder: "", kind: "prompt" };
      const free = [];
      if (meta !== "") {
        const lines = meta.split(/\r?\n/);
        // Text after `<!--` on the same line is separated by a space, not indented.
        if (lines[0].trim() !== "") lines[0] = lines[0].trimStart();
        const indents = lines
          .filter((line) => line.trim() !== "")
          .map((line) => line.match(/^[ \t]*/)[0].length);
        const base = indents.length === 0 ? 0 : Math.min(...indents);
        let current = null;
        for (const rawLine of lines) {
          const line = rawLine.slice(base);
          if (line.trim() === "") {
            if (current === "detail" && fields.detail !== "") fields.detail += "\n";
            continue;
          }
          const indented = /^[ \t]/.test(line);
          const labelled = indented ? null : /^([^：:\s][^：:]{0,15})\s*[：:]\s*(.*)$/.exec(line);
          const key = labelled === null ? undefined : META_LABELS[labelled[1].trim().toLowerCase()];
          if (key !== undefined) {
            current = key;
            const value = labelled[2].trim();
            fields[key] = key !== "kind" && fields[key] !== "" ? `${fields[key]} ${value}` : value;
            continue;
          }
          const value = line.trim();
          if (current !== null && (indented || current === "detail")) {
            fields[current] =
              fields[current] === ""
                ? value
                : `${fields[current]}${current === "detail" ? "\n" : " "}${value}`;
            continue;
          }
          free.push(value);
        }
        fields.detail = fields.detail.replace(/\n+$/, "");
      }
      // Free text that filled the summary slot *is* the summary; anything else
      // is a line the form does not own, kept so that saving does not delete it.
      const usedFree = fields.summary === "" && free.length > 0;
      if (usedFree) fields.summary = free.join(" ");
      return { fields, body, extra: usedFree ? [] : free };
    }

    /** Render the head comment for these fields, in the documented shape. */
    function buildHeadComment(fields, extra) {
      const lines = [];
      if (fields.summary !== "") lines.push(`summary: ${fields.summary}`);
      if (fields.detail !== "") {
        lines.push("detail:");
        for (const line of fields.detail.split("\n")) lines.push(`  ${line}`);
      }
      if (fields.source !== "") lines.push(`source: ${fields.source}`);
      if (fields.placeholder !== "") lines.push(`placeholder: ${fields.placeholder}`);
      if (fields.kind === "suffix") lines.push("kind: suffix");
      // Lines the form does not understand are carried through verbatim rather
      // than dropped on the next save.
      for (const line of extra ?? []) lines.push(line);
      return lines.length === 0 ? "" : `<!--\n${lines.join("\n")}\n-->\n\n`;
    }

    /** The whole file for these fields, as the host will store it. */
    function buildTemplateText(fields, body, extra) {
      const head = buildHeadComment(fields, extra);
      const text = String(body ?? "");
      if (head === "") return text;
      return `${head}${text.replace(/^\n+/, "")}`;
    }

    /** Case-insensitive substring match across the searchable fields. */
    function matchesQuery(item, query) {
      if (query === "") return true;
      const needle = query.toLowerCase();
      const haystack = [
        item.title,
        item.slug,
        item.summary,
        item.detail,
        item.source,
        item.placeholder,
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

.pl-popup{position:absolute;bottom:calc(100% + 6px);left:0;right:auto;width:min(100%,620px);z-index:100;display:flex;flex-direction:column;max-height:min(60vh,440px);background:var(--dsw-specific-menu,var(--dsw-alias-bg-overlay));backdrop-filter:var(--dsw-menu-backdrop-filter,none);-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,none);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;box-shadow:var(--dsw-elevation-prominent,0 8px 28px rgba(0,0,0,.22));overflow:hidden;color:var(--dsw-alias-label-primary)}
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

/* Detail and the parameter card own the height budget instead of sharing it. */
.pl-popup[data-mode="detail"],.pl-popup[data-mode="fill"]{width:min(100%,720px);max-height:min(72vh,600px)}

/* Picker: collapsed source groups, the ⓘ detail view, and the parameter card. */
.pl-group-title{display:flex;align-items:center;gap:6px;width:100%;padding:6px 8px 2px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:500;text-align:left;cursor:pointer;font-family:inherit;position:sticky;top:0;z-index:1}
.pl-group-title:hover{color:var(--dsw-alias-label-primary)}
.pl-chev{display:inline-block;width:9px;flex:none;font-size:9px;line-height:1;transition:transform .12s}
.pl-chev[data-open="false"]{transform:rotate(-90deg)}
.pl-row-wrap{display:flex;align-items:stretch;border-radius:6px}
.pl-row-wrap:hover,.pl-row-wrap[data-active="true"]{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.pl-row-wrap .pl-row:hover{background:transparent}
.pl-info-btn{flex:none;align-self:center;width:26px;height:26px;margin-right:4px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;opacity:0;font-family:inherit}
.pl-row-wrap:hover .pl-info-btn,.pl-row-wrap[data-active="true"] .pl-info-btn,.pl-info-btn:focus-visible{opacity:1}
.pl-info-btn:hover{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}
.pl-view{flex:1;min-height:0;display:flex;flex-direction:column}
.pl-view-head{display:flex;align-items:flex-start;gap:8px;padding:9px 12px 8px;flex:none;border-bottom:1px solid var(--dsw-alias-border-l1)}
.pl-view-title{font-size:13px;font-weight:600}
.pl-view-sub{font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all}
.pl-view-body{flex:1;min-height:0;overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:10px}
.pl-sec{display:flex;flex-direction:column;gap:5px}
.pl-sec-body{border:1px solid var(--dsw-alias-border-l4);border-radius:8px;padding:8px 10px}
.pl-sec-title{font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}
.pl-summary{font-size:13px;line-height:1.6}
.pl-detail-text{font-size:12px;line-height:1.7;white-space:pre-wrap;word-break:break-word}
.pl-body-pre{max-height:220px;overflow:auto;margin:0;padding:0;font-size:11.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,Consolas,monospace}
.pl-view-foot{flex:none;display:flex;align-items:center;gap:8px;padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1)}
.pl-fill-grid{flex:1;min-height:0;display:flex}
.pl-fill-params{width:46%;flex:none;min-width:0;overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:10px;border-right:1px solid var(--dsw-alias-border-l1)}
.pl-param{display:flex;flex-direction:column;gap:4px}
.pl-param-label{font-size:11px;font-family:ui-monospace,Consolas,monospace;color:var(--dsw-alias-label-secondary);word-break:break-all}
.pl-input{width:100%;box-sizing:border-box;height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l3);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;font-family:inherit}
.pl-input:focus{border-color:var(--dsw-alias-state-business-primary);outline:none}
.pl-fill-preview{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0}
.pl-fill-preview-head{flex:none;padding:8px 12px 4px;font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}
.pl-fill-pre{flex:1;min-height:0;overflow:auto;margin:0;padding:0 12px 12px;font-size:11.5px;line-height:1.7;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,Consolas,monospace}
.pl-filled{background:var(--dsw-alias-button-ghost-active-fill);border-radius:3px;padding:0 2px}
.pl-unfilled{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-radius:3px;padding:0 2px}
.pl-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.pl-danger:hover:not(:disabled){background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground)}

.pl-pathrow{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.pl-path{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all;flex:1 1 100%}

.pl-select{width:100%;height:30px;padding:0 6px;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;font-family:inherit}

.pl-editor{flex:1;min-height:0;overflow:auto;padding:14px;display:flex;gap:16px;align-items:flex-start}
.pl-editor-col{flex:1;min-width:0;display:flex;flex-direction:column;gap:12px}
.pl-text{width:100%;box-sizing:border-box;height:30px;padding:0 8px;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;font-family:inherit}
.pl-text:focus{border-color:var(--dsw-alias-state-business-primary);outline:none}
.pl-preview{margin:0;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:11.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,Consolas,monospace;max-height:320px;overflow:auto}
.pl-row-inline{display:flex;gap:8px}
.pl-row-inline > *{flex:1;min-width:0}
.pl-conflict{border-left:3px solid var(--dsw-alias-state-error-primary);padding:10px 12px;margin:0 14px 10px;background:var(--dsw-alias-bg-layer-2);border-radius:8px;font-size:12px}
.pl-modal-mask{position:fixed;inset:0;z-index:200;background:rgba(0,0,0,.42);display:flex;align-items:center;justify-content:center}
.pl-modal{width:min(460px,92vw);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l3);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:8px;box-shadow:var(--dsw-elevation-prominent,0 8px 28px rgba(0,0,0,.22))}
.pl-modal h3{margin:0;font-size:14px}
.pl-modal-path{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all}
.pl-modal-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}

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
      /** 'list' | 'detail' | 'fill' — the popup shows one of them at a time. */
      const [mode, setMode] = useState("list");
      const [detailId, setDetailId] = useState(null);
      /** The parameter card's working state: which items, and what was typed. */
      const [fill, setFill] = useState(null);
      const rootRef = useRef(null);
      const inputRef = useRef(null);

      const close = useCallback(() => {
        pickerStore.set(false);
        noticeStore.set({ text: "", tone: "info", seq: 0 });
      }, []);

      /** Source labels the user has folded shut; a search ignores the folding. */
      const collapsed = Array.isArray(settings.collapsedSources) ? settings.collapsedSources : [];
      const toggleGroup = (label) => {
        updateSettings({
          collapsedSources: collapsed.includes(label)
            ? collapsed.filter((entry) => entry !== label)
            : [...collapsed, label],
        });
      };

      // Reset the transient interaction state every time the picker opens.
      useEffect(() => {
        if (!open) return;
        setQuery("");
        setSelected([]);
        setCursor(0);
        setMode("list");
        setDetailId(null);
        setFill(null);
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
            // Escape steps back one level before it closes the picker.
            if (mode !== "list") setMode("list");
            else close();
          } else if (event.key === "ArrowLeft" && mode === "detail") {
            // Only the detail view claims ArrowLeft: the parameter card has text
            // inputs where the key still means "move the caret".
            event.stopPropagation();
            setMode("list");
          }
        };
        document.addEventListener("mousedown", onPointerDown, true);
        document.addEventListener("keydown", onKeyDown, true);
        return () => {
          document.removeEventListener("mousedown", onPointerDown, true);
          document.removeEventListener("keydown", onKeyDown, true);
        };
      }, [open, close, mode]);

      const items = library.items ?? [];
      const filtered = useMemo(
        () => items.filter((item) => matchesQuery(item, query)),
        [items, query],
      );
      const suffixItem = useMemo(() => {
        const target = settings.alignTarget ?? "auto";
        if (target === "") return null;
        if (target !== "auto") return items.find((item) => item.id === target) ?? null;
        const first = (library.suffixIds ?? [])[0];
        return items.find((item) => item.id === first) ?? null;
      }, [items, settings.alignTarget, library.suffixIds]);
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

      /** Compose the chosen templates, with the parameter values applied. */
      const composeChosen = useCallback(
        (chosen, values, keepEmpty) => {
          const parts = chosen
            .map((item) => fillPlaceholders(bodyOf(item), values, keepEmpty))
            .filter((part) => part !== "");
          let text = parts.join("\n\n");
          if (settings.appendAlign && suffixItem !== null) {
            const tail = fillPlaceholders(bodyOf(suffixItem), values, keepEmpty);
            const alreadyThere = normalizeNewlines(text).includes(normalizeNewlines(tail));
            if (tail !== "" && text !== "" && !alreadyThere) {
              text = `${text.trimEnd()}\n\n${tail}`;
            }
          }
          return text;
        },
        [settings, suffixItem],
      );

      /** Insert the given items and close; report the clipboard outcome honestly. */
      const insertNow = useCallback(
        async (chosen, values, keepEmpty) => {
          const text = composeChosen(chosen, values, keepEmpty);
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
        [composeChosen, inputActions, close],
      );

      /**
       * Insert the chosen templates, or ask for the parameter values first when
       * they carry placeholders and the preference asks for the card.
       */
      const commit = useCallback(
        async (chosen) => {
          if (chosen.length === 0) return;
          const tokens = [];
          for (const item of chosen) {
            for (const token of item.placeholders ?? []) {
              if (!tokens.includes(token)) tokens.push(token);
            }
          }
          if (settings.fillParams === true && tokens.length > 0) {
            const values = {};
            for (const token of tokens) values[token] = "";
            setFill({
              ids: chosen.map((item) => item.id),
              values,
              keep: settings.keepEmptyPlaceholders !== false,
            });
            setMode("fill");
            return;
          }
          await insertNow(chosen, {}, true);
        },
        [settings, insertNow],
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

      const fillItems =
        fill === null
          ? []
          : fill.ids
              .map((id) => items.find((item) => item.id === id))
              .filter((item) => item !== undefined);

      /** The parameter card: one field per distinct placeholder, live preview. */
      const renderFill = () => {
        if (fill === null) return null;
        const values = fill.values;
        const tokens = Object.keys(values);
        const filledCount = tokens.filter((token) => String(values[token]).trim() !== "").length;
        const text = composeChosen(fillItems, values, fill.keep);
        // The preview reads the text with its placeholders still in it, so each
        // one can be shown as the value it will become.
        const preview = previewParts(composeChosen(fillItems, {}, true), values, fill.keep);
        const setValue = (token, value) =>
          setFill((prev) => (prev === null ? prev : { ...prev, values: { ...prev.values, [token]: value } }));
        return h(
          "div",
          {
            className: "pl-popup",
            "data-prompt-library": "popup",
            "data-mode": "fill",
            role: "dialog",
            "aria-label": "填写参数",
            ref: rootRef,
          },
          h(
            "div",
            { className: "pl-popup-head" },
            h(
              "button",
              {
                type: "button",
                className: "pl-icon-btn",
                title: "返回列表",
                onMouseDown: (event) => event.preventDefault(),
                onClick: () => setMode("list"),
              },
              "←",
            ),
            h("span", { className: "pl-row-title" }, "填写参数"),
            h("span", { className: "pl-hint" }, `${fillItems.length} 个模板 · ${tokens.length} 个参数`),
            h("span", { style: { flex: "1" } }),
          ),
          h(
            "div",
            { className: "pl-fill-grid" },
            h(
              "div",
              { className: "pl-fill-params" },
              tokens.length === 0
                ? h("div", { className: "pl-hint" }, "这些模板没有占位符。")
                : tokens.map((token) =>
                    h(
                      "label",
                      { className: "pl-param", key: token },
                      h("span", { className: "pl-param-label" }, `<${token}>`),
                      h("input", {
                        className: "pl-input",
                        type: "text",
                        value: values[token],
                        "aria-label": token,
                        onChange: (event) => setValue(token, event.target.value),
                      }),
                    ),
                  ),
            ),
            h(
              "div",
              { className: "pl-fill-preview" },
              h("div", { className: "pl-fill-preview-head" }, "同步预览"),
              h(
                "pre",
                { className: "pl-fill-pre" },
                preview.map((part, index) =>
                  part.token === undefined
                    ? part.text
                    : h(
                        "span",
                        { className: part.filled ? "pl-filled" : "pl-unfilled", key: index },
                        part.text,
                      ),
                ),
              ),
            ),
          ),
          h(
            "div",
            { className: "pl-view-foot" },
            h(
              "button",
              {
                type: "button",
                className: "pl-primary",
                onMouseDown: (event) => event.preventDefault(),
                onClick: () => void insertNow(fillItems, values, fill.keep),
              },
              "插入",
            ),
            h(
              "button",
              {
                type: "button",
                className: "pl-ghost",
                onClick: async () => {
                  const copied = await copyText(text);
                  notify(copied ? "已复制" : "复制失败", copied ? "success" : "error");
                },
              },
              "复制",
            ),
            h("span", { style: { flex: "1" } }),
            h(
              "label",
              { className: "pl-switch" },
              h("input", {
                type: "checkbox",
                checked: fill.keep === true,
                onChange: (event) =>
                  setFill((prev) => (prev === null ? prev : { ...prev, keep: event.target.checked })),
              }),
              h("span", null, "留空的参数保留原样"),
            ),
            h("span", { className: "pl-hint" }, `${filledCount}/${tokens.length}`),
          ),
        );
      };

      /** One template in full: every non-empty block, and nothing else. */
      const renderDetail = () => {
        const item = items.find((entry) => entry.id === detailId);
        if (item === undefined) return null;
        const blocks = [];
        if (item.summary !== "") {
          blocks.push(
            h(
              "div",
              { className: "pl-sec", key: "summary" },
              h("div", { className: "pl-sec-title" }, "一句话简介 · summary"),
              h("div", { className: "pl-summary" }, item.summary),
            ),
          );
        }
        if (item.detail !== "") {
          blocks.push(
            h(
              "div",
              { className: "pl-sec", key: "detail" },
              h("div", { className: "pl-sec-title" }, "详细解释 · detail"),
              h("div", { className: "pl-sec-body" }, h("div", { className: "pl-detail-text" }, item.detail)),
            ),
          );
        }
        if (item.source !== "") {
          blocks.push(
            h(
              "div",
              { className: "pl-sec", key: "source" },
              h("div", { className: "pl-sec-title" }, "出处 · source"),
              h("div", { className: "pl-detail-text" }, item.source),
            ),
          );
        }
        if (item.placeholder !== "") {
          blocks.push(
            h(
              "div",
              { className: "pl-sec", key: "placeholder" },
              h("div", { className: "pl-sec-title" }, "占位符 · placeholder"),
              h("div", { className: "pl-detail-text" }, item.placeholder),
            ),
          );
        }
        if ((item.placeholders ?? []).length > 0) {
          blocks.push(
            h(
              "div",
              { className: "pl-sec", key: "tokens" },
              h("div", { className: "pl-sec-title" }, "正文里的占位符"),
              h(
                "div",
                { className: "pl-chips" },
                item.placeholders.map((token) => h("span", { className: "pl-chip", key: token }, `<${token}>`)),
              ),
            ),
          );
        }
        if (item.body !== "") {
          blocks.push(
            h(
              "div",
              { className: "pl-sec", key: "body" },
              h("div", { className: "pl-sec-title" }, "正文"),
              h("div", { className: "pl-sec-body" }, h("pre", { className: "pl-body-pre" }, item.body)),
            ),
          );
        }
        return h(
          "div",
          {
            className: "pl-popup",
            "data-prompt-library": "popup",
            "data-mode": "detail",
            role: "dialog",
            "aria-label": "模板详情",
            ref: rootRef,
          },
          h(
            "div",
            { className: "pl-view-head" },
            h(
              "button",
              {
                type: "button",
                className: "pl-icon-btn",
                title: "返回列表",
                onMouseDown: (event) => event.preventDefault(),
                onClick: () => setMode("list"),
              },
              "←",
            ),
            h(
              "div",
              { style: { flex: "1", minWidth: "0" } },
              h("div", { className: "pl-view-title" }, item.title),
              h("div", { className: "pl-view-sub" }, `${item.sourceLabel} · ${item.file} · ${item.bytes} 字节`),
            ),
          ),
          h("div", { className: "pl-view-body" }, blocks),
          h(
            "div",
            { className: "pl-view-foot" },
            h(
              "button",
              {
                type: "button",
                className: "pl-primary",
                onMouseDown: (event) => event.preventDefault(),
                onClick: () => void commit([item]),
              },
              "插入",
            ),
            h(
              "button",
              {
                type: "button",
                className: "pl-ghost",
                onClick: async () => {
                  const copied = await copyText(bodyOf(item));
                  notify(copied ? "已复制" : "复制失败", copied ? "success" : "error");
                },
              },
              "复制正文",
            ),
            h("span", { style: { flex: "1" } }),
            h("span", { className: "pl-hint" }, item.kind === "suffix" ? "追加片段" : "普通模板"),
          ),
        );
      };

      if (mode === "fill") return renderFill();
      if (mode === "detail") return renderDetail();

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
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          const target = filtered[Math.max(0, activeIndex)];
          if (target !== undefined) {
            setDetailId(target.id);
            setMode("detail");
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
              title: "全部折叠 / 展开",
              "aria-label": "全部折叠或展开",
              onMouseDown: (event) => event.preventDefault(),
              onClick: () => {
                // Every source, not just the groups a search is currently
                // showing: "fold them all" has to mean all of them, or clearing
                // the search reveals groups that are still folded.
                const labels = (library.sources ?? []).map((source) => source.label);
                const allFolded =
                  labels.length > 0 && labels.every((label) => collapsed.includes(label));
                updateSettings({
                  collapsedSources: allFolded
                    ? collapsed.filter((label) => !labels.includes(label))
                    : Array.from(new Set([...collapsed, ...labels])),
                });
              },
            },
            (library.sources ?? []).length > 0 &&
            (library.sources ?? []).every((source) => collapsed.includes(source.label))
              ? "展开"
              : "折叠",
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
          groups.map((group) => {
            // A search always shows what it matched, however the user left the
            // group folded: folding is a rendering preference, and letting it
            // hide results turns it into a data-visibility switch.
            const folded = query === "" && collapsed.includes(group.label);
            return h(
              "div",
              { key: group.label },
              h(
                "button",
                {
                  type: "button",
                  className: "pl-group-title",
                  "aria-expanded": folded ? "false" : "true",
                  onMouseDown: (event) => event.preventDefault(),
                  onClick: () => toggleGroup(group.label),
                },
                h("span", { className: "pl-chev", "data-open": folded ? "false" : "true" }, "▾"),
                `${group.label} · ${group.items.length}`,
              ),
              folded
                ? null
                : group.items.map((item) => {
                    const index = filtered.indexOf(item);
                    const isSelected = selected.includes(item.id);
                    return h(
                      "div",
                      {
                        key: item.id,
                        className: "pl-row-wrap",
                        "data-active": index === activeIndex && !settings.multi ? "true" : "false",
                      },
                      h(
                        "button",
                        {
                          type: "button",
                          className: "pl-row",
                          title: item.path,
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
                          // The summary already holds the title position; a
                          // second description line is only useful when the
                          // summary is missing and the explanation is not.
                          item.summary === "" && item.detail !== ""
                            ? h("span", { className: "pl-row-note" }, item.detail.split("\n")[0])
                            : null,
                        ),
                        h(
                          "span",
                          { className: "pl-row-tags" },
                          item.kind === "suffix" ? h("span", { className: "pl-tag" }, "片段") : null,
                          (item.placeholders ?? []).length > 0
                            ? h(
                                "span",
                                { className: "pl-tag" },
                                `占位符 ${(item.placeholders ?? []).length}`,
                              )
                            : null,
                        ),
                      ),
                      // The ⓘ is a sibling of the row button: a button cannot be
                      // nested inside another button.
                      h(
                        "button",
                        {
                          type: "button",
                          className: "pl-info-btn",
                          title: "详情",
                          "aria-label": "详情",
                          onMouseDown: (event) => event.preventDefault(),
                          onClick: () => {
                            setDetailId(item.id);
                            setMode("detail");
                          },
                        },
                        "ⓘ",
                      ),
                    );
                  }),
            );
          }),
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
      const sources = library.sources ?? [];
      const filtered = useMemo(
        () => items.filter((item) => matchesQuery(item, query)),
        [items, query],
      );
      const active = useMemo(
        () => filtered.find((item) => item.id === activeId) ?? filtered[0] ?? null,
        [filtered, activeId],
      );
      const suffixItem = useMemo(
        () => items.find((item) => item.id === (library.suffixIds ?? [])[0]) ?? null,
        [items, library.suffixIds],
      );
      const suffixItems = useMemo(() => items.filter((item) => item.kind === "suffix"), [items]);

      // The picker and this page share one transient notice line; render it here
      // as well, or a failed copy on this page reports nothing at all.
      const noticeLine =
        notice.text !== ""
          ? h("div", { className: "pl-notice", "data-tone": notice.tone }, notice.text)
          : null;

      /**
       * Copy this template: its body, or the whole file with the comment.
       *
       * Neither copy appends the align fragment — that belongs to inserting into
       * the composer, and a copy that silently added a sentence the user did not
       * select would be a different action under the same name.
       */
      const copyActive = async (withHeader) => {
        if (active === null) return;
        let text;
        if (!withHeader) {
          text = bodyOf(active);
        } else {
          // The catalog no longer carries the whole file, so the raw text is read
          // for this one file, at the moment it is actually asked for.
          const result = await callRoute("read", { path: active.path });
          if (!result.ok || result.data === null) {
            notify("无法读取这个文件", "error");
            return;
          }
          text = result.data.raw;
        }
        const copied = await copyText(text);
        notify(copied ? "已复制" : "复制失败", copied ? "success" : "error");
      };

      /* ---- Editor ---------------------------------------------------- */

      /** What the form currently holds, and the version it was loaded from. */
      const [editor, setEditor] = useState(null);
      /** A 409 waiting for the user to choose reload or overwrite. */
      const [conflict, setConflict] = useState(null);
      /** The delete confirmation, which has to come before the file is gone. */
      const [pendingDelete, setPendingDelete] = useState(null);

      const patchEditor = (patch) => setEditor((prev) => (prev === null ? prev : { ...prev, ...patch }));
      const patchField = (key, value) =>
        setEditor((prev) => (prev === null ? prev : { ...prev, fields: { ...prev.fields, [key]: value } }));

      /** The file the form currently describes. */
      const composedText = (state) => buildTemplateText(state.fields, state.body, state.extra);

      const versionOf = (data) => ({ bytes: data.bytes, mtimeMs: data.mtimeMs, sha256: data.sha256 });

      const applyLoaded = (state, data) => {
        const parsed = parseTemplate(data.raw);
        return {
          ...state,
          originalRaw: data.raw,
          original: { fields: parsed.fields, body: parsed.body },
          fields: parsed.fields,
          body: parsed.body,
          extra: parsed.extra,
          version: versionOf(data),
        };
      };

      /** Read from disk before editing: the catalog may be minutes old. */
      const openEditor = async (item) => {
        const result = await callRoute("read", { path: item.path });
        if (!result.ok || result.data === null) {
          notify("无法读取这个文件", "error");
          return;
        }
        setConflict(null);
        setEditor(
          applyLoaded({ mode: "edit", item, path: item.path, sourceKey: item.sourceKey }, result.data),
        );
      };

      /** A brand-new template: same form, no version to compare against. */
      const openCreator = () => {
        setConflict(null);
        setEditor({
          mode: "create",
          sourceKey: sources[0]?.key ?? "",
          subdir: "",
          name: "",
          fields: { summary: "", detail: "", source: "", placeholder: "", kind: "prompt" },
          extra: [],
          body: "",
        });
      };

      const saveEditor = async (state, version) => {
        if (state.mode === "create") {
          const result = await callRoute("create", {
            sourceKey: state.sourceKey,
            subdir: state.subdir,
            name: state.name,
            text: composedText(state),
          });
          if (!result.ok) {
            notify(
              result.status === 409 ? "同名文件已经存在" : `新建失败（HTTP ${result.status}）`,
              "error",
            );
            return;
          }
          notify("已新建", "success");
          setEditor(null);
          await refreshQuietly();
          return;
        }
        // When no field changed, keep the comment exactly as it was and swap only
        // the body. Regenerating it would drop every line the form does not
        // understand, and reformat a comment the user never touched.
        const fieldsChanged =
          state.original === undefined ||
          !META_FIELDS.every((key) => state.original.fields[key] === state.fields[key]);
        const text =
          state.originalRaw === undefined || fieldsChanged
            ? composedText(state)
            : `${state.originalRaw.slice(
                0,
                state.originalRaw.length - state.original.body.length,
              )}${state.body}`;
        const result = await callRoute("write", {
          path: state.path,
          text,
          expectedBytes: version.bytes,
          expectedMtimeMs: version.mtimeMs,
          expectedSha256: version.sha256,
        });
        if (result.status === 409) {
          setConflict({ state, disk: result.data ?? null });
          return;
        }
        if (!result.ok) {
          notify(`保存失败（HTTP ${result.status}）`, "error");
          return;
        }
        notify("已保存", "success");
        setEditor(null);
        await refreshQuietly();
      };

      const reloadFromDisk = async () => {
        if (conflict === null) return;
        const result = await callRoute("read", { path: conflict.state.path });
        if (!result.ok || result.data === null) {
          notify("无法重新载入磁盘版本", "error");
          return;
        }
        setEditor(applyLoaded(conflict.state, result.data));
        setConflict(null);
        notify("已载入磁盘上的版本", "info");
      };

      const overwriteWithMine = async () => {
        if (conflict === null || conflict.disk === null) return;
        const state = conflict.state;
        setConflict(null);
        await saveEditor(state, conflict.disk);
      };

      const askDelete = async (item) => {
        const result = await callRoute("read", { path: item.path });
        if (!result.ok || result.data === null) {
          notify("无法读取这个文件", "error");
          return;
        }
        setPendingDelete({ item, bytes: result.data.bytes, git: result.data.git });
      };

      const doDelete = async () => {
        if (pendingDelete === null) return;
        const result = await callRoute("remove", { path: pendingDelete.item.path });
        if (!result.ok) {
          notify(
            result.status === 403 ? "文件被标记为只读，未删除" : `删除失败（HTTP ${result.status}）`,
            "error",
          );
          return;
        }
        notify("已删除", "success");
        setPendingDelete(null);
        setActiveId(null);
        await refreshQuietly();
      };

      const renameActive = async (item, name) => {
        const result = await callRoute("rename", { path: item.path, name });
        if (!result.ok) {
          notify(
            result.status === 409 ? "同名文件已经存在" : `重命名失败（HTTP ${result.status}）`,
            "error",
          );
          return;
        }
        notify("已重命名", "success");
        await refreshQuietly();
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
              h("span", { className: "pl-label" }, "写入"),
              h(
                "div",
                { className: "pl-hint" },
                library.writable === false
                  ? "写能力已关闭，库页面只读。"
                  : "可以在库页面编辑、新建、重命名、删除模板。删除直接生效，不进入回收站。",
              ),
            ),
            h(
              "div",
              { className: "pl-field" },
              h("span", { className: "pl-label" }, "插入行为"),
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
                "div",
                { className: "pl-field" },
                h("span", { className: "pl-label" }, "追加哪一个片段"),
                h(
                  "select",
                  {
                    className: "pl-select",
                    value: settings.alignTarget ?? "auto",
                    onChange: (event) => updateSettings({ alignTarget: event.target.value }),
                  },
                  h("option", { value: "auto" }, "自动 —— 第一个声明 kind: suffix 的模板"),
                  h("option", { value: "" }, "不追加"),
                  h(
                    "optgroup",
                    { label: "已声明为片段" },
                    suffixItems.map((item) =>
                      h("option", { key: item.id, value: item.id }, `${item.sourceLabel} / ${item.file}`),
                    ),
                  ),
                  h(
                    "optgroup",
                    { label: "全部模板" },
                    items.map((item) =>
                      h("option", { key: item.id, value: item.id }, `${item.sourceLabel} / ${item.file}`),
                    ),
                  ),
                ),
              ),
              h(
                "label",
                { className: "pl-switch" },
                h("input", {
                  type: "checkbox",
                  checked: settings.fillParams === true,
                  onChange: (event) => updateSettings({ fillParams: event.target.checked }),
                }),
                h("span", null, "含占位符的模板：插入前弹出参数卡片"),
              ),
              h(
                "label",
                { className: "pl-switch" },
                h("input", {
                  type: "checkbox",
                  checked: settings.keepEmptyPlaceholders === true,
                  onChange: (event) => updateSettings({ keepEmptyPlaceholders: event.target.checked }),
                }),
                h("span", null, "留空的参数保留 <占位符> 原样"),
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

      /** The 409 choice, offered as a decision rather than a wall. */
      const conflictPanel =
        conflict === null
          ? null
          : h(
              "div",
              { className: "pl-conflict" },
              h("div", null, "磁盘上的文件在你这轮编辑期间被改过了。"),
              h(
                "div",
                { className: "pl-hint" },
                `你打开编辑时的版本：${editor?.version?.bytes ?? "?"} 字节 · 磁盘上的当前版本：${conflict.disk?.bytes ?? "?"} 字节`,
              ),
              h(
                "div",
                { style: { display: "flex", gap: "8px", marginTop: "8px", flexWrap: "wrap" } },
                h(
                  "button",
                  { type: "button", className: "pl-ghost", onClick: () => void reloadFromDisk() },
                  "重新载入磁盘版本（丢弃我的改动）",
                ),
                h(
                  "button",
                  { type: "button", className: "pl-primary", onClick: () => void overwriteWithMine() },
                  "仍然覆盖",
                ),
              ),
            );

      /** The delete confirmation. Cancelling is the focused control, not deleting. */
      const deleteModal =
        pendingDelete === null
          ? null
          : h(
              "div",
              { className: "pl-modal-mask" },
              h(
                "div",
                { className: "pl-modal", role: "dialog", "aria-label": "删除确认" },
                h("h3", null, "删除这个模板？"),
                h("div", { className: "pl-modal-path" }, pendingDelete.item.path),
                h(
                  "div",
                  { className: "pl-hint" },
                  `${pendingDelete.bytes} 字节 · ${pendingDelete.item.title}`,
                ),
                h("div", { className: "pl-hint" }, "文件会被直接删除，不进入回收站。"),
                pendingDelete.git === null
                  ? h("div", { className: "pl-hint" }, "这个文件不在 git 工作树里，删除后无法用 git 恢复。")
                  : h(
                      "div",
                      { className: "pl-hint" },
                      "如果这个文件已被 git 跟踪，可以用下面的命令恢复到 git 里最后一次提交的版本；删除前未提交的改动无法恢复：",
                      h("div", { className: "pl-path" }, pendingDelete.git.command),
                    ),
                h(
                  "div",
                  { className: "pl-modal-foot" },
                  h(
                    "button",
                    {
                      type: "button",
                      className: "pl-ghost",
                      autoFocus: true,
                      onClick: () => setPendingDelete(null),
                    },
                    "取消",
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      className: "pl-ghost pl-danger",
                      onClick: () => void doDelete(),
                    },
                    "删除",
                  ),
                ),
              ),
            );

      if (editor !== null) {
        const isCreate = editor.mode === "create";
        const preview = isCreate ? buildTemplateText(editor.fields, editor.body) : composedText(editor);
        const textField = (label, key, placeholder) =>
          h(
            "div",
            { className: "pl-field", key },
            h("span", { className: "pl-label" }, label, " ", h("code", null, `${key}:`)),
            h("input", {
              className: "pl-text",
              type: "text",
              value: editor.fields[key],
              placeholder,
              onChange: (event) => patchField(key, event.target.value),
            }),
          );
        return h(
          "div",
          { className: "pl-page", "data-dsh-prompt-library-view": "" },
          head,
          h(
            "div",
            { className: "pl-editor" },
            h(
              "div",
              { className: "pl-editor-col" },
              isCreate
                ? h(
                    "div",
                    { className: "pl-field" },
                    h("span", { className: "pl-label" }, "新建到"),
                    h(
                      "select",
                      {
                        className: "pl-select",
                        value: editor.sourceKey,
                        onChange: (event) => patchEditor({ sourceKey: event.target.value }),
                      },
                      sources.map((source) =>
                        h("option", { key: source.key, value: source.key }, source.label),
                      ),
                    ),
                    h(
                      "div",
                      { className: "pl-row-inline" },
                      h("input", {
                        className: "pl-text",
                        type: "text",
                        value: editor.subdir,
                        placeholder: "子目录（可留空）",
                        onChange: (event) => patchEditor({ subdir: event.target.value }),
                      }),
                      h("input", {
                        className: "pl-text",
                        type: "text",
                        value: editor.name,
                        placeholder: "NN-kebab-slug.md",
                        onChange: (event) => patchEditor({ name: event.target.value }),
                      }),
                    ),
                    h(
                      "div",
                      { className: "pl-hint" },
                      "只能新建在已扫描到的来源目录里；文件名约定 NN-kebab-slug.md。",
                    ),
                  )
                : h(
                    "div",
                    { className: "pl-field" },
                    h("span", { className: "pl-label" }, "文件"),
                    h("div", { className: "pl-hint" }, editor.path),
                  ),
              textField("一句话简介", "summary", "功能做完了、要判断能不能算数的时候用"),
              h(
                "div",
                { className: "pl-field" },
                h("span", { className: "pl-label" }, "详细解释 ", h("code", null, "detail:")),
                h("textarea", {
                  className: "pl-textarea",
                  value: editor.fields.detail,
                  onChange: (event) => patchField("detail", event.target.value),
                }),
              ),
              textField("出处", "source", "自编"),
              textField("占位符说明", "placeholder", "<被审对象>、<真路径>"),
              h(
                "div",
                { className: "pl-field" },
                h("span", { className: "pl-label" }, "类型"),
                h(
                  "select",
                  {
                    className: "pl-select",
                    value: editor.fields.kind,
                    onChange: (event) => patchField("kind", event.target.value),
                  },
                  h("option", { value: "prompt" }, "普通模板"),
                  h("option", { value: "suffix" }, "追加片段"),
                ),
              ),
              h(
                "div",
                { className: "pl-field" },
                h("span", { className: "pl-label" }, "正文"),
                h("textarea", {
                  className: "pl-textarea",
                  "data-body": "true",
                  value: editor.body,
                  onChange: (event) => patchEditor({ body: event.target.value }),
                }),
              ),
              h(
                "div",
                { style: { display: "flex", gap: "8px" } },
                h(
                  "button",
                  {
                    type: "button",
                    className: "pl-primary",
                    onClick: () => void saveEditor(editor, editor.version),
                  },
                  isCreate ? "新建" : "保存",
                ),
                h(
                  "button",
                  {
                    type: "button",
                    className: "pl-ghost",
                    onClick: () => {
                      setEditor(null);
                      setConflict(null);
                    },
                  },
                  "取消",
                ),
              ),
            ),
            h(
              "div",
              { className: "pl-editor-col" },
              h(
                "div",
                { className: "pl-field" },
                h("span", { className: "pl-label" }, "生成的文件头注释"),
                h("pre", { className: "pl-preview" }, buildHeadComment(editor.fields, editor.extra) || "（没有字段，不生成注释）"),
              ),
              h(
                "div",
                { className: "pl-field" },
                h("span", { className: "pl-label" }, "完整文件预览"),
                h("pre", { className: "pl-preview" }, preview),
              ),
            ),
          ),
          conflictPanel,
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
              h(
                "div",
                { style: { display: "flex", gap: "6px" } },
                library.writable === false
                  ? h("span", { className: "pl-hint" }, "写能力已关闭")
                  : h(
                      "button",
                      { type: "button", className: "pl-ghost", onClick: openCreator },
                      "新建",
                    ),
                library.writable === false || active === null
                  ? null
                  : h(
                      "button",
                      {
                        type: "button",
                        className: "pl-ghost",
                        onClick: () => {
                          const next = window.prompt("新的文件名（只改同一目录下的文件名）", active.file);
                          if (next !== null && next.trim() !== "" && next.trim() !== active.file) {
                            void renameActive(active, next.trim());
                          }
                        },
                      },
                      "重命名",
                    ),
              ),
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
                    h(
                      "div",
                      { className: "pl-pathrow" },
                      h("span", { className: "pl-path" }, active.path),
                      h(
                        "button",
                        {
                          type: "button",
                          className: "pl-ghost",
                          onClick: async () => {
                            const result = await callRoute("reveal", { path: active.path });
                            notify(
                              result.ok ? "已在文件管理器中定位" : "无法定位",
                              result.ok ? "success" : "error",
                            );
                          },
                        },
                        "在文件夹中显示",
                      ),
                      h(
                        "button",
                        {
                          type: "button",
                          className: "pl-ghost",
                          onClick: async () => {
                            const result = await callRoute("open", { path: active.path });
                            notify(
                              result.ok ? "已用默认程序打开" : "无法打开",
                              result.ok ? "success" : "error",
                            );
                          },
                        },
                        "用默认程序打开",
                      ),
                      h(
                        "button",
                        {
                          type: "button",
                          className: "pl-ghost",
                          onClick: async () => {
                            const ok = await copyText(active.path);
                            notify(ok ? "路径已复制" : "复制失败", ok ? "success" : "error");
                          },
                        },
                        "复制路径",
                      ),
                    ),
                    active.detail !== ""
                      ? h("div", { className: "pl-hint" }, active.detail)
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
                    active.body,
                  ),
                  h(
                    "div",
                    { className: "pl-detail-foot", key: "foot" },
                    h(
                      "button",
                      {
                        type: "button",
                        className: "pl-primary",
                        onClick: () => void copyActive(false),
                      },
                      h(IconCopy, { size: 13 }),
                      "复制正文",
                    ),
                    h(
                      "button",
                      {
                        type: "button",
                        className: "pl-ghost",
                        onClick: () => void copyActive(true),
                      },
                      "复制（含注释头）",
                    ),
                    library.writable === false
                      ? h("span", { className: "pl-hint" }, "写能力已关闭，库页面只读")
                      : h(
                          "button",
                          {
                            type: "button",
                            className: "pl-ghost",
                            onClick: () => void openEditor(active),
                          },
                          "编辑",
                        ),
                    library.writable === false
                      ? null
                      : h(
                          "button",
                          {
                            type: "button",
                            className: "pl-ghost pl-danger",
                            onClick: () => void askDelete(active),
                          },
                          "删除",
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
          deleteModal,
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
