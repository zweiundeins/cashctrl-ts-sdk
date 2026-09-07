/**
 * Condenses the scraped spec into a search index of every endpoint.
 *
 * `spec/openapi.json` is 1.9 MB because response schemas are inlined per
 * endpoint, which makes it unusable anywhere the whole surface has to be held
 * at once — an MCP server, an agent tool, a docs search box. This drops the
 * response schemas and truncates prose, leaving ~130 KB that can be searched
 * in memory.
 *
 * Run: deno run --allow-read --allow-write scripts/build-index.ts
 */

import type { Endpoint, Param, Spec } from "./ir.ts";
import { applySpecCorrections } from "./overrides.ts";

const root = (p: string) => new URL(`../${p}`, import.meta.url);
const MAX_DESCRIPTION = 200;

interface IndexParam {
  name: string;
  type: Param["type"];
  required: boolean;
  description: string;
  enum?: string[];
}

interface IndexEntry {
  path: string;
  method: Endpoint["method"];
  group: string[];
  summary: string;
  description: string;
  anchor: string;
  params: IndexParam[];
}

/** First sentence, capped: enough to choose an endpoint, not to use it. */
function condense(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= MAX_DESCRIPTION) return flat;
  const cut = flat.slice(0, MAX_DESCRIPTION);
  const stop = cut.lastIndexOf(". ");
  return (stop > 60 ? cut.slice(0, stop + 1) : cut.trimEnd() + "…");
}

const spec: Spec = JSON.parse(await Deno.readTextFile(root("spec/api.json")));
// The index is what agents search to decide what to call, so it has to carry
// the same corrections the generated client does.
applySpecCorrections(spec);

const entries: IndexEntry[] = spec.endpoints.map((e) => ({
  path: e.path,
  method: e.method,
  group: e.group,
  summary: e.summary,
  description: condense(e.description),
  anchor: e.anchor,
  params: e.params.map((p) => ({
    name: p.name,
    type: p.type,
    required: p.required,
    description: condense(p.description),
    ...(p.enum?.length ? { enum: p.enum } : {}),
  })),
}));

const index = {
  source: spec.source,
  generatedFrom: "spec/api.json",
  endpoints: entries,
};

const json = JSON.stringify(index);
await Deno.writeTextFile(root("spec/index.json"), json + "\n");

const params = entries.reduce((n, e) => n + e.params.length, 0);
console.log(
  `index.json: ${entries.length} endpoints, ${params} params, ${
    Math.round(json.length / 1024)
  } KB`,
);
