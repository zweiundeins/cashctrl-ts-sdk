# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the version is below `1.0.0`, generated type names and shapes may change
in minor releases as response inference improves.

## [Unreleased]

### Added

- npm publishing alongside JSR, built with `@deno/dnt`. The package ships ESM
  and CommonJS with declarations, has zero dependencies and needs Node 18+.
  Verified consumable from plain Node in both module systems, and TypeScript
  declarations resolve for npm consumers.
- Weekly `upstream` workflow that re-scrapes the CashCtrl reference,
  regenerates, and opens a PR when the API changed.
- `scripts/diff-spec.ts`, which renders the difference between two scraped
  specs as a readable summary (endpoints added or removed, parameters added,
  removed or retyped) rather than an unreadable generated-code diff.
- `updatePreserving()` on the 33 resources that have an `update` endpoint,
  plus the underlying `mergeUpdate()` helper. CashCtrl's update endpoints are
  full replacements: "all parameters must be submitted, omitted parameters are
  treated as empty values", so calling `update` with a partial payload
  silently wipes every field left out. `updatePreserving` does the
  read-modify-write, resending the record's current values for the writable
  params and dropping read-only ones like `created` and `subTotal`.
- `scripts/overrides.ts`, a small reviewed list of places where CashCtrl's
  documentation contradicts the API's real behaviour, each with its evidence.

### Fixed

- Nested response fields that were `null` in every sample stayed `unknown` and
  were unusable at a call site. Widening now recurses into nested objects and
  arrays, so `order.items[].articleNr` and `tax.rates[].dateValid` get their
  documented types.
- `order.items[].unitId` is documented TEXT but is a foreign key to a numeric
  unit id; it now accepts `string | number`.
- `filter[].value` on list endpoints is documented TEXT but is routinely used
  with numeric ids and booleans; it now accepts `string | number | boolean`.

## [0.1.0] - 2026-07-27

Initial release.

### Added

- Typed client covering all **376 CashCtrl API endpoints**, generated from the
  published HTML reference. Resources mirror the API's own path structure, so
  `POST /api/v1/account/costcenter/category/create.json` is
  `cc.account.costcenter.category.create({...})`.
- **OpenAPI 3.1 document** (`spec/openapi.json`) for all 376 endpoints,
  validated with `redocly lint`. CashCtrl publishes no official spec.
- Three-stage generation pipeline: `scrape-docs.ts` parses the HTML reference,
  `probe-api.ts` infers response shapes from live read-only calls, and
  `generate.ts` emits the SDK and the spec.
- Request parameter types for all 342 endpoints that take parameters,
  including documented enums, defaults, max lengths and nested JSON shapes.
- Entity types for 74 resources, inferred from live responses.
- Transport handling for the API's quirks: form-encoded bodies despite JSON
  responses, `JSON` params serialized to JSON strings, `CSV` params joined
  with commas, `Date` objects formatted as `YYYY-MM-DD`, and an explicit
  `null` sent as an empty string to clear a field (as distinct from
  `undefined`, which omits it).
- Validation failures arrive from CashCtrl as HTTP 200 with `success: false`;
  these are promoted to a thrown `CashCtrlValidationError` carrying per-field
  messages via `byField()`.
- `CashCtrlAuthError` (401/403), `CashCtrlRateLimitError` (429) and
  `CashCtrlHttpError` for transport failures, with automatic exponential
  backoff on 429 and 5xx.
- Helpers for CashCtrl's localized-text format, which encodes translations as
  `<values><de>Kasse</de><en>Cash</en></values>` rather than JSON:
  `localize`, `parseLocalized`, `toLocalized` and `isLocalized`.
- Document endpoints (PDF/XLSX/CSV/ZIP/vCard) return the raw `Response` for
  streaming.
- `cc.http` escape hatch for calling endpoints directly.

### Notes

- Zero dependencies, `fetch`-only. Verified on Deno 2.7, Node 22 and Bun 1.3.
- The source is erasable-syntax-only (`erasableSyntaxOnly` is enforced at
  typecheck), so it runs under `node --experimental-strip-types`.
- Request parameters come from the official docs and are authoritative.
  Response types are inferred from one organisation's live data across 95 of
  376 endpoints, so they are best-effort. See the README's Caveats section.

[Unreleased]: https://github.com/zweiundeins/cashctrl-ts-sdk/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/zweiundeins/cashctrl-ts-sdk/releases/tag/v0.1.0
