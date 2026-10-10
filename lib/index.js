/**
 * dsh-prompt-library — host half.
 *
 * Turns prompt-template directories into one JSON catalog the Web GUI can
 * browse and insert from. Three source families are scanned:
 *
 * 1. skill asset directories — `<DSH_HOME>/skills/<skill>/assets/prompts`
 *    (and the same shape under `DSH_AGENTS_HOME`), which is where a distilled
 *    skill keeps its user-voice prompt templates;
 * 2. project directories — `<cwd>/docs/prompts`, `<cwd>/prompts`,
 *    `<cwd>/.dsh/prompts` for every active session workspace;
 * 3. user directories — the plugin's own `dirs` config plus the `dirs` the
 *    browser sends (the panel's editable list).
 *
 * These routes read the user's files and hand back their contents, so they are
 * mounted on the Host's own trust fence rather than beside it: the routes are
 * exact Fetch routes on the shared `/api` channel, which the Host serves behind
 * `ctx.connection.admit()`. See `inject` below.
 *
 * The module owns no cross-plugin state and registers nothing model-facing.
 */
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

/** Stable cordis plugin name. */
export const name = "prompt-library";

/**
 * Services required before the catalog routes can mount.
 *
 * `connection` is deliberately a hard dependency, not an optional lookup. It
 * owns the Host/Origin fence and browser authentication, and
 * `ctx.connection.fetch.register` mounts an exact Fetch route *inside* the
 * `/api` channel that the Host already wraps in `connection.admit()`.
 *
 * Mounting on `ctx.webServer` instead would be a trust bug: an exact route wins
 * over the Host's `/api` prefix handler, so the route would run before the
 * admission gate and answer any process that can reach the loopback port.
 */
export const inject = ["connection"];

/** Route paths (the client bundle mirrors these literals). */
const ROUTES = {
  list: "/api/dsh-prompt-library/list",
  health: "/api/dsh-prompt-library/health",
};

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
};

/** Refuse to slurp anything absurd; prompt templates are a few KB. */
const MAX_FILE_BYTES = 512 * 1024;

/** How many `?dirs=` entries one request may contribute. */
const MAX_REQUEST_DIRS = 32;

/** How deep below a source root nested template directories are walked. */
const MAX_SCAN_DEPTH = 3;

/**
 * How many directories one request may walk, and how many items it may return.
 *
 * The `?dirs=` cap bounds the number of *roots*, not the size of the tree behind
 * them: one root such as `C:\Windows` is ~51k directories and 8–20 s of
 * `readdir`, and 32 such roots would be millions of calls in a single request.
 * Exceeding either budget stops the scan and reports `truncated` in the response
 * rather than failing silently.
 */
const MAX_WALK_DIRS = 4000;
const MAX_ITEMS = 2000;

/** Files that live beside templates but are not templates. */
const SKIP_FILES = new Set(["readme.md", "index.md", "_index.md"]);

/** Conventional project-level prompt directories, relative to a workspace. */
const PROJECT_SUBDIRS = ["docs/prompts", "prompts", ".dsh/prompts"];

/**
 * Slug fragments that mark an append-only fragment rather than a whole prompt.
 * `.` counts as a boundary because `01.align.md` is an ordinary way to name the
 * fragment once the order separator is optional.
 */
const SUFFIX_SLUG = /(^|[-_. ])(align|suffix|append|closing|footer|tail)([-_. ]|$)/i;

/** Han, kana and Hangul — a placeholder written for a human reader. */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/u;

/** `PROJECT_NAME`, `YOUR-NAME`, `FILE PATH` — a placeholder the user fills in. */
const SCREAMING = /^[A-Z][A-Z0-9_ -]*$/;

/** Zero-width marks and a BOM: invisible, but not whitespace to `trim()`. */
const INVISIBLE = /[\u200b-\u200d\u2060\ufeff]/g;

/**
 * Element names, so an upper-case HTML tag (`<DIV>`, `<BR/>`, `<A>`) is not
 * mistaken for a SCREAMING_CASE placeholder.
 */
const HTML_TAGS = new Set([
  "a", "abbr", "address", "area", "article", "aside", "audio", "b", "base", "bdi", "bdo",
  "blockquote", "body", "br", "button", "canvas", "caption", "cite", "code", "col", "colgroup",
  "data", "datalist", "dd", "del", "details", "dfn", "dialog", "div", "dl", "dt", "em", "embed",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
  "head", "header", "hgroup", "hr", "html", "i", "iframe", "img", "input", "ins", "kbd", "label",
  "legend", "li", "link", "main", "map", "mark", "menu", "meta", "meter", "nav", "noscript",
  "object", "ol", "optgroup", "option", "output", "p", "param", "picture", "pre", "progress", "q",
  "rp", "rt", "ruby", "s", "samp", "script", "section", "select", "slot", "small", "source",
  "span", "strong", "style", "sub", "summary", "sup", "table", "tbody", "td", "template",
  "textarea", "tfoot", "th", "thead", "time", "title", "tr", "track", "u", "ul", "var", "video",
  "wbr", "svg", "path", "g", "circle", "rect", "line", "polygon", "polyline", "text", "defs", "use",
]);

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

/** One JSON response for the shared `/api` Fetch channel. */
function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/* ------------------------------------------------------------------ */
/* Path safety                                                         */
/* ------------------------------------------------------------------ */

/**
 * Normalize a caller-supplied directory path, or return `null` when it is not a
 * local absolute directory path we are willing to stat.
 *
 * Refused: UNC shares (`\\host\share`, `//host/share`), Win32 device
 * namespaces (`\\?\C:\…`, `\\.\NUL`), relative paths, and anything carrying a
 * control character. `stat` on a UNC path makes the Host open an outbound SMB
 * connection to a host the requester chose — a request-hanging primitive, and
 * on Windows a credential-leak one — while a relative path would resolve
 * against the Host's cwd instead of the caller's.
 *
 * The return value is what the caller must use. Windows silently drops trailing
 * dots and spaces from a path component, so validating `C:\x.` and then
 * resolving `C:\x.` is a check that does not describe the path actually opened.
 *
 * @returns the normalized path to use, or `null` to refuse.
 */
function scannablePath(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (raw === "") return null;
  if (/[\u0000-\u001f]/.test(raw)) return null;
  if (/^[\\/]{2}/.test(raw)) return null;
  if (process.platform === "win32") {
    if (!/^[A-Za-z]:[\\/]/.test(raw)) return null;
    if (raw.endsWith(".")) return null;
    return raw;
  }
  return raw.startsWith("/") ? raw : null;
}

/* ------------------------------------------------------------------ */
/* Template parsing                                                    */
/* ------------------------------------------------------------------ */

/**
 * Split the leading HTML comment block off a template file.
 *
 * A head comment that was never closed would otherwise leak its opening marker
 * and whatever the maintainer wrote inside it straight into the composer, so
 * the unterminated form loses its first line as well.
 */
function splitHeadComment(raw) {
  const closed = /^\uFEFF?\s*<!--([\s\S]*?)-->[ \t]*\r?\n?/.exec(raw);
  if (closed !== null) return { meta: closed[1], body: raw.slice(closed[0].length) };
  const open = /^\uFEFF?[ \t]*<!--([^\n]*)\r?\n?/.exec(raw);
  if (open !== null) return { meta: open[1], body: raw.slice(open[0].length) };
  return { meta: "", body: raw };
}

/** Collapse a block of text to a single trimmed line. */
function collapse(text, max = 240) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Parse the documented `用途：/来源：/占位符：` labels out of a head comment.
 * The shipped templates instead carry a free-text comment; that case yields an
 * empty object and the caller falls back to the whole comment as the note.
 */
function parseMetaFields(meta) {
  const LABELS = { 用途: "usage", 来源: "origin", 占位符: "placeholders" };
  const fields = {};
  let current = null;
  for (const line of meta.split(/\r?\n/)) {
    const labelled = /^\s*([^：:]{1,8})\s*[：:]\s*(.*)$/.exec(line);
    const key = labelled === null ? undefined : LABELS[labelled[1].trim()];
    if (key !== undefined) {
      current = key;
      fields[key] = labelled[2].trim();
      continue;
    }
    if (current !== null && line.trim() !== "") {
      fields[current] = `${fields[current]} ${line.trim()}`.trim();
    }
  }
  return fields;
}

/** Whether text carries nothing a user could actually insert. */
function isBlank(text) {
  return String(text ?? "").replace(INVISIBLE, "").trim() === "";
}

/** Whether `<inner>` names an HTML/SVG element rather than a placeholder. */
function isElementName(inner) {
  return HTML_TAGS.has(inner.replace(/^\/|\/$/g, "").toLowerCase());
}

/**
 * Placeholders the user is expected to replace: the documented `<中文说明>`
 * form plus the older bare `xxxxx` run kept verbatim in the 02 template.
 *
 * `<…>` only counts when it actually reads as a placeholder — a CJK
 * description or a SCREAMING_CASE name — and not when it names an element.
 * Markup (`<div>`, `<DIV>`, `</a>`, `<BR/>`), tag attributes (`<a href=x>`) and
 * autolinks (`<https://…>`) are not placeholders and used to surface as chips
 * the user could not act on.
 */
function detectPlaceholders(body) {
  const out = [];
  const seen = new Set();
  const push = (value) => {
    const token = String(value).trim();
    if (token === "" || seen.has(token) || out.length >= 24) return;
    seen.add(token);
    out.push(token);
  };
  for (const match of body.matchAll(/<([^<>\n]{1,60})>/gu)) {
    const inner = match[1].trim();
    if (inner.includes("://")) continue;
    if (isElementName(inner)) continue;
    if (!CJK.test(inner) && !SCREAMING.test(inner)) continue;
    push(inner);
  }
  for (const match of body.matchAll(/x{4,}/gu)) push(match[0]);
  return out;
}

/**
 * `01-align` → `{ order: 1, slug: 'align' }`; `01align` → the same order with
 * slug `align`; `1000-a` → order 1000; a stem with no leading number keeps 999.
 *
 * The separator used to be mandatory, so `01align.md`, `1000-a.md` and
 * `2026-10-09-x.md` all fell to order 999 and sorted to the end. The 4-digit
 * ceiling is guarded by a lookahead so a 5-digit name is not silently parsed as
 * its first four digits.
 */
function splitOrder(fileStem) {
  const match = /^(\d{1,4})(?![0-9])(.*)$/.exec(fileStem);
  if (match === null) return { order: 999, slug: fileStem };
  const rest = match[2].replace(/^[-_. ]+/, "");
  return { order: Number(match[1]), slug: rest === "" ? fileStem : rest };
}

/**
 * Build one catalog item.
 * @param file `/`-separated path relative to the source directory.
 * @param bytes exact size on disk, so the UI reports bytes rather than UTF-16
 *   code units (a 1.5 MB CJK file used to be reported as `524288`).
 */
function buildItem(source, file, absolutePath, raw, bytes) {
  const { meta, body } = splitHeadComment(raw);
  const fields = parseMetaFields(meta);
  const note = collapse(meta);
  const stem = basename(file).replace(/\.(md|markdown)$/i, "");
  const { order, slug } = splitOrder(stem);
  const placeholders = detectPlaceholders(body);
  const usage = collapse(fields.usage ?? "", 80);
  return {
    id: `${source.key}/${file}`,
    sourceKey: source.key,
    sourceLabel: source.label,
    sourceKind: source.kind,
    dir: source.dir,
    file,
    path: absolutePath,
    slug,
    order,
    title: usage !== "" ? usage : stem.replace(/[-_]+/g, " "),
    note,
    origin: collapse(fields.origin ?? "", 160),
    placeholderNote: collapse(fields.placeholders ?? "", 160),
    placeholders,
    // Classify on the file stem, not on the parsed slug: making the order
    // separator optional must not turn `01align.md` into a fragment. Only a real
    // word boundary before `align`/`suffix`/… marks an append-only fragment.
    kind: SUFFIX_SLUG.test(stem) ? "suffix" : "prompt",
    bytes,
    body: body.trim(),
    raw,
  };
}

/* ------------------------------------------------------------------ */
/* Filesystem scan                                                     */
/* ------------------------------------------------------------------ */

/** Whether a path exists and is a directory (follows symlinks and junctions). */
async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** The on-disk identity of a path, falling back to the path itself. */
async function realIdentity(path) {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/**
 * Immediate subdirectory names, or [] when the root is missing.
 *
 * A skill installed with `link:` — the plugin's own documented install shape —
 * shows up as a symlink or junction, and `Dirent.isDirectory()` reports those
 * as `isSymbolicLink`, so trusting it alone hid every prompt in the skill
 * without saying so. Real directories come first so the canonical name wins the
 * source label when a link and its target are both present.
 */
async function listSubdirectories(root) {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const real = [];
    const linked = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) {
        real.push(entry.name);
        continue;
      }
      if (entry.isSymbolicLink() && (await isDirectory(join(root, entry.name)))) {
        linked.push(entry.name);
      }
    }
    return [...real, ...linked];
  } catch {
    return [];
  }
}

/**
 * Template files under one directory as `/`-separated relative paths, README
 * and dotfiles excluded. Nested directories are walked to `MAX_SCAN_DEPTH`
 * because `docs/prompts/<topic>/*.md` is an ordinary way to file templates and
 * a flat listing made them disappear silently.
 *
 * `visited` holds the real paths of the directories already walked. Links are
 * followed — a `link:`-installed skill is a junction — but each real directory
 * is walked once, so a link to an ancestor cannot re-walk the tree at every
 * level and a link to a sibling cannot list the same file twice.
 *
 * `budget` is the request-wide directory allowance; when it runs out the walk
 * stops and marks itself truncated.
 */
async function listTemplateFiles(dir, prefix = "", depth = 0, visited = new Set(), budget = null) {
  if (depth > MAX_SCAN_DEPTH) return [];
  if (budget !== null) {
    if (budget.left <= 0) {
      budget.truncated = true;
      return [];
    }
    budget.left -= 1;
  }
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const child = join(dir, entry.name);
    const nested =
      entry.isDirectory() || (entry.isSymbolicLink() && (await isDirectory(child)));
    if (nested) {
      // Only a link needs `realpath`: a plain directory appears exactly once in
      // a tree walk, so its own path is its identity. A link is identified by
      // its target, which is what makes a link to an ancestor or to a sibling
      // resolve to a directory already in `visited`.
      const identity = entry.isSymbolicLink() ? await realIdentity(child) : child;
      if (visited.has(identity)) continue;
      visited.add(identity);
      files.push(...(await listTemplateFiles(child, relative, depth + 1, visited, budget)));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!/\.(md|markdown)$/i.test(entry.name)) continue;
    if (SKIP_FILES.has(entry.name.toLowerCase())) continue;
    files.push(relative);
  }
  return files.sort((a, b) => a.localeCompare(b, "en"));
}

/**
 * Read one template as strict UTF-8, or `null` when it must not be catalogued.
 *
 * The size cap is checked against `stat` *before* the read: "refuse to slurp
 * anything absurd" has to happen before the slurp, or a 256 MiB file is pulled
 * into memory and only then rejected.
 *
 * Decoding is strict. `readFile(path, "utf8")` silently replaces every byte it
 * cannot map with U+FFFD, so a GBK or Shift-JIS template used to reach the
 * composer as mojibake with nothing to indicate the loss.
 */
async function readTemplate(absolutePath) {
  let info;
  try {
    info = await stat(absolutePath);
  } catch {
    return null;
  }
  if (info.size > MAX_FILE_BYTES) return null;
  let buffer;
  try {
    buffer = await readFile(absolutePath);
  } catch {
    return null;
  }
  // The file may have grown between the stat and the read.
  if (buffer.byteLength > MAX_FILE_BYTES) return null;
  try {
    return {
      raw: new TextDecoder("utf-8", { fatal: true }).decode(buffer),
      bytes: buffer.byteLength,
    };
  } catch {
    return null;
  }
}

/** Scan one source directory into catalog items. */
async function scanSource(source, budget) {
  const items = [];
  // Seed the walk with the root's real path so a link pointing back at the root
  // is recognised immediately instead of re-walking it once per level.
  const visited = new Set([await realIdentity(source.dir)]);
  for (const file of await listTemplateFiles(source.dir, "", 0, visited, budget)) {
    const absolutePath = join(source.dir, file);
    const loaded = await readTemplate(absolutePath);
    if (loaded === null) continue;
    const item = buildItem(source, file, absolutePath, loaded.raw, loaded.bytes);
    // A template with nothing to insert would render as a row whose only effect
    // is to append the align fragment on its own.
    if (isBlank(item.body)) continue;
    items.push(item);
  }
  return items;
}

/** Resolve the DSH home the way the rest of the harness does. */
function resolveDshHome() {
  return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

/** Resolve the agents home the way the rest of the harness does. */
function resolveAgentsHome() {
  return process.env.DSH_AGENTS_HOME ?? join(homedir(), ".agents");
}

/** Every workspace cwd worth probing for a project-level prompt directory. */
function resolveWorkspaces(ctx, cwdParam) {
  const out = [];
  const push = (value) => {
    const normalized = scannablePath(value);
    if (normalized === null) return;
    out.push(resolve(normalized));
  };
  push(cwdParam);
  try {
    const sessions = typeof ctx.get === "function" ? ctx.get("sessions", false) : undefined;
    const listed =
      typeof sessions?.list === "function"
        ? sessions.list()
        : sessions?.list?.getSnapshot?.();
    if (Array.isArray(listed)) {
      for (const session of listed) push(session?.header?.cwd ?? session?.cwd);
    }
  } catch {
    /* a missing sessions service just means no project sources */
  }
  push(process.cwd());
  return [...new Set(out)];
}

/**
 * Collect every source directory to scan, deduplicated by real path.
 * Missing directories are silently dropped so a fresh install never errors.
 */
async function collectSources(ctx, { cwdParam, configDirs, requestDirs }) {
  const sources = [];
  const seen = new Set();

  const add = async (dir, label, kind, makeKey) => {
    const normalized = scannablePath(dir);
    if (normalized === null) return;
    const absolutePath = resolve(normalized);
    if (!(await isDirectory(absolutePath))) return;
    // Identity is the on-disk real path, compared exactly — never case-folded.
    // `realpath` returns the directory's real spelling, so two case-variant
    // names for the same directory collapse on a case-insensitive volume, while
    // two genuinely different directories that differ only in case (a
    // per-directory case-sensitive Windows directory, or a case-sensitive
    // volume) stay two.
    const identity = await realIdentity(absolutePath);
    if (seen.has(identity)) return;
    seen.add(identity);
    sources.push({ key: makeKey(identity), label, kind, dir: absolutePath });
  };

  const skillRoots = [
    [resolveDshHome(), "skill"],
    [resolveAgentsHome(), "agent-skill"],
  ];
  for (const [root, kind] of skillRoots) {
    for (const skill of await listSubdirectories(join(root, "skills"))) {
      await add(join(root, "skills", skill, "assets", "prompts"), skill, kind, () => `${kind}:${skill}`);
    }
  }

  for (const workspace of resolveWorkspaces(ctx, cwdParam)) {
    const name = basename(workspace) || workspace;
    for (const sub of PROJECT_SUBDIRS) {
      await add(join(workspace, sub), `${name}/${sub}`, "project", (canonical) => `project:${canonical}`);
    }
  }

  // Caller-supplied directories: refuse the raw value, because `resolve()` would
  // turn a relative path into a real directory under the Host's cwd and every
  // later check would pass. The count is capped so one request cannot turn the
  // scan into an unbounded number of directory walks.
  const custom = [];
  for (const dir of configDirs) {
    const normalized = scannablePath(dir);
    if (normalized !== null) custom.push(normalized);
  }
  let accepted = 0;
  for (const dir of requestDirs) {
    if (accepted >= MAX_REQUEST_DIRS) break;
    const normalized = scannablePath(dir);
    if (normalized === null) continue;
    accepted += 1;
    custom.push(normalized);
  }
  for (const dir of custom) {
    await add(dir, basename(dir) || dir, "custom", (canonical) => `custom:${canonical}`);
  }

  return sources;
}

/* ------------------------------------------------------------------ */
/* Plugin body                                                         */
/* ------------------------------------------------------------------ */

/**
 * Mount the prompt-library catalog routes.
 * @param ctx - host plugin context carrying `connection`.
 * @param config - resolved plugin config (`enabled`, `dirs`).
 */
export function apply(ctx, config = {}) {
  if (config?.enabled === false) return;
  const configDirs = Array.isArray(config?.dirs) ? config.dirs : [];
  const warn = (error) => {
    try {
      ctx.logger?.warn?.(error);
    } catch {
      /* logging must never break a request */
    }
  };

  const routes = [
    {
      path: ROUTES.health,
      methods: ["GET"],
      requestBody: "buffered",
      fetch: async () => jsonResponse(200, { ok: true, plugin: name }),
    },
    {
      path: ROUTES.list,
      methods: ["GET"],
      requestBody: "buffered",
      fetch: async (request) => {
        try {
          const url = new URL(request.url);
          const cwdParam = url.searchParams.get("cwd") ?? undefined;
          const requestDirs = (url.searchParams.get("dirs") ?? "")
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line !== "");

          const sources = await collectSources(ctx, {
            cwdParam,
            configDirs,
            requestDirs,
          });

          const budget = { left: MAX_WALK_DIRS, truncated: false };
          const found = [];
          for (const source of sources) {
            found.push(...(await scanSource(source, budget)));
            if (budget.truncated) break;
          }
          found.sort(
            (a, b) =>
              a.sourceLabel.localeCompare(b.sourceLabel, "zh") ||
              a.order - b.order ||
              a.file.localeCompare(b.file, "en"),
          );

          // One file can be reachable through more than one source — a parent
          // directory and its child, or a directory and a link to it — and the
          // same template twice would show up as two identical rows. Identity
          // follows the file's real path, and the sort order decides the winner.
          const items = [];
          const seenFiles = new Set();
          for (const item of found) {
            const identity = await realIdentity(item.path);
            if (seenFiles.has(identity)) continue;
            if (items.length >= MAX_ITEMS) {
              budget.truncated = true;
              break;
            }
            seenFiles.add(identity);
            items.push(item);
          }

          const suffix = items.find((item) => item.kind === "suffix");
          return jsonResponse(200, {
            plugin: name,
            cwd: cwdParam ?? null,
            truncated: budget.truncated,
            sources: sources.map((source) => ({
              key: source.key,
              label: source.label,
              kind: source.kind,
              dir: source.dir,
              count: items.filter((item) => item.sourceKey === source.key).length,
            })),
            items,
            suffixId: suffix?.id ?? null,
          });
        } catch (error) {
          // The detail belongs in the Host log; the caller gets a status, not a
          // filesystem path quoted back out of the message.
          warn(error);
          return jsonResponse(500, { error: "internal error" });
        }
      },
    },
  ];

  const connection = ctx.connection;
  if (connection === undefined || typeof connection.fetch?.register !== "function") {
    // Unreachable in a composed Host: `inject` names `connection`, so cordis
    // will not call `apply` without it. The check exists so that a composition
    // which wires the service late leaves the catalog absent rather than
    // mounting it somewhere the admission gate does not cover.
    warn(new Error("prompt-library: ctx.connection.fetch unavailable; routes not mounted"));
    return;
  }

  ctx.effect(() => {
    const disposers = [];
    for (const route of routes) {
      // One at a time: a throw from the second route must not strand the first
      // route's disposer, which would leave it mounted after teardown.
      try {
        disposers.push(connection.fetch.register(route));
      } catch (error) {
        warn(error);
      }
    }
    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* teardown is best-effort */
        }
      }
    };
  }, "prompt-library: catalog routes");
}
