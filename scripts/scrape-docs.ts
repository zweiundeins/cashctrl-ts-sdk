/**
 * Scrapes the CashCtrl HTML API reference into a machine-readable IR.
 *
 * CashCtrl publishes no OpenAPI spec, but the reference page is generated
 * markup with a stable shape, so it parses reliably:
 *
 *   <section class="action">
 *     <a id="/account/create.json"></a>
 *     <div class="breadcrumbs"><a href="#/account">Account</a></div>
 *     <h3>Create account</h3>
 *     <p>description</p>
 *     <table class="parameters">
 *       <tr><th><code>name</code></th><td>
 *         <div class="labels">
 *           <div class="label mandatory">mandatory</div>
 *           <div class="label datatype">TEXT</div>
 *           <div class="label">MAX:100</div>
 *         </div>
 *         <p>description</p>
 *         <table class="parameters sub">...</table>   <-- nested, JSON params
 *       </td></tr>
 *     </table>
 *     <div class="endpoint">POST /api/v1/account/create.json</div>
 *   </section>
 *
 * Output: spec/api.json
 */

import type { Endpoint, Param, ParamType, Spec } from "./ir.ts";

const DOCS_URL = "https://app.cashctrl.com/static/help/en/api/index.html";
const CACHE = new URL("../spec/docs-cache.html", import.meta.url);
const OUT = new URL("../spec/api.json", import.meta.url);

/** Returns the inner HTML of the balanced `<tag ...>` starting at `open`. */
function balanced(html: string, open: number, tag: string): string {
  const start = html.indexOf(">", open) + 1;
  let depth = 1;
  let i = start;
  const openRe = new RegExp(`<${tag}[\\s>]`, "g");
  const closeRe = new RegExp(`</${tag}>`, "g");
  while (depth > 0) {
    openRe.lastIndex = i;
    closeRe.lastIndex = i;
    const o = openRe.exec(html);
    const c = closeRe.exec(html);
    if (!c) return html.slice(start);
    if (o && o.index < c.index) {
      depth++;
      i = o.index + 1;
    } else {
      depth--;
      if (depth === 0) return html.slice(start, c.index);
      i = c.index + 1;
    }
  }
  return html.slice(start);
}

/** Splits table rows at nesting depth 0, so nested sub-tables stay intact. */
function topLevelRows(tableInner: string): string[] {
  const rows: string[] = [];
  let depth = 0;
  let rowStart = -1;
  const re = /<(\/?)(table|tr)\b[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tableInner))) {
    const closing = m[1] === "/";
    const tag = m[2];
    if (tag === "table") {
      depth += closing ? -1 : 1;
    } else if (tag === "tr" && depth === 0) {
      if (!closing) rowStart = m.index;
      else if (rowStart >= 0) {
        rows.push(tableInner.slice(rowStart, m.index + m[0].length));
        rowStart = -1;
      }
    }
  }
  return rows;
}

function stripTags(html: string): string {
  return html
    .replace(/<table[\s\S]*$/i, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const TYPES: ParamType[] = [
  "TEXT",
  "NUMBER",
  "BOOLEAN",
  "JSON",
  "CSV",
  "DATE",
  "HTML",
  "XML",
];

function parseParams(tableInner: string): Param[] {
  return topLevelRows(tableInner).map((row) => {
    const name = /<th>\s*<code>([^<]+)<\/code>/.exec(row)?.[1]?.trim() ?? "";

    // Only the row's OWN labels block: a nested `parameters sub` table carries
    // labels for its sub-fields, and those must not leak onto the parent param.
    const labelsIdx = row.search(/<div class="labels">/);
    const labelsBlock = labelsIdx >= 0 ? balanced(row, labelsIdx, "div") : "";
    const labels = [
      ...labelsBlock.matchAll(/<div class="label[^"]*">([^<]*)<\/div>/g),
    ].map((m) => m[1].trim());

    const type = labels.find((l) =>
      TYPES.includes(l as ParamType)
    ) as ParamType ?? "TEXT";
    const maxLabel = labels.find((l) => /^MAX:/.test(l));

    // Description is everything after the labels div, minus any nested table.
    const afterLabels = row.slice(row.indexOf("</div></div>") + 12);
    const description = stripTags(afterLabels);

    const param: Param = {
      name,
      type,
      required: labels.includes("mandatory"),
      description,
    };

    if (maxLabel) param.maxLength = Number(maxLabel.slice(4));

    // "Possible values: ASC, DESC." -> enum
    const enumMatch = /Possible values:\s*([^.]+)\./.exec(description);
    if (enumMatch) {
      param.enum = enumMatch[1].split(",").map((v) => v.trim()).filter(Boolean);
    }

    // "Defaults to 'ASC'" / "Defaults to 100"
    const defMatch = /Defaults? to '?([^'.,\s]+)'?/.exec(description);
    if (defMatch) param.default = defMatch[1];

    // JSON params document their shape in a nested <table class="parameters sub">
    const subIdx = row.search(/<table class="parameters sub"/);
    if (subIdx >= 0) {
      param.fields = parseParams(balanced(row, subIdx, "table"));
      // "This is a JSON array [{...},{...},...]" vs a single object
      param.isArray = /JSON array|array of/i.test(description);
    }

    return param;
  }).filter((p) => p.name);
}

async function loadDocs(): Promise<string> {
  if (Deno.args.includes("--refresh")) {
    console.log(`fetching ${DOCS_URL}`);
    const html = await (await fetch(DOCS_URL)).text();
    await Deno.writeTextFile(CACHE, html);
    return html;
  }
  try {
    return await Deno.readTextFile(CACHE);
  } catch {
    console.log(`no cache, fetching ${DOCS_URL}`);
    const html = await (await fetch(DOCS_URL)).text();
    await Deno.writeTextFile(CACHE, html);
    return html;
  }
}

const html = await loadDocs();
const endpoints: Endpoint[] = [];

// Each documented action is a <section class="action"> containing one anchor.
const sectionRe = /<section class="action">/g;
let sm: RegExpExecArray | null;
while ((sm = sectionRe.exec(html))) {
  const section = balanced(html, sm.index, "section");

  const endpointMatch =
    /<div class="endpoint">\s*(GET|POST|PUT|DELETE|PATCH)\s+(\S+?)\s*<\/div>/
      .exec(section);
  if (!endpointMatch) continue;
  const [, method, path] = endpointMatch;

  const anchor = /<a id="([^"]+)"><\/a>/.exec(section)?.[1] ?? path;
  const summary = stripTags(/<h3>([\s\S]*?)<\/h3>/.exec(section)?.[1] ?? "");

  const group = [...(/<div class="breadcrumbs">([\s\S]*?)<\/div>/
    .exec(section)?.[1] ?? "").matchAll(/<a[^>]*>([^<]+)<\/a>/g)]
    .map((m) => m[1].trim());

  // Description: <p> tags inside .description, after the <h3>.
  const descBlock = /<div class="description">([\s\S]*?)<\/div>\s*<h4>/
    .exec(section)?.[1] ?? "";
  const description = stripTags(
    descBlock.slice(descBlock.indexOf("</h3>") + 5),
  );

  let params: Param[] = [];
  const paramsIdx = section.search(/<table class="parameters"(?! sub)/);
  if (paramsIdx >= 0) {
    params = parseParams(balanced(section, paramsIdx, "table"));
  }

  endpoints.push({
    anchor,
    method: method as "GET" | "POST",
    path,
    group,
    summary,
    description,
    params,
  });
}

const spec: Spec = {
  source: DOCS_URL,
  baseUrlTemplate: "https://{organisation}.cashctrl.com",
  endpoints: endpoints.sort((a, b) => a.path.localeCompare(b.path)),
};

await Deno.writeTextFile(OUT, JSON.stringify(spec, null, 2) + "\n");

const withParams = endpoints.filter((e) => e.params.length).length;
const nested = endpoints.filter((e) => e.params.some((p) => p.fields)).length;
console.log(
  `${endpoints.length} endpoints ` +
    `(${endpoints.filter((e) => e.method === "GET").length} GET, ` +
    `${endpoints.filter((e) => e.method === "POST").length} POST), ` +
    `${withParams} with params, ${nested} with nested JSON shapes`,
);
console.log(`wrote ${OUT.pathname}`);
