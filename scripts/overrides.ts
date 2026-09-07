/**
 * Corrections to the scraped spec, for places where CashCtrl's published
 * documentation does not match the API's actual behaviour.
 *
 * The scraper is deliberately faithful: it reproduces what the docs say, right
 * or wrong. This file is the single, reviewable place where we knowingly
 * deviate. Every entry must record the evidence for the deviation, so it can
 * be re-checked when upstream changes.
 *
 * Keep this list as short as possible. If a type is merely awkward rather than
 * wrong, leave it alone.
 */

import type { Endpoint, Param } from "./ir.ts";

/** Widens a parameter's generated TypeScript type. */
export interface TypeOverride {
  /** Endpoint path, or "*" to apply to every endpoint. */
  path: string;
  /** Param name; use "items.unitId" to target a field of a JSON param. */
  param: string;
  /** TypeScript type to emit instead of the scraped one. */
  tsType: string;
  /** Why the docs are wrong, and how we know. */
  reason: string;
}

export const TYPE_OVERRIDES: TypeOverride[] = [
  {
    path: "/api/v1/order/create.json",
    param: "items.unitId",
    tsType: "string | number",
    reason:
      "Documented as TEXT, but it is a foreign key to Units, whose `id` is a " +
      "NUMBER. Production code has posted numeric unitId values successfully " +
      "for a long time, so the API accepts both. Typing it as string alone " +
      "would force every caller to stringify an id they just read as a number.",
  },
  {
    path: "/api/v1/order/update.json",
    param: "items.unitId",
    tsType: "string | number",
    reason: "Same as order/create.json.",
  },
  {
    path: "*",
    param: "filter.value",
    tsType: "string | number | boolean",
    reason:
      "Documented as TEXT on every list endpoint, but filters are routinely " +
      "applied to numeric columns (associateId, categoryId) and boolean " +
      "flags. The value is form-encoded to a string on the way out either " +
      "way, so accepting the caller's original type avoids a stringify " +
      "dance at every call site.",
  },
];

/**
 * Looks up an override for a (possibly nested) parameter.
 * An exact path match wins over a `"*"` wildcard entry.
 */
export function findOverride(
  path: string,
  paramPath: string,
): TypeOverride | undefined {
  return TYPE_OVERRIDES.find((o) => o.path === path && o.param === paramPath) ??
    TYPE_OVERRIDES.find((o) => o.path === "*" && o.param === paramPath);
}

/* ------------------------------------------------------ missing params -- */

/**
 * A parameter the API requires but the reference does not mention at all.
 *
 * A wrong type is recoverable - a caller can cast. A missing parameter is
 * not: the generated params type has no field for it, so the endpoint cannot
 * be called through the typed surface at all, whatever the caller does.
 */
export interface ParamAddition {
  /** Endpoint path the parameter belongs to. */
  path: string;
  /** The parameter, as the reference would have described it. */
  param: Param;
  /** Why we believe it exists, and how we know. */
  reason: string;
}

export const PARAM_ADDITIONS: ParamAddition[] = [
  {
    path: "/api/v1/customfield/reorder.json",
    param: {
      name: "type",
      type: "TEXT",
      required: true,
      description:
        "The module the custom fields belong to. Undocumented, but the " +
        "request fails without it. Possible values: JOURNAL, ACCOUNT, " +
        "INVENTORY_ARTICLE, INVENTORY_ASSET, ORDER, PERSON, FILE, " +
        "SALARY_STATEMENT.",
      enum: [
        "JOURNAL",
        "ACCOUNT",
        "INVENTORY_ARTICLE",
        "INVENTORY_ASSET",
        "ORDER",
        "PERSON",
        "FILE",
        "SALARY_STATEMENT",
      ],
    },
    reason:
      "The reference lists only ids, target and before. Posting exactly " +
      "those returns success: false with the message 'Type is missing' and " +
      "no field errors; adding type=PERSON succeeds. Verified against a " +
      "live organisation on 2026-09-07. The value set matches " +
      "customfield/create's own `type`, which selects the same module.",
  },
  {
    path: "/api/v1/customfield/group/reorder.json",
    param: {
      name: "type",
      type: "TEXT",
      required: true,
      description:
        "The module the custom field groups belong to. Undocumented, but " +
        "the request fails without it. Possible values: JOURNAL, ACCOUNT, " +
        "INVENTORY_ARTICLE, INVENTORY_ASSET, ORDER, PERSON, FILE, " +
        "SALARY_STATEMENT.",
      enum: [
        "JOURNAL",
        "ACCOUNT",
        "INVENTORY_ARTICLE",
        "INVENTORY_ASSET",
        "ORDER",
        "PERSON",
        "FILE",
        "SALARY_STATEMENT",
      ],
    },
    reason: "Same as customfield/reorder.json, verified the same way.",
  },
];

/** Extra parameters documented nowhere, keyed by endpoint. */
export function addedParams(path: string): Param[] {
  return PARAM_ADDITIONS.filter((a) => a.path === path).map((a) => a.param);
}

/**
 * Folds the undocumented parameters into a freshly read spec, in place.
 *
 * Every consumer of `spec/api.json` has to do this - the generated client,
 * the OpenAPI document and the search index - or they disagree about what an
 * endpoint takes, and the one that disagrees is the one an agent reads.
 */
export function applyParamAdditions(
  spec: { endpoints: { path: string; params: Param[] }[] },
): void {
  for (const endpoint of spec.endpoints) {
    const extra = addedParams(endpoint.path);
    if (!extra.length) continue;
    const known = new Set(endpoint.params.map((p) => p.name));
    endpoint.params.push(...extra.filter((p) => !known.has(p.name)));
  }
}

/* -------------------------------------------------------- open params -- */

/**
 * Endpoints that take caller-chosen keys rather than a fixed parameter list.
 *
 * The scraper finds no parameters for these, which would otherwise generate
 * `params?: Record<string, never>` - a signature that cannot express any
 * request at all.
 */
export interface OpenParams {
  path: string;
  /** TypeScript type to emit for the whole params object. */
  tsType: string;
  reason: string;
}

export const OPEN_PARAM_ENDPOINTS: OpenParams[] = [
  {
    path: "/api/v1/setting/update.json",
    tsType: "Record<string, string | number | boolean | null>",
    reason:
      "The reference documents no parameters, but the endpoint takes the " +
      "same keys setting/read.json returns (THOUSAND_SEPARATOR, " +
      "CSV_DELIMITER, DEFAULT_SEQUENCE_NUMBER_PERSON, ...). Posting " +
      "{ THOUSAND_SEPARATOR: '.' } answers 'Settings saved' and the value " +
      "reads back changed; posting the old value restores it. Verified " +
      "against a live organisation on 2026-09-07. The key set is per " +
      "organisation, so it cannot be enumerated in the type.",
  },
];

export function openParams(path: string): OpenParams | undefined {
  return OPEN_PARAM_ENDPOINTS.find((o) => o.path === path);
}

/* -------------------------------------------------- structured params -- */

/**
 * CashCtrl documents a structured parameter by giving it a nested parameter
 * table. The scraper records that as `fields`, faithfully, alongside whatever
 * type the docs claim - and for 19 params the claimed type is TEXT.
 *
 * A sub-table *is* the statement that the value is structured: there is
 * nothing else it could mean, and CashCtrl types the other 116 such params
 * JSON itself. So this is one rule rather than nineteen entries, and it costs
 * nothing when upstream fixes the type - the param is already JSON and the
 * rule does not fire.
 *
 * Without it the generator sees `type: "TEXT"`, never looks at `fields`, and
 * emits `string` for a parameter whose shape is fully documented - which is
 * how `person.addresses` came to be typed `string` despite its eleven
 * documented fields.
 */
export function applyDocumentedShapes(
  spec: { endpoints: { params: Param[] }[] },
): void {
  for (const endpoint of spec.endpoints) {
    for (const param of endpoint.params) {
      if (param.fields?.length && param.type !== "JSON") param.type = "JSON";
    }
  }
}

/**
 * Params that are arrays although their description omits the "This is a JSON
 * array" wording the scraper keys on.
 *
 * Narrower than the rule above on purpose: `isArray` cannot be inferred from
 * the presence of a sub-table, since plenty of JSON params are a single
 * object.
 */
export interface ArrayCorrection {
  path: string;
  param: string;
  reason: string;
}

export const ARRAY_CORRECTIONS: ArrayCorrection[] = [
  {
    path: "/api/v1/tax/create.json",
    param: "components",
    reason:
      "Described as 'the components of the tax code, up to two possible' - " +
      "plural, but without the array wording. tax/read.json returns an " +
      "array, and create only accepts one: a single object is rejected. " +
      "Verified against a live organisation on 2026-09-07.",
  },
  {
    path: "/api/v1/tax/update.json",
    param: "components",
    reason: "Same as tax/create.json.",
  },
  {
    path: "/api/v1/tax/create.json",
    param: "rates",
    reason: "Same as components: read returns an array, and the description " +
      "itself says exactly one rate must have no dateValid, which only " +
      "makes sense for a list.",
  },
  {
    path: "/api/v1/tax/update.json",
    param: "rates",
    reason: "Same as tax/create.json.",
  },
  {
    path: "/api/v1/salary/statement/update_multiple.json",
    param: "attachments",
    reason:
      "'List of file attachments (overrides existing attachments)' with the " +
      "same single fileId field as salary/statement/create and /update, " +
      "both of which CashCtrl types as JSON arrays. Only the boilerplate " +
      "sentence the scraper keys on is missing.",
  },
];

export function applyArrayCorrections(
  spec: { endpoints: { path: string; params: Param[] }[] },
): void {
  for (const correction of ARRAY_CORRECTIONS) {
    const endpoint = spec.endpoints.find((e) => e.path === correction.path);
    const param = endpoint?.params.find((p) => p.name === correction.param);
    if (param) param.isArray = true;
  }
}

/**
 * Every correction, in the order they depend on each other.
 *
 * Each consumer of `spec/api.json` calls this - the generated client, the
 * OpenAPI document, the search index and the contract test - because a
 * consumer that skips it disagrees with the others about what an endpoint
 * takes, and the one that disagrees is the one somebody reads.
 */
export function applySpecCorrections(spec: { endpoints: Endpoint[] }): void {
  applyParamAdditions(spec);
  applyDocumentedShapes(spec);
  applyArrayCorrections(spec);
}
