/**
 * Generates the SDK surface from the scraped docs plus the probed responses.
 *
 *   spec/api.json       request params, from the HTML reference (all 376)
 *   spec/responses.json response shapes, from live read-only calls
 *        |
 *        +--> src/generated/models.ts     param + entity interfaces
 *        +--> src/generated/resources.ts  nested typed client
 *        +--> spec/openapi.json           OpenAPI 3.1 document
 *
 * Run: deno run --allow-read --allow-write scripts/generate.ts
 */

import type {
  Endpoint,
  InferredResponse,
  Param,
  ResponseSpec,
  Shape,
  Spec,
} from "./ir.ts";
import {
  camel,
  jsdoc,
  key,
  methodName,
  pascal,
  propertyName,
  singular,
  splitPath,
  typeName,
} from "./naming.ts";
import { findOverride } from "./overrides.ts";

const root = (p: string) => new URL(`../${p}`, import.meta.url);

const spec: Spec = JSON.parse(await Deno.readTextFile(root("spec/api.json")));
let probed: ResponseSpec = { probedAt: "", organisation: "", responses: {} };
try {
  probed = JSON.parse(await Deno.readTextFile(root("spec/responses.json")));
} catch {
  console.warn("no spec/responses.json - entities will be typed as unknown");
}

/* ------------------------------------------------------- request params -- */

/**
 * Maps a documented param type to the TypeScript type the client accepts.
 *
 * `endpointPath` and `paramPath` are threaded through so `overrides.ts` can
 * correct the handful of params CashCtrl documents incorrectly.
 */
function paramTsType(p: Param, endpointPath = "", paramPath = ""): string {
  const override = endpointPath && paramPath
    ? findOverride(endpointPath, paramPath)
    : undefined;
  if (override) return override.tsType;

  switch (p.type) {
    case "NUMBER":
      return "number";
    case "BOOLEAN":
      return "boolean";
    case "DATE":
      return "Date | string";
    case "CSV":
      return "string | number | readonly (string | number)[]";
    case "JSON": {
      if (p.fields?.length) {
        const inline = p.fields.map((f) => {
          const optional = f.required ? "" : "?";
          return `    ${key(f.name)}${optional}: ${
            paramTsType(f, endpointPath, `${paramPath}.${f.name}`)
          };`;
        }).join("\n");
        const object = `{\n${inline}\n  }`;
        return p.isArray ? `readonly (${object})[]` : object;
      }
      return "unknown";
    }
    case "TEXT":
    case "HTML":
    case "XML":
      if (p.enum?.length) {
        return p.enum.map((v) => JSON.stringify(v)).join(" | ");
      }
      return "string";
  }
}

function paramDoc(p: Param): string[] {
  const notes: string[] = [];
  if (p.description) notes.push(p.description);
  const meta: string[] = [];
  if (p.maxLength) meta.push(`Max length: ${p.maxLength}.`);
  if (p.default) meta.push(`Defaults to \`${p.default}\`.`);
  if (p.type === "CSV") meta.push("Sent as a comma-separated list.");
  if (p.type === "JSON") meta.push("Serialized to JSON before sending.");
  if (p.type === "XML") meta.push("Expects CashCtrl's XML `<values>` format.");
  if (meta.length) notes.push(meta.join(" "));
  return notes;
}

function paramsInterface(
  name: string,
  params: Param[],
  endpointPath: string,
): string {
  const body = params.map((p) => {
    const doc = jsdoc(paramDoc(p), "  ");
    const optional = p.required ? "" : "?";
    // `null` explicitly clears a field on update endpoints.
    const nullable = p.required ? "" : " | null";
    return `${doc}  ${key(p.name)}${optional}: ${
      paramTsType(p, endpointPath, p.name)
    }${nullable};`;
  }).join("\n");
  // A type alias, not an interface: only anonymous object types get an
  // implicit index signature, which is what makes them assignable to the
  // transport's `Params` record.
  return `export type ${name} = {\n${body}\n};\n`;
}

/* ----------------------------------------------------- response entities -- */

const entityDecls = new Map<string, string>();

/** Renders a probed shape as a TypeScript type, hoisting nested objects. */
function shapeTsType(shape: Shape, nameHint: string): string {
  switch (shape.kind) {
    case "unknown":
      return "unknown";
    case "scalar": {
      const types = shape.types.length ? shape.types : ["unknown"];
      // A field that was null in every sample and has no documented param to
      // widen from: emit `unknown` rather than the literal `null` type, which
      // would reject every legitimate value the field can actually hold.
      if (types.length === 1 && types[0] === "null") return "unknown";
      // Put `null` last so the union reads `string | null`.
      const ordered = [...types].sort((a, b) =>
        Number(a === "null") - Number(b === "null")
      );
      return ordered.join(" | ");
    }
    case "array":
      return `${shapeTsType(shape.items, singular(nameHint))}[]`;
    case "object": {
      const entries = Object.entries(shape.fields);
      if (!entries.length) return "Record<string, unknown>";
      const body = entries.map(([field, { shape: s, optional }]) => {
        const hint = nameHint + pascal(field);
        return `  ${key(field)}${optional ? "?" : ""}: ${
          shapeTsType(s, hint)
        };`;
      }).join("\n");
      declareEntity(nameHint, body);
      return nameHint;
    }
  }
}

function declareEntity(name: string, body: string): void {
  if (entityDecls.has(name)) return;
  entityDecls.set(name, `export type ${name} = {\n${body}\n};\n`);
}

/**
 * Qualifies model type names with the `M.` import alias, leaving built-ins
 * (`Response`, `WriteEnvelope`, `unknown`, `Record<...>`) untouched. Applied
 * to type expressions only, never to doc comments.
 */
function qualify(typeExpr: string): string {
  return typeExpr.replace(
    /\b[A-Z][A-Za-z0-9]*\b/g,
    (name) => entityDecls.has(name) ? `M.${name}` : name,
  );
}

/**
 * Best response shape for a resource: `read.json` and `list.json` describe the
 * same entity, but `read` usually returns more fields while `list` gives far
 * more samples for optionality. Merging both yields the most accurate type.
 */
function entityShape(resource: string[]): Shape | undefined {
  const base = `/api/v1/${resource.join("/")}`;
  const candidates = [`${base}/read.json`, `${base}/list.json`]
    .map((p) => probed.responses[p])
    .filter((r): r is InferredResponse => Boolean(r) && !r.error);

  const shapes: Shape[] = candidates.map((r) =>
    r.shape.kind === "array" ? r.shape.items : r.shape
  ).filter((s) => s.kind === "object");

  if (!shapes.length) return undefined;
  return shapes.reduce(mergeForEntity);
}

/** The scalar a documented param type corresponds to in a JSON response. */
function docScalar(p: Param): "string" | "number" | "boolean" | undefined {
  switch (p.type) {
    case "NUMBER":
      return "number";
    case "BOOLEAN":
      return "boolean";
    case "TEXT":
    case "DATE":
    case "HTML":
    case "XML":
    case "CSV":
      return "string";
    default:
      return undefined;
  }
}

/**
 * Widens fields that were `null` in every sample.
 *
 * Probing can only observe the data one organisation happens to have, so an
 * always-empty column like `taxId` infers as bare `null`. The docs know it is
 * a NUMBER, so the honest type is `number | null`.
 *
 * Recurses into nested objects and arrays, because JSON params document their
 * inner shape too: without this, `order.items[].articleNr` and
 * `tax.rates[].dateValid` stay `unknown` and are unusable at a call site.
 */
function widenNullFields(shape: Shape, documented: Map<string, Param>): Shape {
  if (shape.kind === "array") {
    return { kind: "array", items: widenNullFields(shape.items, documented) };
  }
  if (shape.kind !== "object") return shape;

  const fields: Record<string, { shape: Shape; optional: boolean }> = {};
  for (const [name, field] of Object.entries(shape.fields)) {
    const param = documented.get(name);
    let next = field.shape;

    if (
      next.kind === "scalar" && next.types.length === 1 &&
      next.types[0] === "null"
    ) {
      const scalar = docScalar(param ?? ({} as Param));
      if (scalar) next = { kind: "scalar", types: [scalar, "null"] };
    } else if (next.kind === "object" || next.kind === "array") {
      next = widenNullFields(next, paramIndex(param?.fields ?? []));
    }

    fields[name] = { shape: next, optional: field.optional };
  }
  return { kind: "object", fields };
}

/** Indexes documented params by name, keeping the first definition seen. */
function paramIndex(params: Param[]): Map<string, Param> {
  const index = new Map<string, Param>();
  for (const param of params) {
    if (!index.has(param.name)) index.set(param.name, param);
  }
  return index;
}

/** Documented create/update params for a resource, indexed by name. */
function writableParams(endpoints: Endpoint[]): Map<string, Param> {
  return paramIndex(
    endpoints
      .filter((e) => /\/(create|update)\.json$/.test(e.path))
      .flatMap((e) => e.params),
  );
}

function mergeForEntity(a: Shape, b: Shape): Shape {
  if (a.kind !== "object" || b.kind !== "object") return a;
  const fields: Record<string, { shape: Shape; optional: boolean }> = {};
  for (
    const k of new Set([...Object.keys(a.fields), ...Object.keys(b.fields)])
  ) {
    const fa = a.fields[k];
    const fb = b.fields[k];
    if (fa && fb) {
      fields[k] = {
        shape: fa.shape.kind === "unknown" ? fb.shape : fa.shape,
        optional: fa.optional || fb.optional,
      };
    } else {
      fields[k] = { shape: (fa ?? fb).shape, optional: true };
    }
  }
  return { kind: "object", fields };
}

/* --------------------------------------------------------- resource tree -- */

interface Node {
  segments: string[];
  children: Map<string, Node>;
  endpoints: Endpoint[];
}

const tree: Node = { segments: [], children: new Map(), endpoints: [] };

for (const endpoint of spec.endpoints) {
  const { resource } = splitPath(endpoint.path);
  let node = tree;
  for (const segment of resource) {
    let child = node.children.get(segment);
    if (!child) {
      child = {
        segments: [...node.segments, segment],
        children: new Map(),
        endpoints: [],
      };
      node.children.set(segment, child);
    }
    node = child;
  }
  node.endpoints.push(endpoint);
}

/* -------------------------------------------------------------- emit TS -- */

const paramDecls: string[] = [];
const updateFieldDecls: string[] = [];
const declaredParams = new Set<string>();
const resourceDecls: string[] = [];
const collisions: string[] = [];

/**
 * Endpoints whose payload CashCtrl wraps in `{ data: ... }` by convention:
 * `list` and `tree` return an array, `read` a single object.
 *
 * This is decided by the verb, NOT by what probing observed. Probing only ever
 * ran against one organisation, and where it failed or was skipped (20 of
 * these endpoints) the generated method used to hand back the raw envelope
 * instead of unwrapping it. That made `file.category.read()` behave unlike
 * `tax.read()` for no reason a caller could see. Probe evidence refines the
 * element *type*; it does not decide the *shape*.
 */
function envelopeKind(endpoint: Endpoint): "array" | "object" | null {
  if (endpoint.method !== "GET") return null;
  const verb = splitPath(endpoint.path).verb;
  if (verb === "list.json" || verb === "tree.json") return "array";
  if (verb === "read.json") return "object";
  return null;
}

/** Return type for one endpoint, based on the API's conventions and probing. */
function returnType(endpoint: Endpoint, entity: string | undefined): string {
  const verb = splitPath(endpoint.path).verb;
  const probe = probed.responses[endpoint.path];

  // Binary/document endpoints are returned as a Response for streaming.
  if (/\.(pdf|xlsx|zip|csv|vcf|xml|html)$/.test(verb)) return "Response";

  if (endpoint.method === "POST") return "WriteEnvelope";

  // Conventional shapes win, so an unprobed `list` is still `T[]`.
  const envelope = envelopeKind(endpoint);
  if (envelope === "array") {
    if (probe && !probe.error && probe.shape.kind === "array") {
      const items = probe.shape.items;
      if (items.kind === "object" && entity) return `${entity}[]`;
      return `${shapeTsType(items, entityNameFor(endpoint))}[]`;
    }
    return entity ? `${entity}[]` : "unknown[]";
  }
  if (envelope === "object") {
    if (entity) return entity;
    if (probe && !probe.error && probe.shape.kind === "object") {
      return shapeTsType(probe.shape, entityNameFor(endpoint));
    }
    return "unknown";
  }

  if (probe && !probe.error) {
    if (probe.shape.kind === "array") {
      const items = probe.shape.items;
      if (items.kind === "object" && entity) return `${entity}[]`;
      return `${shapeTsType(items, entityNameFor(endpoint))}[]`;
    }
    if (probe.shape.kind === "object") {
      if (entity && (verb === "read.json" || verb === "list.json")) {
        return entity;
      }
      return shapeTsType(probe.shape, entityNameFor(endpoint));
    }
    return shapeTsType(probe.shape, entityNameFor(endpoint));
  }
  return "unknown";
}

function entityNameFor(endpoint: Endpoint): string {
  const { resource, verb } = splitPath(endpoint.path);
  return typeName(resource) + pascal(methodName(verb)) + "Result";
}

function emitNode(node: Node): string | undefined {
  const className = node.segments.length
    ? `${typeName(node.segments)}Resource`
    : undefined;
  if (!className) {
    for (const child of node.children.values()) emitNode(child);
    return undefined;
  }

  const entityName = typeName(node.segments);
  const shape = entityShape(node.segments);
  let entity: string | undefined;
  if (shape) {
    shapeTsType(
      widenNullFields(shape, writableParams(node.endpoints)),
      entityName,
    );
    entity = entityName;
  }

  const members: string[] = [];
  const used = new Set<string>();

  // Child resources become nested accessors, lazily constructed.
  const childFields: string[] = [];
  for (const child of node.children.values()) {
    const childClass = emitNode(child);
    if (!childClass) continue;
    const prop = propertyName(child.segments[child.segments.length - 1]);
    used.add(prop);
    childFields.push(
      `  /** Nested \`${child.segments.join("/")}\` endpoints. */\n` +
        `  readonly ${prop}: ${childClass};`,
    );
  }

  for (const endpoint of node.endpoints) {
    const { verb } = splitPath(endpoint.path);
    let name = methodName(verb);
    if (used.has(name)) {
      collisions.push(`${endpoint.path} -> ${name}`);
      name = `${name}Action`;
    }
    used.add(name);

    // Derived from the resolved method name so that `list.json`, `list.csv`
    // and `list.pdf` get distinct param types rather than colliding on "List".
    const paramsName = `${typeName(node.segments)}${pascal(name)}Params`;
    const hasParams = endpoint.params.length > 0;
    const allOptional = endpoint.params.every((p) => !p.required);
    if (hasParams && !declaredParams.has(paramsName)) {
      declaredParams.add(paramsName);
      paramDecls.push(
        paramsInterface(paramsName, endpoint.params, endpoint.path),
      );
    }

    const ret = qualify(returnType(endpoint, entity));
    const signature = hasParams
      ? `params${allOptional ? "?" : ""}: M.${paramsName}, signal?: AbortSignal`
      : `params?: Record<string, never>, signal?: AbortSignal`;

    const doc = jsdoc([
      endpoint.summary,
      endpoint.description,
      "",
      `\`${endpoint.method} ${endpoint.path}\``,
      `@see ${spec.source}#${endpoint.anchor}`,
    ], "  ");

    const body = callBody(endpoint, ret, hasParams);
    const isAsync = body.includes("(await ");
    members.push(
      `${doc}  ${isAsync ? "async " : ""}${name}(${signature}): ` +
        `Promise<${ret}> {\n${body}\n  }`,
    );
  }

  // CashCtrl update endpoints replace the whole record, so a caller who omits
  // a field silently clears it. Emit a read-modify-write helper alongside the
  // raw `update` for every resource that has one.
  // Requires documented params: without them there is no params type to merge
  // into, and nothing to preserve. `setting/update.json` is the one such case.
  const updateEndpoint = node.endpoints.find((e) =>
    e.path.endsWith("/update.json") && e.params.length > 0
  );
  if (updateEndpoint && entity) {
    const updateParamsName = `${typeName(node.segments)}UpdateParams`;
    const writable = updateEndpoint.params.map((p) => p.name);
    const fieldsConst = `${
      typeName(node.segments).toUpperCase()
    }_UPDATE_FIELDS`;
    updateFieldDecls.push(
      `/** Writable parameters of \`${updateEndpoint.path}\`. */\n` +
        `export const ${fieldsConst}: readonly string[] = ${
          JSON.stringify(writable)
        };\n`,
    );

    members.push(
      jsdoc([
        `Updates while preserving fields you do not pass.`,
        "",
        `\`${updateEndpoint.path}\` replaces the entire record: any writable ` +
        `parameter left out is treated as empty and cleared. This reads the ` +
        `current values from \`existing\` and applies \`changes\` on top, so ` +
        `only what you name actually changes.`,
        "",
        "```ts",
        `const current = await client.${
          node.segments.map(propertyName).join(".")
        }.read({ id });`,
        `await client.${node.segments.map(propertyName).join(".")}` +
        `.updatePreserving(current, { id, description: "New" });`,
        "```",
      ], "  ") +
        `  updatePreserving(\n` +
        `    existing: Readonly<Record<string, unknown>>,\n` +
        `    changes: Partial<M.${updateParamsName}>,\n` +
        `    signal?: AbortSignal,\n` +
        `  ): Promise<WriteEnvelope> {\n` +
        `    return this.update(\n` +
        `      mergeUpdate<M.${updateParamsName}>(existing, changes, ${fieldsConst}),\n` +
        `      signal,\n` +
        `    );\n` +
        `  }`,
    );
  }

  const ctorAssign = [...node.children.values()]
    .map((child) => {
      const prop = propertyName(child.segments[child.segments.length - 1]);
      return `    this.${prop} = new ${
        typeName(child.segments)
      }Resource(http);`;
    });

  const decl =
    `${jsdoc([`Endpoints under \`/api/v1/${node.segments.join("/")}\`.`])}` +
    `export class ${className} {\n` +
    `  readonly #http: CashCtrlHttp;\n` +
    (childFields.length ? childFields.join("\n") + "\n" : "") +
    `\n  constructor(http: CashCtrlHttp) {\n` +
    `    this.#http = http;\n` +
    (ctorAssign.length ? ctorAssign.join("\n") + "\n" : "") +
    `  }\n\n` +
    members.join("\n\n") +
    `\n}\n`;

  resourceDecls.push(decl);
  return className;
}

function callBody(endpoint: Endpoint, ret: string, hasParams: boolean): string {
  const args = hasParams ? "params" : "undefined";
  const path = JSON.stringify(endpoint.path);
  const method = JSON.stringify(endpoint.method);
  if (ret === "Response") {
    return `    return this.#http.raw(${method}, ${path}, ${args}, signal);`;
  }

  // Conventional envelopes first, so an unprobed `read` still unwraps `data`.
  const envelope = envelopeKind(endpoint);
  if (envelope === "array") {
    return `    return this.#http.list<${
      ret.replace(/\[\]$/, "")
    }>(${path}, ${args}, signal);`;
  }
  if (envelope === "object") {
    return `    return (await this.#http.get<{ data: ${ret} }>(${path}, ${args}, signal)).data;`;
  }

  // Anything else (balance, result, exchangerate, ...) follows the evidence.
  const probe = probed.responses[endpoint.path];
  if (endpoint.method === "GET" && probe?.envelope === "data" && !probe.error) {
    return `    return (await this.#http.get<{ data: ${ret} }>(${path}, ${args}, signal)).data;`;
  }
  return `    return this.#http.${
    endpoint.method === "GET" ? "get" : "post"
  }<${ret}>(${path}, ${args}, signal);`;
}

emitNode(tree);

const resourcesSource = resourceDecls.join("\n");

const header = (what: string) =>
  `// Generated by scripts/generate.ts - DO NOT EDIT.\n` +
  `// Source: ${spec.source}\n` +
  `// ${what}\n\n`;

await Deno.writeTextFile(
  root("src/generated/models.ts"),
  header(
    "Request parameters (from the docs) and entities (from live probing).",
  ) +
    `/* eslint-disable */\n\n` +
    [...entityDecls.values()].join("\n") +
    "\n" +
    paramDecls.join("\n"),
);

await Deno.writeTextFile(
  root("src/generated/resources.ts"),
  header("Typed resource classes, one per path segment.") +
    `import type { CashCtrlHttp, WriteEnvelope } from "../http.ts";\n` +
    `import { mergeUpdate } from "../merge.ts";\n` +
    `import type * as M from "./models.ts";\n\n` +
    updateFieldDecls.join("") + "\n" +
    resourcesSource,
);

console.log(
  `models.ts:    ${entityDecls.size} entities, ${paramDecls.length} param interfaces`,
);
console.log(`resources.ts: ${resourceDecls.length} resource classes`);
if (collisions.length) {
  console.log(`name collisions renamed: ${collisions.join(", ")}`);
}

/* ------------------------------------------------------------- OpenAPI  -- */

function openApiParamSchema(p: Param): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  if (p.description) base.description = p.description;
  switch (p.type) {
    case "NUMBER":
      base.type = "number";
      break;
    case "BOOLEAN":
      base.type = "boolean";
      break;
    case "DATE":
      base.type = "string";
      base.format = "date";
      base.example = "2026-07-27";
      break;
    case "CSV":
      base.type = "string";
      base.description = `${p.description} (comma-separated list)`.trim();
      break;
    case "JSON":
      base.type = "string";
      base.contentMediaType = "application/json";
      if (p.fields?.length) {
        const item = {
          type: "object",
          properties: Object.fromEntries(
            p.fields.map((f) => [f.name, openApiParamSchema(f)]),
          ),
          required: p.fields.filter((f) => f.required).map((f) => f.name),
        };
        base.contentSchema = p.isArray ? { type: "array", items: item } : item;
      }
      break;
    case "XML":
      base.type = "string";
      base.contentMediaType = "application/xml";
      break;
    case "HTML":
      base.type = "string";
      base.contentMediaType = "text/html";
      break;
    case "TEXT":
      base.type = "string";
      break;
  }
  if (p.maxLength) base.maxLength = p.maxLength;
  if (p.enum?.length && p.type !== "BOOLEAN") base.enum = p.enum;
  if (p.default !== undefined) base.default = p.default;
  return base;
}

function shapeToJsonSchema(shape: Shape): Record<string, unknown> {
  switch (shape.kind) {
    case "unknown":
      return {};
    case "scalar": {
      const nonNull = shape.types.filter((t) => t !== "null");
      const types = shape.types.includes("null")
        ? [...nonNull, "null"]
        : nonNull;
      return { type: types.length === 1 ? types[0] : types };
    }
    case "array":
      return { type: "array", items: shapeToJsonSchema(shape.items) };
    case "object":
      return {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(shape.fields).map((
            [k, v],
          ) => [k, shapeToJsonSchema(v.shape)]),
        ),
        required: Object.entries(shape.fields)
          .filter(([, v]) => !v.optional)
          .map(([k]) => k),
      };
  }
}

function responseSchema(endpoint: Endpoint): Record<string, unknown> {
  const probe = probed.responses[endpoint.path];
  if (endpoint.method === "POST" || !probe || probe.error) {
    return endpoint.method === "POST"
      ? { $ref: "#/components/schemas/WriteResponse" }
      : {};
  }
  const payload = shapeToJsonSchema(probe.shape);
  if (probe.envelope === "data") {
    return {
      type: "object",
      properties: {
        success: { type: "boolean" },
        total: { type: "integer" },
        data: payload,
      },
      required: ["data"],
    };
  }
  return payload;
}

const paths: Record<string, Record<string, unknown>> = {};
for (const endpoint of spec.endpoints) {
  // Include the format suffix, or `list.json`/`list.csv`/`list.pdf` would all
  // collapse onto the same operationId.
  const { resource, verb } = splitPath(endpoint.path);
  const operation: Record<string, unknown> = {
    operationId: camel(resource.join("-")) + pascal(methodName(verb)),
    summary: endpoint.summary,
    description: endpoint.description,
    tags: [endpoint.group[0] ?? "General"],
    externalDocs: { url: `${spec.source}#${endpoint.anchor}` },
    responses: {
      "200": {
        description:
          "Success. Note that write endpoints return 200 even when validation fails; check `success`.",
        content: { "application/json": { schema: responseSchema(endpoint) } },
      },
      "401": { $ref: "#/components/responses/Unauthorized" },
      "403": { $ref: "#/components/responses/Forbidden" },
      "429": { $ref: "#/components/responses/RateLimited" },
    },
  };

  if (endpoint.method === "GET") {
    operation.parameters = endpoint.params.map((p) => ({
      name: p.name,
      in: "query",
      required: p.required,
      schema: openApiParamSchema(p),
    }));
  } else if (endpoint.params.length) {
    operation.requestBody = {
      required: endpoint.params.some((p) => p.required),
      content: {
        "application/x-www-form-urlencoded": {
          schema: {
            type: "object",
            properties: Object.fromEntries(
              endpoint.params.map((p) => [p.name, openApiParamSchema(p)]),
            ),
            required: endpoint.params.filter((p) => p.required).map((p) =>
              p.name
            ),
          },
        },
      },
    };
  }

  (paths[endpoint.path] ??= {})[endpoint.method.toLowerCase()] = operation;
}

const openapi = {
  openapi: "3.1.0",
  info: {
    title: "CashCtrl API",
    version: "1.0.0",
    description:
      "Unofficial OpenAPI description of the CashCtrl REST API, generated from " +
      "the published HTML reference. Request parameters come from the docs; " +
      "response schemas are inferred from live read-only calls and are " +
      "therefore best-effort. CashCtrl publishes no official spec.",
    license: { name: "MIT", identifier: "MIT" },
  },
  servers: [{
    url: "https://{organisation}.cashctrl.com/api/v1",
    variables: {
      organisation: {
        default: "myorg",
        description: "Your CashCtrl subdomain",
      },
    },
  }],
  security: [{ basicAuth: [] }],
  components: {
    securitySchemes: {
      basicAuth: {
        type: "http",
        scheme: "basic",
        description: "API key as the username; leave the password empty.",
      },
    },
    schemas: {
      WriteResponse: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          message: { type: "string" },
          insertId: { type: "integer" },
          errors: {
            type: "array",
            items: {
              type: "object",
              properties: {
                field: { type: ["string", "null"] },
                message: { type: "string" },
              },
            },
          },
        },
        required: ["success"],
      },
    },
    responses: {
      Unauthorized: { description: "No valid API key provided." },
      Forbidden: { description: "The API key lacks permission." },
      RateLimited: { description: "Too many requests." },
    },
  },
  paths,
};

await Deno.writeTextFile(
  root("spec/openapi.json"),
  JSON.stringify(openapi, null, 2) + "\n",
);
console.log(`openapi.json: ${Object.keys(paths).length} paths`);
