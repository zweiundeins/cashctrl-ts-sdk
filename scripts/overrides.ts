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
