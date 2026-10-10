/**
 * dsh-prompt-library — acceptance harness.
 *
 * Drives the real host half against the real prompt directories, then mounts
 * the real browser half in jsdom, clicks the trigger, and asserts the composed
 * text that reaches the composer's `inputActions.insertText`.
 */
import { JSDOM, VirtualConsole } from "jsdom";
import { readFileSync } from "node:fs";
import React from "react";
import { createRoot } from "react-dom/client";
import { auditStylesheet } from "./theme.mjs";

const PLUGIN_DIR = new URL("../", import.meta.url);
const host = await import(new URL("lib/index.js", PLUGIN_DIR).href);

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

/* ------------------------------------------------------------------ */
/* 1. Host half: mount, call the real route                            */
/* ------------------------------------------------------------------ */

const routes = [];
const hostCtx = {
  logger: { warn: (...args) => console.warn("[host]", ...args) },
  get: () => undefined,
  effect: (fn) => {
    fn();
  },
  // The catalog routes are exact Fetch routes on the Host's shared `/api`
  // channel. That channel is where the Host runs `connection.admit()`, so the
  // plugin registers here instead of on `webServer`, where an exact route would
  // answer ahead of the admission gate.
  connection: {
    fetch: {
      register: (route) => {
        routes.push(route);
        return () => {};
      },
    },
  },
};

host.apply(hostCtx, {});
check("host: registers its route family", routes.length === 2, routes.map((r) => r.path).join(", "));

async function callRoute(route, url) {
  const response = await route.fetch(new Request(`http://127.0.0.1:19387${url}`));
  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep the raw text */
  }
  return { status: response.status, body };
}

const listRoute = routes.find((r) => r.path === "/api/dsh-prompt-library/list");
const healthRoute = routes.find((r) => r.path === "/api/dsh-prompt-library/health");

const health = await callRoute(healthRoute, "/api/dsh-prompt-library/health");
check("host: health answers ok", health.status === 200 && health.body.ok === true);

// The non-loopback refusal used to be asserted here, against the plugin's own
// `isAllowed` fence. That fence is gone: the Host's `/api` admission gate now
// owns it, and this harness deliberately supplies no such gate.
const listed = await callRoute(listRoute, "/api/dsh-prompt-library/list");
check("host: list answers 200", listed.status === 200, `status ${listed.status}`);

const catalog = listed.body;
const items = catalog.items ?? [];
const byFile = new Map(items.map((item) => [item.file, item]));

check(
  "host: scans the vibe-coding skill prompt directory",
  items.length >= 4,
  `${items.length} items from ${(catalog.sources ?? []).length} sources`,
);
check(
  "host: excludes the maintenance README",
  !byFile.has("README.md"),
);
check(
  "host: 01-align is classified as a suffix fragment",
  byFile.get("01-align.md")?.kind === "suffix",
);
check(
  "host: suffixId resolves to the align fragment",
  catalog.suffixId === byFile.get("01-align.md")?.id,
  String(catalog.suffixId),
);
check(
  "host: strips the leading maintenance comment from the body",
  byFile.get("03-dev-plan-ui-preview.md")?.body.startsWith("按照之前的讨论结果") === true,
  JSON.stringify(byFile.get("03-dev-plan-ui-preview.md")?.body.slice(0, 20)),
);
check(
  "host: keeps the raw text with the comment",
  byFile.get("01-align.md")?.raw.startsWith("<!--") === true,
);
check(
  "host: detects the bare xxxxx placeholders in the 02 template",
  (byFile.get("02-kickoff-feasibility.md")?.placeholders ?? []).includes("xxxxx"),
  JSON.stringify(byFile.get("02-kickoff-feasibility.md")?.placeholders),
);
check(
  "host: keeps the free-text comment as the note",
  (byFile.get("04-project-docs.md")?.note ?? "").includes("项目文件夹建好后"),
  byFile.get("04-project-docs.md")?.note,
);
check(
  "host: orders 01 before 04",
  items.findIndex((i) => i.file === "01-align.md") < items.findIndex((i) => i.file === "04-project-docs.md"),
);

/* ------------------------------------------------------------------ */
/* 2. Browser half: jsdom + real React render                          */
/* ------------------------------------------------------------------ */

// React 18's legacy `input` event polyfill calls `attachEvent` on the focused
// element, which jsdom does not implement. It is a jsdom gap, not a plugin
// defect, and it would otherwise mask a real failure behind a non-zero exit.
const virtualConsole = new VirtualConsole();
virtualConsole.on("jsdomError", (error) => {
  if (/attachEvent|detachEvent/.test(String(error?.message ?? error))) return;
  console.error("[jsdom]", error);
});

const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
  virtualConsole,
});
const { window } = dom;
for (const key of [
  "window",
  "document",
  "navigator",
  "localStorage",
  "HTMLElement",
  "Element",
  "Node",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
]) {
  const value = window[key];
  if (value === undefined) continue;
  try {
    globalThis[key] = value;
  } catch {
    // `navigator` is a getter-only global on modern Node.
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let bundle = null;
window.__ModuleLoader__ = {
  load: (entry) => {
    bundle = entry;
  },
};

await import(new URL("lib/client.js", PLUGIN_DIR).href);
check("client: registers a module factory", bundle !== null && bundle.id === "dsh-prompt-library");

const reactModule = { ...React, default: React };
const clientExports = bundle.factory((request) => {
  if (request === "react") return reactModule;
  if (request === "react/jsx-runtime") return { jsx: () => null, jsxs: () => null };
  throw new Error(`unexpected require: ${request}`);
});
check("client: exports apply/inject", typeof clientExports.apply === "function" && Array.isArray(clientExports.inject));

const registered = [];
const clientCtx = {
  effect: (fn) => {
    fn();
  },
  slots: {
    inject: (_key, callback) => callback() ?? (() => {}),
    register: (spec, component) => {
      registered.push({ spec, component });
      return () => {};
    },
  },
};
clientExports.apply(clientCtx);

const slots = new Map(registered.map((entry) => [entry.spec.name, entry.component]));
check(
  "client: registers all four surfaces",
  slots.has("conversation.input.left") &&
    slots.has("conversation.input.overlay") &&
    slots.has("sidebar.panellist") &&
    slots.has("main"),
  [...slots.keys()].join(", "),
);

const fetches = [];
globalThis.fetch = async (url) => {
  fetches.push(String(url));
  return { ok: true, status: 200, json: async () => catalog };
};

const inserted = [];
const inputActions = {
  captureInsertion: () => ({ draftRev: 7, start: 0, end: 0 }),
  insertText: (text, span) => {
    inserted.push({ text, span });
    return true;
  },
};

const act = React.act ?? (async (fn) => fn());

const container = window.document.createElement("div");
window.document.body.appendChild(container);
const root = createRoot(container);

const Trigger = slots.get("conversation.input.left");
const Picker = slots.get("conversation.input.overlay");
const Page = slots.get("main");

await act(async () => {
  root.render(
    React.createElement(
      React.Fragment,
      null,
      React.createElement(Trigger, null),
      React.createElement(Picker, { inputActions }),
    ),
  );
});

const triggerButton = container.querySelector(".pl-trigger");
check("client: trigger button renders", triggerButton !== null);
check("client: popup is closed initially", container.querySelector(".pl-popup") === null);

await act(async () => {
  triggerButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
});
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

check("client: opening the trigger calls the host route", fetches.length === 1, fetches[0]);
const popup = container.querySelector(".pl-popup");
check("client: popup renders once open", popup !== null);

const rows = Array.from(container.querySelectorAll(".pl-row"));
check("client: popup lists every scanned template", rows.length === items.length, `${rows.length} rows`);
const rowTitles = rows.map((row) => row.querySelector(".pl-row-title")?.textContent);
check(
  "client: rows carry readable titles",
  rowTitles.some((title) => /dev plan ui preview/i.test(title ?? "")),
  rowTitles.join(" | "),
);
check(
  "client: the suffix fragment is tagged",
  Array.from(container.querySelectorAll(".pl-tag")).some((tag) => tag.textContent === "追加片段"),
);
check(
  "client: the footer advertises the auto-appended fragment",
  (container.querySelector(".pl-foot")?.textContent ?? "").includes("01-align") ||
    (container.querySelector(".pl-foot")?.textContent ?? "").includes("align"),
  container.querySelector(".pl-foot")?.textContent,
);

/* --- single pick: inserts body + appended align ------------------- */

const planRow = rows.find((row) =>
  /dev plan ui preview/i.test(row.querySelector(".pl-row-title")?.textContent ?? ""),
);
const planBody = byFile.get("03-dev-plan-ui-preview.md").body;
const alignBody = byFile.get("01-align.md").body;

await act(async () => {
  planRow.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
});

check("client: a single pick writes into the composer", inserted.length === 1);
check(
  "client: the inserted text is the stripped body",
  inserted[0]?.text.startsWith(planBody.slice(0, 20)),
  JSON.stringify(inserted[0]?.text.slice(0, 24)),
);
check(
  "client: the maintenance comment never reaches the composer",
  !inserted[0]?.text.includes("<!--"),
);
check(
  "client: the align fragment is appended once",
  inserted[0]?.text.trimEnd().endsWith(alignBody) &&
    inserted[0].text.split(alignBody).length === 2,
);
check("client: the popup closes after a pick", container.querySelector(".pl-popup") === null);

/* --- multi pick: no duplicate align ------------------------------- */

await act(async () => {
  triggerButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
});
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

const multiToggle = Array.from(container.querySelectorAll(".pl-icon-btn")).find(
  (button) => button.textContent === "多选",
);
await act(async () => {
  multiToggle.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
});

const rows2 = Array.from(container.querySelectorAll(".pl-row"));
const alignRow = rows2.find((row) =>
  /align/i.test(row.querySelector(".pl-row-title")?.textContent ?? ""),
);
const docsRow = rows2.find((row) =>
  /project docs/i.test(row.querySelector(".pl-row-title")?.textContent ?? ""),
);

await act(async () => {
  alignRow.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
});
await act(async () => {
  docsRow.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
});

const insertButton = Array.from(container.querySelectorAll(".pl-primary")).find((button) =>
  (button.textContent ?? "").startsWith("插入"),
);
check("client: multi mode exposes a batch insert button", insertButton !== undefined);
check(
  "client: multi mode reports the selection count",
  (container.querySelector(".pl-foot")?.textContent ?? "").includes("已选 2 条"),
  container.querySelector(".pl-foot")?.textContent,
);

await act(async () => {
  insertButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
});

check("client: a batch pick inserts once", inserted.length === 2);
const batch = inserted[1]?.text ?? "";
check(
  "client: the batch keeps the chosen order",
  batch.indexOf(alignBody) === 0,
  JSON.stringify(batch.slice(0, 24)),
);
check(
  "client: an align fragment already in the batch is never appended twice",
  batch.split(alignBody).length === 2,
  `align occurrences: ${batch.split(alignBody).length - 1}`,
);
check(
  "client: the batch keeps the docs template after the fragment",
  batch.trimEnd().endsWith(byFile.get("04-project-docs.md").body.trimEnd()),
);

/* --- the library page -------------------------------------------- */

const pageContainer = window.document.createElement("div");
window.document.body.appendChild(pageContainer);
const pageRoot = createRoot(pageContainer);
await act(async () => {
  pageRoot.render(React.createElement(Page, null));
});
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

check(
  "client: the library page lists the templates",
  pageContainer.querySelectorAll(".pl-row").length === items.length,
  `${pageContainer.querySelectorAll(".pl-row").length} rows`,
);
check(
  "client: the library page shows the source count",
  /个模板/.test(pageContainer.querySelector(".pl-hint")?.textContent ?? ""),
  pageContainer.querySelector(".pl-hint")?.textContent,
);

const docsPageRow = Array.from(pageContainer.querySelectorAll(".pl-row")).find((row) =>
  /project docs/i.test(row.querySelector(".pl-row-title")?.textContent ?? ""),
);
await act(async () => {
  docsPageRow.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
});
const preview = pageContainer.querySelector(".pl-pre")?.textContent ?? "";
check(
  "client: the library page previews the selected template",
  preview.startsWith(byFile.get("04-project-docs.md").body.slice(0, 20)),
  JSON.stringify(preview.slice(0, 24)),
);
check(
  "client: the library page shows the template path",
  (pageContainer.querySelector(".pl-detail-meta")?.textContent ?? "").includes("04-project-docs.md"),
);

/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 3. Theme contrast audit                                             */
/* ------------------------------------------------------------------ */

// DSH's alias palette inverts between themes, so a hardcoded colour cannot
// follow it. This section pins the whole stylesheet to token pairs that clear
// WCAG AA in both themes — it is the regression guard for the `#fff`-on-a-fill
// bug, which measured 1.05:1 in dark mode.
const clientSource = readFileSync(new URL("lib/client.js", PLUGIN_DIR), "utf8");
const cssMatch = /const CSS = `([\s\S]*?)`;/.exec(clientSource);
check("theme: the stylesheet is locatable in the bundle", cssMatch !== null);
const stylesheet = cssMatch?.[1] ?? "";

const audit = auditStylesheet(stylesheet);
check(
  "theme: every colour pair clears 4.5:1 in light and dark",
  audit.failures.length === 0,
  audit.failures.length === 0
    ? `${audit.checked} pairs checked`
    : audit.failures
        .slice(0, 3)
        .map((failure) => `${failure.selector} ${failure.detail}`)
        .join(" | "),
);
check(
  "theme: no text colour is a literal (literals cannot invert)",
  !/(^|[;{])color:\s*(#[0-9a-fA-F]{3,8}|rgba?\()/m.test(stylesheet),
);
check(
  "theme: the inverting brand fill is never used as a text colour",
  !/(^|[;{])color:var\(--dsw-alias-brand-primary\)/m.test(stylesheet),
);
check(
  "theme: the filled button pairs the inverting foreground token",
  /\.pl-primary\{[^}]*background:var\(--dsw-alias-button-primary-fill\)[^}]*color:var\(--dsw-alias-label-primary-foreground\)/.test(
    stylesheet,
  ),
);
check(
  "theme: the selected checkbox tick pairs the same inverting tokens",
  /\.pl-row-check\[data-on="true"\]\{[^}]*color:var\(--dsw-alias-label-primary-foreground\)/.test(
    stylesheet,
  ),
);

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.log("FAILED:");
  for (const result of failed) console.log(`  - ${result.name}${result.detail ? ` (${result.detail})` : ""}`);
  process.exitCode = 1;
}
