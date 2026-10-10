/**
 * Theme contrast audit for dsh-prompt-library.
 *
 * DSH's alias palette INVERTS between themes: `--dsw-alias-brand-primary` is
 * near-black in light mode and near-white in dark mode. A hardcoded `#fff` on
 * that fill is therefore invisible in dark mode. This module parses the
 * plugin's stylesheet, resolves every `--dsw-*` token to a concrete colour for
 * both themes, and checks WCAG contrast, so that class of bug cannot come back.
 *
 * The palette below is resolved from `@deepseek-ai/dsh-client-ui-theme`
 * 0.2.0-rc.2 on the Windows platform (the macOS-only material overrides are
 * deliberately excluded). `test/theme.live.mjs` can re-derive it from a local
 * DSH install when one is present.
 */

/** Resolved alias tokens, light and dark, as the Windows web client sees them. */
export const PALETTE = {
  light: {
    "--dsw-alias-bg-base": "#fff",
    "--dsw-alias-bg-layer-1": "#fff",
    "--dsw-alias-bg-layer-2": "#fff",
    "--dsw-alias-bg-layer-3": "#fff",
    "--dsw-alias-bg-overlay": "#e9ecf2",
    "--dsw-specific-menu": "#f8f9fa94",
    "--dsw-alias-label-primary": "#0f1115",
    "--dsw-alias-label-secondary": "#61666b",
    "--dsw-alias-label-tertiary": "#81858c",
    "--dsw-alias-label-primary-foreground": "#fff",
    "--dsw-alias-brand-primary": "#0f1115",
    "--dsw-alias-brand-text": "#0f1115",
    "--dsw-alias-interactive-bg-hover": "#2631480f",
    "--dsw-alias-interactive-bg-active": "#2631481a",
    "--dsw-alias-button-primary-fill": "#0f1115",
    "--dsw-alias-button-primary-hover": "#43454a",
    "--dsw-alias-button-ghost-active-fill": "#ebeef2",
    "--dsw-alias-button-ghost-active-border": "#979da6",
    "--dsw-alias-state-error-primary": "#ec1313",
    "--dsw-alias-state-success-primary": "#22c55e",
    "--dsw-alias-state-business-primary": "#4176e6",
    "--dsw-alias-border-l1": "#0000000a",
    "--dsw-alias-border-l2": "#0000001a",
    "--dsw-alias-border-l3": "#0000001f",
    "--dsw-alias-border-l4": "#00000029",
  },
  dark: {
    "--dsw-alias-bg-base": "#151517",
    "--dsw-alias-bg-layer-1": "#232324",
    "--dsw-alias-bg-layer-2": "#2c2c2e",
    "--dsw-alias-bg-layer-3": "#353638",
    "--dsw-alias-bg-overlay": "#61666b",
    "--dsw-specific-menu": "#43454a73",
    "--dsw-alias-label-primary": "#f9fafb",
    "--dsw-alias-label-secondary": "#cfd3d6",
    "--dsw-alias-label-tertiary": "#adb2b8",
    "--dsw-alias-label-primary-foreground": "#0f1115",
    "--dsw-alias-brand-primary": "#f9fafb",
    "--dsw-alias-brand-text": "#f9fafb",
    "--dsw-alias-interactive-bg-hover": "#ffffff14",
    "--dsw-alias-interactive-bg-active": "#ffffff24",
    "--dsw-alias-button-primary-fill": "#f9fafb",
    "--dsw-alias-button-primary-hover": "#ebeef2",
    "--dsw-alias-button-ghost-active-fill": "#43454a",
    "--dsw-alias-button-ghost-active-border": "#81858c",
    "--dsw-alias-state-error-primary": "#f25a5a",
    "--dsw-alias-state-success-primary": "#22c55e",
    "--dsw-alias-state-business-primary": "#7aaaff",
    "--dsw-alias-border-l1": "#ffffff0f",
    "--dsw-alias-border-l2": "#ffffff1f",
    "--dsw-alias-border-l3": "#ffffff29",
    "--dsw-alias-border-l4": "#fff3",
  },
};

/* ------------------------------ colour maths ------------------------------ */

function parse(hex) {
  let value = String(hex).trim().replace("#", "");
  // `#rgb` and `#rgba` are shorthand for the six/eight digit forms.
  if (value.length === 3 || value.length === 4) {
    value = [...value].map((c) => c + c).join("");
  }
  if (value.length !== 6 && value.length !== 8) return null;
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
    a: value.length === 8 ? parseInt(value.slice(6, 8), 16) / 255 : 1,
  };
}

/** Composite a possibly translucent colour over an opaque base. */
export function over(front, back) {
  const top = typeof front === "string" ? parse(front) : front;
  const bottom = typeof back === "string" ? parse(back) : back;
  if (top === null || bottom === null) return null;
  if (top.a >= 1) return top;
  const mix = (t, b) => Math.round(t * top.a + b * (1 - top.a));
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a: 1 };
}

function luminance(color) {
  const rgb = typeof color === "string" ? parse(color) : color;
  const channel = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/** WCAG contrast ratio between two opaque colours. */
export function contrast(front, back) {
  const a = luminance(typeof front === "string" ? parse(front) : front);
  const b = luminance(typeof back === "string" ? parse(back) : back);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/* ------------------------------ CSS resolution ---------------------------- */

/**
 * Resolve one CSS value against a theme into an opaque colour, or null when it
 * is not a colour we can reason about (`transparent`, `inherit`, `none`).
 * The menu material is translucent, so it composites over the base surface.
 */
export function resolveValue(theme, value) {
  const palette = PALETTE[theme];
  const text = String(value).trim();
  if (text === "" || text === "transparent" || text === "inherit" || text === "none") return null;
  if (text.startsWith("#")) return parse(text);
  // A bare token name is accepted for convenience (surface lookups).
  if (text.startsWith("--")) return resolveValue(theme, `var(${text})`);

  const reference = /^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]*))?\)$/.exec(text);
  if (reference !== null) {
    const [, name, fallback] = reference;
    if (name === "--dsw-specific-menu") {
      return over(palette["--dsw-specific-menu"], palette["--dsw-alias-bg-base"]);
    }
    const resolved = palette[name];
    if (resolved !== undefined) return parse(resolved);
    return fallback === undefined ? null : resolveValue(theme, fallback);
  }
  return null;
}

/** Split a stylesheet into `{ selector, declarations }` rules. */
export function parseRules(css) {
  const rules = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").trim();
    if (selector === "") continue;
    const declarations = {};
    for (const decl of match[2].split(";")) {
      const at = decl.indexOf(":");
      if (at === -1) continue;
      declarations[decl.slice(0, at).trim()] = decl.slice(at + 1).trim();
    }
    rules.push({ selector, declarations });
  }
  return rules;
}

/** The ambient surfaces text can sit on in this plugin. */
const SURFACES = ["--dsw-alias-bg-base", "--dsw-specific-menu"];

/**
 * Audit one stylesheet.
 *
 * - every `color` declaration must clear 4.5:1 against BOTH ambient surfaces
 *   in BOTH themes (a text colour that only works on one surface is a bug);
 * - every rule that sets a background must clear 4.5:1 between that background
 *   and the rule's own `color` (or the inherited body colour when it sets none);
 * - no `color` declaration may be a literal, because literals cannot invert.
 *
 * @returns {{ failures: Array<{selector:string, property:string, detail:string}>, checked: number }}
 */
export function auditStylesheet(css) {
  const rules = parseRules(css);
  const failures = [];
  let checked = 0;

  for (const { selector, declarations } of rules) {
    const color = declarations.color;
    if (color === undefined) continue;
    if (!color.startsWith("var(") && color !== "inherit" && !color.startsWith("transparent")) {
      failures.push({
        selector,
        property: "color",
        detail: `literal colour "${color}" cannot follow the theme`,
      });
      continue;
    }
    if (color === "inherit" || color.startsWith("transparent")) continue;

    const background =
      declarations.background ?? declarations["background-color"] ?? undefined;

    if (background !== undefined && background !== "transparent") {
      // The rule paints its own backdrop: check the pair directly. A
      // translucent overlay (the hover/interactive tokens) must be composited
      // over the surface it floats on before it means anything.
      for (const theme of ["light", "dark"]) {
        const front = resolveValue(theme, color);
        let back = resolveValue(theme, background);
        if (front === null || back === null) continue;
        if (back.a < 1) back = over(back, resolveValue(theme, "--dsw-alias-bg-base"));
        checked += 1;
        const ratio = contrast(front, back);
        if (ratio < 4.5) {
          failures.push({
            selector,
            property: "background/color",
            detail: `${theme}: ${ratio.toFixed(2)}:1 (needs 4.5) — ${color} on ${background}`,
          });
        }
      }
    } else {
      // No own backdrop: it must work on every ambient surface.
      for (const theme of ["light", "dark"]) {
        const front = resolveValue(theme, color);
        if (front === null) continue;
        for (const surface of SURFACES) {
          const back = resolveValue(theme, surface);
          checked += 1;
          const ratio = contrast(front, back);
          if (ratio < 4.5) {
            failures.push({
              selector,
              property: "color",
              detail: `${theme} on ${surface}: ${ratio.toFixed(2)}:1 (needs 4.5) — ${color}`,
            });
          }
        }
      }
    }
  }

  return { failures, checked };
}
