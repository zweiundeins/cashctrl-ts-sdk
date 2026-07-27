/**
 * Probes a live CashCtrl organisation to infer response shapes, which the
 * HTML reference does not document (it specifies request params only).
 *
 * READ-ONLY BY CONSTRUCTION. Only GET endpoints on a verb allowlist are
 * called, and endpoints with side effects are denied outright:
 *
 *   - fiscalperiod/reopen_months.json  reopens closed months
 *   - sequencenumber/get               consumes/increments a sequence number
 *   - import/preview.json             operates on a staged import
 *
 * Nothing here issues a POST. Usage:
 *   deno run -A --env-file=.env scripts/probe-api.ts [--limit N] [--verbose]
 */

import type {
  Endpoint,
  InferredResponse,
  ResponseSpec,
  ScalarType,
  Shape,
  Spec,
} from "./ir.ts";
import { CashCtrlHttp } from "../src/http.ts";

const SPEC = new URL("../spec/api.json", import.meta.url);
const OUT = new URL("../spec/responses.json", import.meta.url);

/** Terminal path segments considered free of side effects. */
const SAFE_VERBS = new Set([
  "list.json",
  "read.json",
  "tree.json",
  "types.json",
  "meta.json",
  "data.json",
  "dossier.json",
  "read_status.json",
  "depreciations.json",
  "exchangediff.json",
  "mapping_combo.json",
  "balance",
  "result",
  "exchangerate",
]);

/** Never called, regardless of method or verb. */
const DENY = [
  "/api/v1/fiscalperiod/reopen_months.json",
  "/api/v1/sequencenumber/get",
  "/api/v1/inventory/article/import/preview.json",
  "/api/v1/person/import/preview.json",
];

function isProbeable(e: Endpoint): boolean {
  if (e.method !== "GET") return false;
  if (DENY.includes(e.path)) return false;
  return SAFE_VERBS.has(e.path.slice(e.path.lastIndexOf("/") + 1));
}

/* ---------------------------------------------------------------- shapes -- */

function scalarOf(v: unknown): ScalarType {
  if (v === null) return "null";
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  return "string";
}

function shapeOf(value: unknown): Shape {
  if (Array.isArray(value)) {
    if (!value.length) return { kind: "array", items: { kind: "unknown" } };
    return { kind: "array", items: value.map(shapeOf).reduce(mergeShapes) };
  }
  if (value !== null && typeof value === "object") {
    const fields: Record<string, { shape: Shape; optional: boolean }> = {};
    for (const [k, v] of Object.entries(value)) {
      fields[k] = { shape: shapeOf(v), optional: false };
    }
    return { kind: "object", fields };
  }
  return { kind: "scalar", types: [scalarOf(value)] };
}

/** Unions two observed shapes, marking keys missing on either side optional. */
function mergeShapes(a: Shape, b: Shape): Shape {
  if (a.kind === "unknown") return b;
  if (b.kind === "unknown") return a;

  if (a.kind === "scalar" && b.kind === "scalar") {
    return { kind: "scalar", types: [...new Set([...a.types, ...b.types])] };
  }
  if (a.kind === "array" && b.kind === "array") {
    return { kind: "array", items: mergeShapes(a.items, b.items) };
  }
  if (a.kind === "object" && b.kind === "object") {
    const fields: Record<string, { shape: Shape; optional: boolean }> = {};
    for (
      const key of new Set([...Object.keys(a.fields), ...Object.keys(b.fields)])
    ) {
      const fa = a.fields[key];
      const fb = b.fields[key];
      if (fa && fb) {
        fields[key] = {
          shape: mergeShapes(fa.shape, fb.shape),
          optional: fa.optional || fb.optional,
        };
      } else {
        // Present in one sample only: the key is genuinely optional.
        fields[key] = { shape: (fa ?? fb).shape, optional: true };
      }
    }
    return { kind: "object", fields };
  }
  // A field that is sometimes an object and sometimes a scalar (usually null).
  if (a.kind === "scalar" && a.types.length === 1 && a.types[0] === "null") {
    return b;
  }
  if (b.kind === "scalar" && b.types.length === 1 && b.types[0] === "null") {
    return a;
  }
  return { kind: "unknown" };
}

function countSamples(payload: unknown): number {
  return Array.isArray(payload) ? payload.length : 1;
}

/* ----------------------------------------------------------------- probe -- */

const apiKey = Deno.env.get("CASHCTRL_APIKEY");
const organisation = Deno.env.get("CASHCTRL_DOMAINID");
if (!apiKey || !organisation) {
  console.error(
    "Set CASHCTRL_APIKEY and CASHCTRL_DOMAINID (e.g. --env-file=.env)",
  );
  Deno.exit(1);
}

const verbose = Deno.args.includes("--verbose");
const limitArg = Deno.args.indexOf("--limit");
const limit = limitArg >= 0 ? Number(Deno.args[limitArg + 1]) : Infinity;

const spec: Spec = JSON.parse(await Deno.readTextFile(SPEC));
const http = new CashCtrlHttp({ apiKey, organisation, lang: "en" });

const targets = spec.endpoints.filter(isProbeable);
// list/tree first: their rows supply the ids every other endpoint needs.
targets.sort((a, b) => {
  const rank = (e: Endpoint) =>
    e.path.endsWith("list.json") || e.path.endsWith("tree.json") ? 0 : 1;
  return rank(a) - rank(b) || a.path.localeCompare(b.path);
});

console.log(
  `probing ${Math.min(targets.length, limit)} read-only endpoints ` +
    `on ${organisation}.cashctrl.com`,
);

/** ids harvested per resource prefix, e.g. "/api/v1/account" -> [1,2,3]. */
const idsByPrefix = new Map<string, number[]>();
const responses: Record<string, InferredResponse> = {};
let ok = 0, failed = 0, skipped = 0;

for (const endpoint of targets.slice(0, limit)) {
  const prefix = endpoint.path.slice(0, endpoint.path.lastIndexOf("/"));
  const params: Record<string, string | number> = {};

  // read.json needs an id; reuse one harvested from the sibling list/tree.
  if (endpoint.params.some((p) => p.name === "id" && p.required)) {
    const id = idsByPrefix.get(prefix)?.[0];
    if (id === undefined) {
      skipped++;
      if (verbose) console.log(`  skip  ${endpoint.path} (no id available)`);
      continue;
    }
    params.id = id;
  }

  try {
    const body = await http.get<unknown>(endpoint.path, params);

    let envelope: InferredResponse["envelope"] = "raw";
    let payload: unknown = body;
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const record = body as Record<string, unknown>;
      if ("data" in record) {
        envelope = "data";
        payload = record.data;
      } else if ("success" in record) {
        envelope = "write";
      }
    }

    responses[endpoint.path] = {
      envelope,
      shape: shapeOf(payload),
      samples: countSamples(payload),
    };

    // Harvest ids so sibling read.json endpoints become probeable.
    if (Array.isArray(payload)) {
      const ids = payload
        .map((row) => (row as Record<string, unknown>)?.id)
        .filter((id): id is number => typeof id === "number");
      if (ids.length) idsByPrefix.set(prefix, ids);
    }

    ok++;
    if (verbose) {
      console.log(
        `  ok    ${endpoint.path} [${envelope}] ` +
          `${responses[endpoint.path].samples} sample(s)`,
      );
    }
  } catch (err) {
    failed++;
    const message = err instanceof Error ? err.message : String(err);
    responses[endpoint.path] = {
      envelope: "raw",
      shape: { kind: "unknown" },
      samples: 0,
      error: message.slice(0, 200),
    };
    if (verbose) {
      console.log(`  fail  ${endpoint.path}: ${message.slice(0, 120)}`);
    }
  }

  // Stay well clear of the rate limiter.
  await new Promise((r) => setTimeout(r, 120));
}

const out: ResponseSpec = {
  probedAt: new Date().toISOString(),
  organisation: "<redacted>",
  responses: Object.fromEntries(
    Object.entries(responses).sort(([a], [b]) => a.localeCompare(b)),
  ),
};
await Deno.writeTextFile(OUT, JSON.stringify(out, null, 2) + "\n");

console.log(`\n${ok} ok, ${failed} failed, ${skipped} skipped`);
console.log(`wrote ${OUT.pathname}`);
