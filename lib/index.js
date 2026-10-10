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
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

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
  read: "/api/dsh-prompt-library/read",
  write: "/api/dsh-prompt-library/write",
  create: "/api/dsh-prompt-library/create",
  rename: "/api/dsh-prompt-library/rename",
  remove: "/api/dsh-prompt-library/delete",
  reveal: "/api/dsh-prompt-library/reveal",
  open: "/api/dsh-prompt-library/open",
};

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
};

/** Refuse to slurp anything absurd; prompt templates are a few KB. */
const MAX_FILE_BYTES = 512 * 1024;

/**
 * Largest JSON body a write route will parse.
 *
 * The Host's `/api` bridge already buffers requests under its own ceiling, but a
 * route cannot name that ceiling from here. This is defence in depth, not the
 * primary limit.
 */
const MAX_BODY_BYTES = 1024 * 1024;

/** Only these extensions are templates — for reading and for every write. */
const TEMPLATE_FILE = /\.(md|markdown)$/i;

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

/**
 * Stems of files that live beside templates but are not templates.
 *
 * Matched on the stem rather than the whole name, so `README.markdown` is
 * covered as well as `README.md`.
 */
const SKIP_STEMS = new Set(["readme", "index", "_index"]);

/** Whether a file name is a maintenance document rather than a template. */
function isReservedName(name) {
  return SKIP_STEMS.has(String(name).replace(TEMPLATE_FILE, "").toLowerCase());
}

/**
 * Characters that must never reach a file name: C0 controls, and the Unicode
 * bidirectional formatting characters, which let `x\u202etxt.md` render as
 * `xdm.txt` in any list that shows the name.
 */
const UNSAFE_NAME = /[\u0000-\u001f\u202a-\u202e\u2066-\u2069]/;

/** Conventional project-level prompt directories, relative to a workspace. */
const PROJECT_SUBDIRS = ["docs/prompts", "prompts", ".dsh/prompts"];

/**
 * Han, kana and Hangul — a placeholder written for a human reader.
 */
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
 * straight into the composer, so the unterminated form loses its first line as
 * well. Whatever follows that line stays in the body: it cannot be told apart
 * from real content, and dropping it would make the template disappear from the
 * catalog instead — the lesser of the two failures, but worth knowing.
 */
function splitHeadComment(raw) {
  const closed = /^\uFEFF?\s*<!--([\s\S]*?)-->[ \t]*\r?\n?/.exec(raw);
  if (closed !== null) return { meta: closed[1], body: raw.slice(closed[0].length) };
  const open = /^\uFEFF?[ \t]*<!--([^\n]*)\r?\n?/.exec(raw);
  if (open !== null) return { meta: open[1], body: raw.slice(open[0].length) };
  return { meta: "", body: raw };
}

/**
 * Collapse a block of text to a single trimmed line.
 *
 * The cut counts code points, not UTF-16 units: slicing units can split a
 * surrogate pair and put a lone `\uD83D` into the catalog.
 */
function collapse(text, max = 240) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  const points = Array.from(flat);
  return points.length > max ? `${points.slice(0, max - 1).join("")}…` : flat;
}

/**
 * Head-comment labels. English is the documented spelling; the Chinese labels
 * earlier templates shipped stay recognised so old files keep working.
 *
 * `kind` is the only one that changes behaviour: it is the explicit declaration
 * that a file is an append-only fragment, replacing the file-name guess that
 * turned `03-tail-recursion.md` into a fragment and made renaming a file change
 * its type.
 */
const META_LABELS = new Map([
  ["summary", "summary"],
  ["detail", "detail"],
  ["source", "source"],
  ["placeholder", "placeholder"],
  ["kind", "kind"],
  ["用途", "summary"],
  ["来源", "source"],
  ["占位符", "placeholder"],
]);

/**
 * Split a head comment into labelled fields plus the text that carries no label.
 *
 * Free text must survive even when labels are present. The shipped align
 * fragment is exactly
 * `<!-- 放在任何任务提示词的结尾。\nkind: suffix -->`, and a parser that reads
 * only labelled lines drops the one sentence that is the whole fragment.
 *
 * Continuation lines join with a newline under `detail` — its multi-line shape
 * is the point — and with a space under every other label.
 */
function parseMetaFields(meta) {
  const rawLines = String(meta ?? "").split(/\r?\n/);
  // Text that follows `<!--` on the same line is separated from the marker by
  // one space, not indented: `<!-- 用途：x` has to read as a label at column 0.
  if (rawLines[0].trim() !== "") rawLines[0] = rawLines[0].trimStart();
  // Dedent the block: a comment written inside an indented context still has its
  // labels at column 0 afterwards, while `detail`'s deeper continuation lines
  // keep the indentation that marks them as continuations.
  const indents = rawLines
    .filter((line) => line.trim() !== "")
    .map((line) => line.match(/^[ \t]*/)[0].length);
  const base = indents.length === 0 ? 0 : Math.min(...indents);

  const fields = {};
  const free = [];
  let current = null;
  for (const rawLine of rawLines) {
    const line = rawLine.slice(base);
    if (line.trim() === "") {
      // A blank line inside `detail` separates paragraphs; dropping it merged
      // paragraphs the author had kept apart.
      if (current === "detail" && fields.detail !== undefined && fields.detail !== "") {
        fields.detail += "\n";
      }
      continue;
    }
    const indented = /^[ \t]/.test(line);
    // Only a line at column 0 opens a label. An indented line is a continuation,
    // so `kind: suffix` written inside `detail:` stays part of the explanation
    // instead of silently turning an ordinary template into a fragment that is
    // appended to every insertion.
    const labelled = indented ? null : /^([^：:\s][^：:]{0,15})\s*[：:]\s*(.*)$/.exec(line);
    const key = labelled === null ? undefined : META_LABELS.get(labelled[1].trim().toLowerCase());
    if (key !== undefined) {
      current = key;
      const value = labelled[2].trim();
      // A single-valued label takes the last declaration: joining two `kind:`
      // lines produced "suffix suffix" and silently demoted the fragment.
      const append = key !== "kind" && fields[key] !== undefined && fields[key] !== "";
      fields[key] = append ? `${fields[key]} ${value}` : value;
      continue;
    }
    const value = line.trim();
    // An indented line continues the open field, and so does any line under
    // `detail` — an explanation is the one field that reads as prose. Every
    // other unlabelled line is free text: appending it to the previous label
    // used to corrupt that label's value and lose the text.
    if (current !== null && (indented || current === "detail")) {
      fields[current] =
        fields[current] === undefined || fields[current] === ""
          ? value
          : `${fields[current]}${current === "detail" ? "\n" : " "}${value}`;
      continue;
    }
    free.push(value);
  }
  if (typeof fields.detail === "string") fields.detail = fields.detail.replace(/\n+$/, "");
  return { fields, free };
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
  const { fields, free } = parseMetaFields(meta);
  const stem = basename(file).replace(TEMPLATE_FILE, "");
  const { order, slug } = splitOrder(stem);
  const placeholders = detectPlaceholders(body);

  // A comment with no labels at all is prose: its first line is the summary and
  // the rest is the explanation. Once any label appears, unlabelled text is the
  // summary's fallback instead of a second detail block, so a one-line note
  // written above `kind:` still reaches the list.
  const labelled = Object.keys(fields).length > 0;
  let summary;
  let detail;
  if (labelled) {
    const declared = collapse(fields.summary ?? "", 240);
    detail = String(fields.detail ?? "").trim();
    if (declared !== "") {
      summary = declared;
      // Unlabelled prose that has no summary slot to fill is still the author's
      // text; keep it in the explanation rather than dropping it.
      if (free.length > 0) {
        detail = [detail, free.join("\n")].filter((part) => part !== "").join("\n");
      }
    } else {
      summary = collapse(free.join(" "), 240);
    }
  } else {
    summary = collapse(free[0] ?? "", 240);
    detail = free.slice(1).join("\n");
  }

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
    title: summary === "" ? slug : summary,
    summary,
    detail,
    source: collapse(fields.source ?? "", 160),
    placeholder: collapse(fields.placeholder ?? "", 160),
    placeholders,
    // The type comes from the declaration alone; the file name is never
    // consulted, so renaming a template cannot change what it is.
    kind: String(fields.kind ?? "").trim().toLowerCase() === "suffix" ? "suffix" : "prompt",
    bytes,
    body: body.trim(),
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
async function listTemplateFiles(dir, prefix = "", depth = 0, visited = new Set(), budget = null, rootReal = null) {
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
      // A link is followed — that is how a `link:`-installed skill is reached —
      // but only while it stays inside this source. A junction planted inside a
      // source and pointing elsewhere would otherwise put files into the catalog
      // that the read route then refuses, while the catalog had already handed
      // out their text.
      if (rootReal !== null && entry.isSymbolicLink() && !isInside(rootReal, identity)) continue;
      if (visited.has(identity)) continue;
      visited.add(identity);
      files.push(...(await listTemplateFiles(child, relative, depth + 1, visited, budget, rootReal)));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!/\.(md|markdown)$/i.test(entry.name)) continue;
    if (isReservedName(entry.name)) continue;
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
      // `ignoreBOM: true` keeps a leading byte-order mark in the text instead of
      // dropping it, so `raw` describes the same bytes that `bytes` and `sha256`
      // count. Without it, saving an untouched file silently deleted the mark.
      raw: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer),
      bytes: buffer.byteLength,
      // The digest of the bytes on disk. Size plus timestamp cannot tell "the
      // file the editor read" from "a file that was changed and had its
      // timestamp put back"; a digest can.
      sha256: digest(buffer),
    };
  } catch {
    return null;
  }
}

/** Scan one source directory into catalog items. */
async function scanSource(source, budget) {
  const items = [];
  // Seed the walk with the root's real path so a link pointing back at the root
  // is recognised immediately instead of re-walking it once per level, and so
  // every link below can be checked against the source it must stay inside.
  const sourceReal = await realIdentity(source.dir);
  const visited = new Set([sourceReal]);
  for (const file of await listTemplateFiles(source.dir, "", 0, visited, budget, sourceReal)) {
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
/* Write path                                                          */
/* ------------------------------------------------------------------ */

/**
 * Whether `child` is strictly below `parent`; both are real absolute paths.
 *
 * The comparison is an exact prefix followed by a separator, not
 * `path.relative`. Two reasons:
 *
 * 1. `relative` folds case on Windows, so `C:\root\SRC` and `C:\root\src`
 *    compare equal — on a per-directory case-sensitive Windows directory those
 *    are two different places, and a write could land in the wrong one.
 *    `realpath` already returns the real spelling, so an exact prefix is right.
 * 2. `relative` returns `..foo\inner.md` for a *sibling* directory literally
 *    named `..foo`; testing `rel.startsWith("..")` refused a path that is
 *    genuinely inside the source.
 */
function isInside(parent, child) {
  const base = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  return child.startsWith(base);
}

/**
 * The real path of `absolutePath`, resolving every ancestor that exists and
 * keeping the names that do not exist yet.
 *
 * `realpath` cannot answer for a file that is about to be created, but the
 * containment check still has to see through a linked directory, so the answer
 * is the real path of the deepest existing ancestor plus the remaining names.
 *
 * @returns `{ real, missing }`, or `null` when no ancestor resolves at all.
 */
async function realOfNearestExisting(absolutePath) {
  let current = absolutePath;
  const missing = [];
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      return { real: await realpath(current), missing };
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      missing.unshift(basename(current));
      current = parent;
    }
  }
  return null;
}

/** A plain file name for a template, or `null` when it is anything else. */
function safeLeafName(value) {
  if (typeof value !== "string") return null;
  // Never silently rewrite what the caller asked for: a name with padding is
  // rejected so that the name validated is exactly the name created.
  if (value === "" || value !== value.trim()) return null;
  const leaf = value;
  if (leaf === "." || leaf === "..") return null;
  // A leading dot is invisible to the scanner, so accepting one would create a
  // template the library can never show.
  if (leaf.startsWith(".")) return null;
  // `:` opens an NTFS alternate data stream: `C:x.md` creates a zero-byte file
  // named `C` and puts the text in a stream, so the validated name would not be
  // the object written.
  if (leaf.includes(":")) return null;
  if (leaf.includes("/") || leaf.includes("\\")) return null;
  // NTFS caps one name at 255 UTF-16 units; past that `writeFile` fails with
  // ENOENT and the route would answer 500 for what is a bad name.
  if (leaf.length > 255) return null;
  if (UNSAFE_NAME.test(leaf)) return null;
  // Windows refuses these outright; letting them through made `writeFile` fail
  // with ENOENT and the route answer 500 for what is really a bad name.
  if (process.platform === "win32" && /[|?*"<>]/.test(leaf)) return null;
  if (process.platform === "win32" && /[. ]$/.test(leaf)) return null;
  if (!TEMPLATE_FILE.test(leaf)) return null;
  if (isReservedName(leaf)) return null;
  return leaf;
}

/**
 * A relative subdirectory below a source, as its parts, or `null` when it is
 * not one.
 *
 * Refusing `..`, a leading separator, a drive prefix and a colon here keeps the
 * shape of the request honest; containment is still decided afterwards on real
 * paths, so this is the readable half of the rule rather than the load-bearing
 * half.
 */
function safeSubdir(value) {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value !== "string") return null;
  if (value !== value.trim()) return null;
  const raw = value.replace(/\\/g, "/");
  if (raw === "") return [];
  if (raw.startsWith("/")) return null;
  if (raw.includes(":")) return null;
  if (UNSAFE_NAME.test(raw)) return null;
  const parts = raw.split("/");
  for (const part of parts) {
    if (part === "" || part === "." || part === "..") return null;
    // The scanner skips every dot-prefixed entry, so a hidden directory would
    // accept a file that the catalog can never show: the same trap as a
    // dot-prefixed file name, one level up.
    if (part.startsWith(".")) return null;
    if (part.length > 255) return null;
    if (process.platform === "win32" && /[|?*"<>]/.test(part)) return null;
    if (process.platform === "win32" && /[. ]$/.test(part)) return null;
  }
  return parts;
}

/**
 * Locate a template inside the scanned sources, or say why it cannot be one.
 *
 * Every rule is applied to the *real* path, so a link or junction that leaves
 * its source is refused, and the value handed back is the real path: callers
 * never operate on a path that only looks contained.
 *
 * @returns `{ source, realPath, exists }`, or `{ status, reason }`.
 */
async function locateTarget(sources, rawPath) {
  if (typeof rawPath !== "string") return { status: 400, reason: "invalid path" };
  const normalized = scannablePath(rawPath);
  if (normalized === null) return { status: 400, reason: "invalid path" };
  const absolutePath = resolve(normalized);
  const leaf = basename(absolutePath);
  if (!TEMPLATE_FILE.test(leaf)) return { status: 400, reason: "not a template file" };
  if (isReservedName(leaf)) return { status: 400, reason: "reserved file name" };
  const nearest = await realOfNearestExisting(absolutePath);
  if (nearest === null) return { status: 400, reason: "invalid path" };
  const realPath = nearest.missing.length === 0 ? nearest.real : join(nearest.real, ...nearest.missing);
  for (const source of sources) {
    if (isInside(await realIdentity(source.dir), realPath)) {
      return { source, realPath, exists: nearest.missing.length === 0 };
    }
  }
  return { status: 403, reason: "outside every scanned source" };
}

/** Read a request body as a JSON object, bounded before it is parsed. */
async function readJsonBody(request) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return { status: 413 };
  let buffer;
  try {
    buffer = Buffer.from(await request.arrayBuffer());
  } catch {
    return { status: 400 };
  }
  // Count bytes, not UTF-16 units: a 1.2 MB CJK body is only ~400k code units,
  // and measuring units let it straight through the cap.
  if (buffer.byteLength > MAX_BODY_BYTES) return { status: 413 };
  try {
    const value = JSON.parse(buffer.toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) return { status: 400 };
    return { value };
  } catch {
    return { status: 400 };
  }
}

/** The line ending a file already uses, so saving does not rewrite every line. */
function detectEol(text) {
  return String(text).includes("\r\n") ? "\r\n" : "\n";
}

/** Text with every line ending reduced to `\n`, for comparison only. */
function normalizeEol(text) {
  return String(text).replace(/\r\n?/g, "\n");
}

/** Re-express text in one line ending, whatever the editor sent. */
function applyEol(text, eol) {
  const normalized = normalizeEol(text);
  return eol === "\r\n" ? normalized.replace(/\n/g, "\r\n") : normalized;
}

/** The content digest used to pin a save to the bytes the editor was shown. */
function digest(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** `stat`, or `null` when the path is not there. */
async function statOrNull(path) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

/**
 * Run one write operation at a time per directory.
 *
 * The version check is compare-then-act, and two operations can collide on a
 * *name* rather than on a file: a rename onto `X` and a create of `X` lock
 * different paths if each locks only its own file, so both passed their checks
 * and one silently overwrote the other. The directory is the thing that holds
 * the name, so the directory is the lock.
 */
const writeChains = new Map();

/** The lock key for a target path: the directory that owns its name. */
function lockKey(target) {
  return dirname(target);
}

function serializeByPath(key, run) {
  const previous = writeChains.get(key) ?? Promise.resolve();
  const current = previous.then(run, run);
  const settled = current.then(
    () => {},
    () => {},
  );
  writeChains.set(key, settled);
  settled.then(() => {
    if (writeChains.get(key) === settled) writeChains.delete(key);
  });
  return current;
}

/**
 * Replace a file's contents atomically: write a sibling temp file, then rename
 * it over the target. A failure mid-write leaves the original intact instead of
 * truncated.
 *
 * The temp name starts with a dot, which the scanner skips, so a stranded temp
 * file never shows up in the catalog.
 */
async function writeAtomic(target, text) {
  const temp = join(
    dirname(target),
    `.${basename(target)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  await writeFile(temp, text, { encoding: "utf8", flag: "wx" });
  try {
    await rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

/**
 * Walk up from a file to the repository that tracks it.
 *
 * This is a read-only `stat` probe: no git binary, no child process, no network,
 * so it behaves the same on a machine that has no git installed. A `.git` *file*
 * counts as well as a directory — that is the shape of a worktree and of a
 * submodule checkout.
 *
 * @returns the repository root, or `null` when the file is not in a work tree.
 */
async function findGitToplevel(realPath) {
  let current = dirname(realPath);
  for (;;) {
    const marker = join(current, ".git");
    try {
      const info = await stat(marker);
      if (info.isDirectory()) return current;
      // A worktree or a submodule keeps a `.git` *file* whose only content is
      // `gitdir: <path>`. Checking that one line costs a small read and stops a
      // file that merely happens to be called `.git` from being offered as a
      // repository whose recovery command cannot work.
      if (info.isFile()) {
        const head = await readFile(marker, "utf8").catch(() => "");
        if (head.startsWith("gitdir:")) return current;
      }
    } catch {
      /* no `.git` here; keep walking up */
    }
    const parent = dirname(current);
    // `dirname` shortens strictly, so the drive root ends the walk. A depth
    // limit is unnecessary, and it produced "cannot be recovered" for a deeply
    // nested file that git could in fact restore.
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * How the file could be restored after deletion, or `null` when nothing can.
 * The command is composed for the confirmation to show; it is never executed.
 */
async function recoveryFor(realPath) {
  const toplevel = await findGitToplevel(realPath);
  if (toplevel === null) return null;
  const inside = relative(toplevel, realPath).split("\\").join("/");
  return { toplevel, command: `git -C "${toplevel}" checkout -- "${inside}"` };
}

/**
 * Start a desktop handler and stop caring about it.
 *
 * `spawn` takes an argument vector and no shell, so the path reaches the program
 * as one argument: a file name containing `%VAR%`, `&` or a quote cannot be
 * re-parsed by a command interpreter. Nothing waits for the child, and the
 * Explorer exit code (1 on success) is never read as failure.
 */
function spawnDetached(command, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { detached: true, stdio: "ignore" });
    } catch {
      resolve(false);
      return;
    }
    // `spawn` reports a missing program asynchronously. Answering "ok" as soon
    // as the call returned told the user a window had opened even when the
    // program did not exist at all.
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

/** A command line shown back to the user, quoted so it can be pasted. */
function displayCommand(command, args) {
  const quote = (value) => `"${String(value).replace(/"/g, '\\"')}"`;
  return [command, ...args].map(quote).join(" ");
}

/** The platform's "show in folder" invocation. */
function revealCommand(target) {
  if (process.platform === "win32") return { command: "explorer.exe", args: [`/select,${target}`] };
  if (process.platform === "darwin") return { command: "open", args: ["-R", target] };
  return { command: "xdg-open", args: [dirname(target)] };
}

/** The platform's "open with the default application" invocation. */
function openCommand(target) {
  if (process.platform === "win32") return { command: "explorer.exe", args: [target] };
  if (process.platform === "darwin") return { command: "open", args: [target] };
  return { command: "xdg-open", args: [target] };
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

  const writable = config?.allowWrite !== false;
  const denyWrite = () => jsonResponse(403, { error: "writing is disabled" });

  /** The scan parameters every route reads, shared with the list route. */
  const sourcesFor = async (request) => {
    const url = new URL(request.url);
    const requestDirs = (url.searchParams.get("dirs") ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    return collectSources(ctx, {
      cwdParam: url.searchParams.get("cwd") ?? undefined,
      configDirs,
      requestDirs,
    });
  };

  /** One route, with the failure policy every route shares. */
  const route = (path, handler, methods = ["POST"]) => ({
    path,
    methods,
    requestBody: "buffered",
    fetch: async (request) => {
      try {
        return await handler(request);
      } catch (error) {
        // The detail belongs in the Host log; the caller gets a status, not a
        // filesystem path quoted back out of the message.
        warn(error);
        return jsonResponse(500, { error: "internal error" });
      }
    },
  });

  /** The body of a JSON POST, or the response that says why it is unusable. */
  const bodyOf = async (request) => {
    const parsed = await readJsonBody(request);
    if (parsed.status !== undefined) {
      return { response: jsonResponse(parsed.status, { error: "unusable request body" }) };
    }
    return { body: parsed.value };
  };

  /**
   * Resolve a request's `path` against the scanned sources and require that it
   * names an existing template file.
   */
  const locateForRoute = async (request, body) => {
    if (body === null || typeof body.path !== "string") {
      return { response: jsonResponse(400, { error: "path is required" }) };
    }
    const found = await locateTarget(await sourcesFor(request), body.path);
    if (found.status !== undefined) {
      return { response: jsonResponse(found.status, { error: found.reason }) };
    }
    const info = await statOrNull(found.realPath);
    if (info === null || !info.isFile()) {
      return { response: jsonResponse(404, { error: "template not found" }) };
    }
    return { found, info };
  };

  const routes = [
    route(ROUTES.health, async () => jsonResponse(200, { ok: true, plugin: name }), ["GET"]),
    route(
      ROUTES.list,
      async (request) => {
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

        const suffixIds = items
          .filter((item) => item.kind === "suffix")
          .map((item) => item.id);
        return jsonResponse(200, {
          plugin: name,
          cwd: cwdParam ?? null,
          truncated: budget.truncated,
          writable,
          sources: sources.map((source) => ({
            key: source.key,
            label: source.label,
            kind: source.kind,
            dir: source.dir,
            count: items.filter((item) => item.sourceKey === source.key).length,
          })),
          items,
          suffixIds,
        });
      },
      ["GET"],
    ),
    route(ROUTES.read, async (request) => {
      const parsed = await bodyOf(request);
      if (parsed.response !== undefined) return parsed.response;
      const located = await locateForRoute(request, parsed.body);
      if (located.response !== undefined) return located.response;
      const loaded = await readTemplate(located.found.realPath);
      if (loaded === null) return jsonResponse(422, { error: "template is not readable text" });
      return jsonResponse(200, {
        raw: loaded.raw,
        bytes: loaded.bytes,
        mtimeMs: located.info.mtimeMs,
        sha256: loaded.sha256,
        eol: detectEol(loaded.raw),
        // Shown in the delete confirmation, which has to come before the file
        // is gone.
        git: await recoveryFor(located.found.realPath),
      });
    }),
    route(ROUTES.write, async (request) => {
      if (!writable) return denyWrite();
      const parsed = await bodyOf(request);
      if (parsed.response !== undefined) return parsed.response;
      const body = parsed.body;
      if (typeof body.text !== "string") return jsonResponse(400, { error: "text is required" });
      // Refuse to write what the reader would refuse to read: a larger file
      // would drop out of the catalog and become impossible to open again.
      if (Buffer.byteLength(body.text, "utf8") > MAX_FILE_BYTES) {
        return jsonResponse(413, { error: "the text is larger than this plugin can read back" });
      }
      const { expectedBytes, expectedMtimeMs, expectedSha256 } = body;
      // Types are checked, not coerced: `Number(null)` is 0 and `Number(true)`
      // is 1, so coercion let values that name no version take part in the
      // comparison.
      if (
        typeof expectedBytes !== "number" ||
        !Number.isFinite(expectedBytes) ||
        typeof expectedMtimeMs !== "number" ||
        !Number.isFinite(expectedMtimeMs) ||
        typeof expectedSha256 !== "string"
      ) {
        return jsonResponse(400, { error: "expected version is required" });
      }
      const located = await locateForRoute(request, body);
      if (located.response !== undefined) return located.response;
      return serializeByPath(lockKey(located.found.realPath), async () => {
        const current = await readTemplate(located.found.realPath);
        if (current === null) {
          const present = await statOrNull(located.found.realPath);
          return present === null
            ? jsonResponse(404, { error: "template not found" })
            : jsonResponse(422, { error: "template is not readable text" });
        }
        // Re-read the version after loading, so the comparison describes the
        // bytes that were actually seen rather than an earlier stat.
        const disk = await stat(located.found.realPath);
        if (
          disk.size !== expectedBytes ||
          disk.mtimeMs !== expectedMtimeMs ||
          current.sha256 !== expectedSha256
        ) {
          return jsonResponse(409, {
            error: "the file changed on disk",
            bytes: disk.size,
            mtimeMs: disk.mtimeMs,
            // The caller needs a complete version to retry with, or "overwrite
            // anyway" has nothing valid to send and can never succeed.
            sha256: current.sha256,
          });
        }
        // A save that changes nothing must not rewrite the file. The editor
        // hands back LF-normalized text, so converting it would rewrite every
        // line of a file whose endings are mixed even though nobody edited it.
        const text =
          normalizeEol(current.raw) === normalizeEol(body.text)
            ? current.raw
            : applyEol(body.text, detectEol(current.raw));
        try {
          await writeAtomic(located.found.realPath, text);
        } catch (error) {
          if (error?.code === "EPERM" || error?.code === "EACCES" || error?.code === "EROFS") {
            return jsonResponse(403, { error: "the file cannot be written" });
          }
          throw error;
        }
        const info = await stat(located.found.realPath);
        return jsonResponse(200, { ok: true, bytes: info.size, mtimeMs: info.mtimeMs });
      });
    }),
    route(ROUTES.create, async (request) => {
      if (!writable) return denyWrite();
      const parsed = await bodyOf(request);
      if (parsed.response !== undefined) return parsed.response;
      const body = parsed.body;
      if (typeof body.text !== "string") return jsonResponse(400, { error: "text is required" });
      if (Buffer.byteLength(body.text, "utf8") > MAX_FILE_BYTES) {
        return jsonResponse(413, { error: "the text is larger than this plugin can read back" });
      }
      const leaf = safeLeafName(body.name);
      if (leaf === null) return jsonResponse(400, { error: "invalid file name" });
      const parts = safeSubdir(body.subdir);
      if (parts === null) return jsonResponse(400, { error: "invalid subdirectory" });
      const sources = await sourcesFor(request);
      const source = sources.find((entry) => entry.key === body.sourceKey);
      if (source === undefined) return jsonResponse(400, { error: "unknown source" });
      const found = await locateTarget(sources, join(source.dir, ...parts, leaf));
      if (found.status !== undefined) {
        return jsonResponse(found.status, { error: found.reason });
      }
      return serializeByPath(lockKey(found.realPath), async () => {
        if ((await statOrNull(found.realPath)) !== null) {
          return jsonResponse(409, { error: "a file with that name already exists" });
        }
        const parentInfo = await statOrNull(dirname(found.realPath));
        if (parentInfo === null || !parentInfo.isDirectory()) {
          return jsonResponse(400, { error: "the target directory does not exist" });
        }
        try {
          // `wx` refuses to replace anything that appeared between the checks.
          await writeFile(found.realPath, applyEol(body.text, "\n"), {
            encoding: "utf8",
            flag: "wx",
          });
        } catch (error) {
          if (error?.code === "EEXIST") {
            return jsonResponse(409, { error: "a file with that name already exists" });
          }
          throw error;
        }
        const sourceReal = await realIdentity(found.source.dir);
        return jsonResponse(200, {
          path: found.realPath,
          id: `${found.source.key}/${relative(sourceReal, found.realPath).split("\\").join("/")}`,
        });
      });
    }),
    route(ROUTES.rename, async (request) => {
      if (!writable) return denyWrite();
      const parsed = await bodyOf(request);
      if (parsed.response !== undefined) return parsed.response;
      const leaf = safeLeafName(parsed.body.name);
      if (leaf === null) return jsonResponse(400, { error: "invalid file name" });
      const located = await locateForRoute(request, parsed.body);
      if (located.response !== undefined) return located.response;
      const target = join(dirname(located.found.realPath), leaf);
      const sourceReal = await realIdentity(located.found.source.dir);
      const relativePath = relative(sourceReal, located.found.realPath).split("\\").join("/");
      const folder = relativePath.includes("/")
        ? relativePath.slice(0, relativePath.lastIndexOf("/"))
        : "";
      const id = `${located.found.source.key}/${folder === "" ? leaf : `${folder}/${leaf}`}`;
      return serializeByPath(lockKey(located.found.realPath), async () => {
        if (target === located.found.realPath) {
          return jsonResponse(200, { path: target, id });
        }
        const existing = await statOrNull(target);
        // A case-only rename names the same file on a case-insensitive volume;
        // refusing it made `x.md` → `X.md` impossible. A different file is a
        // genuine collision.
        if (existing !== null && (await realIdentity(target)) !== located.found.realPath) {
          return jsonResponse(409, { error: "a file with that name already exists" });
        }
        try {
          await rename(located.found.realPath, target);
        } catch (error) {
          if (error?.code === "ENOENT") return jsonResponse(404, { error: "template not found" });
          if (error?.code === "EPERM" || error?.code === "EACCES") {
            return jsonResponse(403, { error: "the file cannot be renamed" });
          }
          throw error;
        }
        return jsonResponse(200, { path: target, id });
      });
    }),
    route(ROUTES.remove, async (request) => {
      if (!writable) return denyWrite();
      const parsed = await bodyOf(request);
      if (parsed.response !== undefined) return parsed.response;
      const located = await locateForRoute(request, parsed.body);
      if (located.response !== undefined) return located.response;
      // The read-only attribute is the user saying "do not change this". libuv
      // clears it and retries, so without this check the delete simply succeeds.
      if ((located.info.mode & 0o200) === 0) {
        return jsonResponse(403, { error: "the file is marked read-only" });
      }
      return serializeByPath(lockKey(located.found.realPath), async () => {
        try {
          await unlink(located.found.realPath);
        } catch (error) {
          if (error?.code === "ENOENT") return jsonResponse(404, { error: "template not found" });
          if (error?.code === "EPERM" || error?.code === "EACCES") {
            return jsonResponse(403, { error: "the file cannot be deleted" });
          }
          throw error;
        }
        return jsonResponse(200, { ok: true });
      });
    }),
    route(ROUTES.reveal, async (request) => {
      const parsed = await bodyOf(request);
      if (parsed.response !== undefined) return parsed.response;
      const located = await locateForRoute(request, parsed.body);
      if (located.response !== undefined) return located.response;
      const spec = revealCommand(located.found.realPath);
      const ok = await spawnDetached(spec.command, spec.args);
      return jsonResponse(ok ? 200 : 500, { ok, command: displayCommand(spec.command, spec.args) });
    }),
    route(ROUTES.open, async (request) => {
      const parsed = await bodyOf(request);
      if (parsed.response !== undefined) return parsed.response;
      const located = await locateForRoute(request, parsed.body);
      if (located.response !== undefined) return located.response;
      const spec = openCommand(located.found.realPath);
      const ok = await spawnDetached(spec.command, spec.args);
      return jsonResponse(ok ? 200 : 500, { ok, command: displayCommand(spec.command, spec.args) });
    }),
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
