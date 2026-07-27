/** Shared naming rules for the generator. */

/**
 * Names that genuinely cannot be used as a class member.
 *
 * Deliberately NOT the JavaScript keyword list. Keywords are reserved for
 * *identifiers*, not for property or method names: `delete(...)`, `new(...)`
 * and `for(...)` are all legal class members. Escaping them produced
 * `client.tax.delete_(...)` for every one of the 33 delete endpoints, which is
 * not the method any caller reaches for. A round-trip test against a live
 * organisation called `.delete(...)`, silently did nothing, and left records
 * behind.
 *
 * Only these would actually break: `constructor` would replace the class
 * constructor, and the other two corrupt the prototype chain.
 */
const RESERVED = new Set(["constructor", "prototype", "__proto__"]);

/** File-extension suffixes that distinguish sibling endpoints. */
const FORMATS = ["json", "csv", "pdf", "xlsx", "zip", "vcf", "xml", "html"];

export function pascal(input: string): string {
  return input
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");
}

export function camel(input: string): string {
  const p = pascal(input);
  return p ? p[0].toLowerCase() + p.slice(1) : p;
}

/**
 * Splits an endpoint path into its resource segments and action verb.
 * The final segment is always the action: `/api/v1/account/category/list.json`
 * becomes `{ resource: ["account","category"], verb: "list.json" }`.
 */
export function splitPath(
  path: string,
): { resource: string[]; verb: string } {
  const segments = path.replace(/^\/api\/v1\//, "").split("/");
  return {
    resource: segments.slice(0, -1),
    verb: segments[segments.length - 1],
  };
}

/**
 * Method name for an action verb.
 * `list.json` -> `list`, `list.csv` -> `listCsv`,
 * `update_attachments.json` -> `updateAttachments`.
 */
export function methodName(verb: string): string {
  const dot = verb.lastIndexOf(".");
  const ext = dot >= 0 ? verb.slice(dot + 1) : "";
  const base = dot >= 0 && FORMATS.includes(ext) ? verb.slice(0, dot) : verb;
  const suffix = ext && ext !== "json" && FORMATS.includes(ext)
    ? pascal(ext)
    : "";
  const name = camel(base) + suffix;
  return RESERVED.has(name) ? `${name}_` : name;
}

/** Property name for a resource segment, e.g. `costcenter` -> `costcenter`. */
export function propertyName(segment: string): string {
  const name = camel(segment);
  return RESERVED.has(name) ? `${name}_` : name;
}

/** Type name for a resource path, e.g. ["account","category"] -> "AccountCategory". */
export function typeName(resource: string[]): string {
  return resource.map(pascal).join("");
}

/** Naive singularization, good enough for CashCtrl's field names. */
export function singular(word: string): string {
  if (/ies$/.test(word)) return word.slice(0, -3) + "y";
  if (/(ses|xes|zes|ches|shes)$/.test(word)) return word.slice(0, -2);
  if (/s$/.test(word) && !/ss$/.test(word)) return word.slice(0, -1);
  return word;
}

/** Quotes an object key when it is not a bare identifier. */
export function key(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

/** Wraps text as a JSDoc block at the given indent. */
export function jsdoc(lines: (string | undefined)[], indent = ""): string {
  const content = lines.filter((l): l is string => Boolean(l?.trim()));
  if (!content.length) return "";
  const wrapped = content.flatMap((line) => wrap(line, 76 - indent.length));
  if (wrapped.length === 1) return `${indent}/** ${wrapped[0]} */\n`;
  return `${indent}/**\n` +
    wrapped.map((l) => `${indent} * ${l}`.trimEnd()).join("\n") +
    `\n${indent} */\n`;
}

function wrap(text: string, width: number): string[] {
  const safe = text.replace(/\*\//g, "*​/");
  const out: string[] = [];
  let line = "";
  for (const word of safe.split(/\s+/)) {
    if (line && line.length + word.length + 1 > width) {
      out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out;
}
