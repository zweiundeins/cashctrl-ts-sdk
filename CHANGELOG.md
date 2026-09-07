# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the version is below `1.0.0`, generated type names and shapes may change
in minor releases as response inference improves.

## [Unreleased]

### Added

- `deno task write-test`: a write-path harness that drives all 192 POST
  endpoints against a disposable organisation, in ten dependency-ordered suites
  (master data, accounts, files, people, inventory, journal, orders, bank
  import, salary, year-end). Every call goes through the generated method, and a
  recording `fetch` produces a coverage report against `spec/api.json`, so write
  coverage is measured rather than asserted. `--dry-run` runs the whole thing
  offline against a stub, for checking the suites reach what they claim without
  touching an organisation.
- The harness reads `CASHCTRL_TEST_DOMAINID`/`CASHCTRL_TEST_APIKEY` only, and
  refuses to run when they resolve to the same organisation as
  `CASHCTRL_DOMAINID`/`CASHCTRL_APIKEY` or when the target is not repeated as
  `--org=`.

### Documented

- README records what running the whole write surface against a live
  organisation revealed: three endpoints the generated methods cannot call at
  all (`customfield/reorder`, `customfield/group/reorder`, `setting/read`), four
  parameters typed `string` that are really JSON, thirteen parameters documented
  as optional that the server requires, and four server-side faults. None of
  these are fixed yet; they are recorded so a fix can be scoped.

## [0.4.0] - 2026-09-04

Better inferred types, from probing more of the API and merging what it finds
more carefully. No breaking changes to the request surface; response types on
several endpoints become more specific, which can surface existing mistakes at
compile time.

### Added

- The prober reaches endpoints whose mandatory parameter the sibling-list
  convention cannot supply, via a `FIXTURES` table and several passes so chains
  resolve. 13 endpoints gained real types, among them `customfield/list`,
  `journal/import/entry/list`, `order/bookentry/list`,
  `order/category/read_status` and `report/element/data`. Coverage went from 95
  to 108 of 376.
- Up to three records are sampled per endpoint instead of one, so a field that
  is null on the first record can still be typed from the third.
- A mandatory parameter with documented values is probed once per value.
- Period-dependent endpoints are probed once per fiscal period.

### Fixed

- `mergeForEntity` only preferred the known side when the _whole_ shape was
  unknown, so an array that was empty in `read.json` beat the same array
  populated in `list.json`. It recurses now: `openMonthIds` is `string[]` rather
  than `unknown[]`, and `bookTemplates` is a typed object array rather than
  `unknown[]`.
- Tree types stopped at whatever depth the sample happened to reach, emitting
  `XData`, `XDataData` and so on. Where a nested array's element type is
  structurally its parent, it is folded into a self-reference:
  `ReportTreeResult.data` and `ReportElementDataResult.data` are recursive now.
- `report/element/data.json` was typed as returning the resource's entity
  (`ReportElement[]`) because any array response was assumed to be a list of the
  resource. It returns report _rows_, not report element definitions, and now
  has its own type.
- A failed probe no longer replaces a good shape with `unknown`. The weekly job
  is unattended, and a transient upstream 500 silently downgrading the generated
  types is worse than leaving them stale.
- Order and salary document reads are denied to the prober: fetching one appends
  a `DOWNLOAD` entry to the organisation's history log.

## [0.3.0] - 2026-09-04

**Upgrade from 0.2.0.** Four methods change their return type from
`Promise<unknown>` to `Promise<Response>`: `file.get()`,
`domain.current.logo()`, `order.payment.download()` and
`salary.payment.download()`. Nothing was calling them successfully — they parsed
their file body as JSON and threw — so there is no working code to migrate.
Await `.arrayBuffer()` or `.text()` on the result, as with the other document
endpoints.

### Fixed

- Four endpoints that return a file had no format suffix to give them away, so
  they were generated as JSON calls: `file.get()`, `domain.current.logo()`,
  `order.payment.download()` and `salary.payment.download()` tried to
  `JSON.parse` a PDF and threw. They now return a raw `Response` like every
  other document endpoint. **Breaking** for anyone calling them, though there
  was no working call to break.
- `spec/openapi.json` declared `application/json` for all 376 responses,
  including the 59 that return a file. Those now carry their real media type
  (`application/pdf`, `text/csv`, `application/octet-stream`, ...) and a
  `{type: string, format: binary}` schema, so generators and API clients built
  from the spec stop expecting JSON.

### Added

- `SIDE_EFFECTING_GETS` and `isSideEffectingGet()`, the two GET endpoints that
  mutate state (`fiscalperiod/reopen_months.json` reopens closed months,
  `sequencenumber/get` consumes a number). Previously this list lived inside the
  probe script; it is exported now because any read-only consumer needs it.
- `spec/index.json` and `deno task index`: the whole API surface without
  response schemas, 450 KB instead of 1.9 MB, for tools that have to search all
  376 endpoints rather than call one.

## [0.2.0] - 2026-07-27

**Upgrade from 0.1.0.** Every `delete` method in 0.1.0 was named `delete_` and
so was unreachable in practice, and 16 read endpoints returned the raw response
envelope instead of the payload. Both are fixed here.

### Added

- npm publishing alongside JSR, built with `@deno/dnt`. The package ships ESM
  and CommonJS with declarations, has zero dependencies and needs Node 18+.
  Verified consumable from plain Node in both module systems, and TypeScript
  declarations resolve for npm consumers.
- Weekly `upstream` workflow that re-scrapes the CashCtrl reference,
  regenerates, and opens a PR when the API changed.
- `scripts/diff-spec.ts`, which renders the difference between two scraped specs
  as a readable summary (endpoints added or removed, parameters added, removed
  or retyped) rather than an unreadable generated-code diff.
- `updatePreserving()` on the 33 resources that have an `update` endpoint, plus
  the underlying `mergeUpdate()` helper. CashCtrl's update endpoints are full
  replacements: "all parameters must be submitted, omitted parameters are
  treated as empty values", so calling `update` with a partial payload silently
  wipes every field left out. `updatePreserving` does the read-modify-write,
  resending the record's current values for the writable params and dropping
  read-only ones like `created` and `subTotal`.
- `scripts/overrides.ts`, a small reviewed list of places where CashCtrl's
  documentation contradicts the API's real behaviour, each with its evidence.
- `tests/contract_test.ts`, which calls all 376 generated methods against a mock
  transport and asserts the HTTP verb, URL path, parameter transmission and
  encoding for every documented parameter. Expected encodings are written
  independently of the SDK's serializer so a bug cannot be mirrored into the
  expectation. Mutation-tested against six injected faults.
- `scripts/roundtrip-test.ts` (`deno task roundtrip`), which performs real
  create/read/update/updatePreserving/delete cycles against a live organisation
  and verifies nothing is left behind. Safe on a production organisation by
  construction: it is limited to master data with no accounting effect and no
  sequence-assigned `nr`, because creating an order, person, article or salary
  statement consumes a sequence number that deletion does not return.

### Fixed

- **Every `delete` endpoint was generated as `delete_`.** The generator escaped
  JavaScript keywords, but keywords are reserved for identifiers, not for method
  names: `delete(...)` is a legal class member. All 33 delete methods were
  therefore named something no caller would reach for. Found by a live
  round-trip that called `.delete()`, silently deleted nothing, and left records
  behind. The contract test had missed it because it resolved methods through
  the same naming function, so it looked up `delete_`, found it, and passed;
  there is now a separate test asserting idiomatic CRUD names spelled out by
  hand.
- **20 `read`/`list`/`tree` endpoints returned the raw `{success, data}`
  envelope** instead of the unwrapped payload, because live probing had failed
  or been skipped for them. Whether a method unwrapped its response therefore
  depended on which organisation happened to be probed, so
  `file.category.read()` behaved unlike `tax.read()` for no visible reason.
  Unwrapping now follows the API's documented convention by verb; probe evidence
  only refines the element type.
- Nested response fields that were `null` in every sample stayed `unknown` and
  were unusable at a call site. Widening now recurses into nested objects and
  arrays, so `order.items[].articleNr` and `tax.rates[].dateValid` get their
  documented types.
- `order.items[].unitId` is documented TEXT but is a foreign key to a numeric
  unit id; it now accepts `string | number`.
- `filter[].value` on list endpoints is documented TEXT but is routinely used
  with numeric ids and booleans; it now accepts `string | number | boolean`.

## [0.1.0] - 2026-07-27

Initial release. **Superseded by 0.2.0; do not use.** All 33 `delete` methods
were generated as `delete_` and 16 read endpoints did not unwrap their response
envelope.

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
- Request parameter types for all 342 endpoints that take parameters, including
  documented enums, defaults, max lengths and nested JSON shapes.
- Entity types for 74 resources, inferred from live responses.
- Transport handling for the API's quirks: form-encoded bodies despite JSON
  responses, `JSON` params serialized to JSON strings, `CSV` params joined with
  commas, `Date` objects formatted as `YYYY-MM-DD`, and an explicit `null` sent
  as an empty string to clear a field (as distinct from `undefined`, which omits
  it).
- Validation failures arrive from CashCtrl as HTTP 200 with `success: false`;
  these are promoted to a thrown `CashCtrlValidationError` carrying per-field
  messages via `byField()`.
- `CashCtrlAuthError` (401/403), `CashCtrlRateLimitError` (429) and
  `CashCtrlHttpError` for transport failures, with automatic exponential backoff
  on 429 and 5xx.
- Helpers for CashCtrl's localized-text format, which encodes translations as
  `<values><de>Kasse</de><en>Cash</en></values>` rather than JSON: `localize`,
  `parseLocalized`, `toLocalized` and `isLocalized`.
- Document endpoints (PDF/XLSX/CSV/ZIP/vCard) return the raw `Response` for
  streaming.
- `cc.http` escape hatch for calling endpoints directly.

### Notes

- Zero dependencies, `fetch`-only. Verified on Deno 2.7, Node 22 and Bun 1.3.
- The source is erasable-syntax-only (`erasableSyntaxOnly` is enforced at
  typecheck), so it runs under `node --experimental-strip-types`.
- Request parameters come from the official docs and are authoritative. Response
  types are inferred from one organisation's live data across 95 of 376
  endpoints, so they are best-effort. See the README's Caveats section.

[Unreleased]: https://github.com/zweiundeins/cashctrl-ts-sdk/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/zweiundeins/cashctrl-ts-sdk/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/zweiundeins/cashctrl-ts-sdk/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/zweiundeins/cashctrl-ts-sdk/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/zweiundeins/cashctrl-ts-sdk/releases/tag/v0.1.0
