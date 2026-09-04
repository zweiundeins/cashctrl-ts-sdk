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

import { SIDE_EFFECTING_GETS } from "../src/safety.ts";
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
  ...SIDE_EFFECTING_GETS,
  // Not side-effecting, but they operate on a staged import that may not exist.
  "/api/v1/inventory/article/import/preview.json",
  "/api/v1/person/import/preview.json",
  // Reading an order or salary document appends a DOWNLOAD entry to the
  // organisation's history log. Harmless, but this script promises to leave
  // no trace, and an audit log is exactly the wrong place to leave one.
  "/api/v1/order/document/read.json",
  "/api/v1/salary/document/read.json",
  "/api/v1/salary/certificate/document/read.json",
];

/**
 * Where an endpoint's mandatory parameter can be found, for the cases the
 * sibling-list convention cannot serve: the parameter is not called `id`, or
 * the value lives under a different resource, or inside a nested array.
 */
interface Fixture {
  param: string;
  /** Endpoint whose response carries a usable value. */
  from: string;
  /** Key to read. Searched recursively, so tree payloads work. */
  field?: string;
  /** Narrow the search to arrays under this key first. */
  within?: string;
}

const FIXTURES: Record<string, Fixture> = {
  "/api/v1/customfield/read.json": {
    param: "id",
    from: "/api/v1/customfield/list.json",
  },
  "/api/v1/customfield/group/read.json": {
    param: "id",
    from: "/api/v1/customfield/group/list.json",
  },
  "/api/v1/journal/import/entry/list.json": {
    param: "importId",
    from: "/api/v1/journal/import/list.json",
  },
  "/api/v1/journal/import/entry/read.json": {
    param: "id",
    from: "/api/v1/journal/import/entry/list.json",
  },
  // The `id` here is the order, not a book entry.
  "/api/v1/order/bookentry/list.json": {
    param: "id",
    from: "/api/v1/order/list.json",
  },
  "/api/v1/order/bookentry/read.json": {
    param: "id",
    from: "/api/v1/order/bookentry/list.json",
  },
  "/api/v1/salary/bookentry/list.json": {
    param: "id",
    from: "/api/v1/salary/statement/list.json",
  },
  "/api/v1/salary/bookentry/read.json": {
    param: "id",
    from: "/api/v1/salary/bookentry/list.json",
  },
  // Statuses are nested inside each order category.
  "/api/v1/order/category/read_status.json": {
    param: "id",
    from: "/api/v1/order/category/list.json",
    within: "status",
  },
  // The report tree nests collections and elements under `data`.
  "/api/v1/report/element/read.json": {
    param: "id",
    from: "/api/v1/report/tree.json",
    field: "elementId",
  },
  "/api/v1/report/element/data.json": {
    param: "elementId",
    from: "/api/v1/report/tree.json",
    field: "elementId",
  },
  "/api/v1/report/element/meta.json": {
    param: "elementId",
    from: "/api/v1/report/tree.json",
    field: "elementId",
  },
  "/api/v1/report/collection/read.json": {
    param: "id",
    from: "/api/v1/report/tree.json",
    field: "collectionId",
  },
  "/api/v1/report/collection/meta.json": {
    param: "collectionId",
    from: "/api/v1/report/tree.json",
    field: "collectionId",
  },
};

/** Pulls candidate values out of a payload, following nested arrays. */
function harvest(payload: unknown, fixture: Fixture): (string | number)[] {
  const field = fixture.field ?? "id";
  const found: (string | number)[] = [];

  const walk = (value: unknown, insideScope: boolean) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, insideScope);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (!fixture.within || insideScope) {
      const candidate = record[field];
      if (typeof candidate === "number" || typeof candidate === "string") {
        found.push(candidate);
      }
    }
    for (const [key, nested] of Object.entries(record)) {
      walk(nested, insideScope || key === fixture.within);
    }
  };

  walk(payload, false);
  return found;
}

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

/**
 * The previous run's shapes. A transient 500 upstream must not be allowed to
 * replace a good shape with `unknown`: this job runs weekly and unattended,
 * and a silent downgrade of the generated types is worse than a stale one.
 */
const previous: Record<string, InferredResponse> = await Deno.readTextFile(OUT)
  .then((text) => (JSON.parse(text) as ResponseSpec).responses)
  .catch(() => ({}));
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
/** Raw payloads, so fixtures can take a parameter out of another response. */
const payloads = new Map<string, unknown>();
const responses: Record<string, InferredResponse> = {};
let fiscalPeriodIds: number[] = [];

/**
 * The parameter combinations to call one endpoint with, or `undefined` when a
 * value it needs has not been harvested yet and a later pass may supply it.
 */
/**
 * How many different records to sample per endpoint. One is enough to learn
 * the field names, but not their types: a field that is null on the first
 * record is often populated on the third, and a tree node only reveals its
 * children if the record sampled happens to have any.
 */
const SAMPLES = 3;

function paramSetsFor(
  endpoint: Endpoint,
): Record<string, string | number>[] | undefined {
  const fixture = FIXTURES[endpoint.path];
  let bases: Record<string, string | number>[] = [{}];

  if (fixture) {
    if (!payloads.has(fixture.from)) return undefined;
    const values = [...new Set(harvest(payloads.get(fixture.from), fixture))];
    if (!values.length) return [];
    bases = values.slice(0, SAMPLES).map((v) => ({ [fixture.param]: v }));
  } else if (endpoint.params.some((p) => p.name === "id" && p.required)) {
    const prefix = endpoint.path.slice(0, endpoint.path.lastIndexOf("/"));
    const ids = [...new Set(idsByPrefix.get(prefix) ?? [])];
    if (!ids.length) return [];
    bases = ids.slice(0, SAMPLES).map((id) => ({ id }));
  }

  let sets = bases;

  // A mandatory parameter with documented values is probed once per value:
  // customfield/list returns different fields per module, for instance.
  for (const param of endpoint.params) {
    if (!param.required || !param.enum?.length) continue;
    if (sets.every((set) => param.name in set)) continue;
    sets = sets.flatMap((set) =>
      param.enum!.map((value) => ({ ...set, [param.name]: value }))
    );
  }

  // Once per fiscal period, so fields that are empty in one and populated in
  // another (open versus closed months, say) are both observed.
  if (
    fiscalPeriodIds.length &&
    endpoint.params.some((p) => p.name === "fiscalPeriodId")
  ) {
    sets = sets.flatMap((set) =>
      fiscalPeriodIds.map((id) => ({ ...set, fiscalPeriodId: id }))
    );
  }

  return sets;
}

function record(path: string, body: unknown): InferredResponse {
  let envelope: InferredResponse["envelope"] = "raw";
  let payload: unknown = body;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const fields = body as Record<string, unknown>;
    if ("data" in fields) {
      envelope = "data";
      payload = fields.data;
    } else if ("success" in fields) {
      envelope = "write";
    }
  }
  payloads.set(path, payload);

  // Harvest ids so sibling read.json endpoints become probeable.
  if (Array.isArray(payload)) {
    const prefix = path.slice(0, path.lastIndexOf("/"));
    const ids = payload
      .map((row) => (row as Record<string, unknown>)?.id)
      .filter((id): id is number => typeof id === "number");
    if (ids.length) idsByPrefix.set(prefix, ids);
  }

  return { envelope, shape: shapeOf(payload), samples: countSamples(payload) };
}

const pending = new Set(targets.slice(0, limit).map((e) => e.path));

// Several passes, because fixtures chain: import/list yields an import id,
// which yields import entries, which yield a single entry to read.
for (let pass = 1; pass <= 4 && pending.size; pass++) {
  let progressed = false;

  for (const endpoint of targets.slice(0, limit)) {
    if (!pending.has(endpoint.path)) continue;
    const sets = paramSetsFor(endpoint);
    if (sets === undefined) continue; // a later pass may supply the parameter
    pending.delete(endpoint.path);
    progressed = true;

    if (!sets.length) {
      if (verbose) {
        console.log(`  skip  ${endpoint.path} (no parameter available)`);
      }
      continue;
    }

    let merged: InferredResponse | undefined;
    let lastError: string | undefined;
    for (const params of sets) {
      try {
        const inferred = record(
          endpoint.path,
          await http.get<unknown>(endpoint.path, params),
        );
        merged = merged
          ? {
            envelope: merged.envelope,
            shape: mergeShapes(merged.shape, inferred.shape),
            samples: merged.samples + inferred.samples,
          }
          : inferred;
      } catch (err) {
        lastError = (err instanceof Error ? err.message : String(err)).slice(
          0,
          200,
        );
      }
      await new Promise((r) => setTimeout(r, 120));
    }

    if (merged) {
      responses[endpoint.path] = merged;
      if (endpoint.path === "/api/v1/fiscalperiod/list.json") {
        fiscalPeriodIds = (idsByPrefix.get("/api/v1/fiscalperiod") ?? []).slice(
          0,
          4,
        );
      }
      if (verbose) {
        console.log(
          `  ok    ${endpoint.path} [${merged.envelope}] ` +
            `${merged.samples} sample(s)${
              sets.length > 1 ? ` x${sets.length}` : ""
            }`,
        );
      }
    } else {
      const kept = previous[endpoint.path];
      if (kept && !kept.error) {
        responses[endpoint.path] = kept;
        console.log(
          `  keep  ${endpoint.path}: call failed, kept the previous shape ` +
            `(${lastError ?? "no successful call"})`,
        );
      } else {
        responses[endpoint.path] = {
          envelope: "raw",
          shape: { kind: "unknown" },
          samples: 0,
          error: lastError ?? "no successful call",
        };
        if (verbose) {
          console.log(`  fail  ${endpoint.path}: ${lastError ?? ""}`);
        }
      }
    }
  }

  if (!progressed) break;
}

const ok = Object.values(responses).filter((r) => !r.error).length;
const failed = Object.values(responses).filter((r) => r.error).length;
const skipped = targets.slice(0, limit).length - ok - failed;

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
