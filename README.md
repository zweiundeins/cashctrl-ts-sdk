# cashctrl-ts-sdk

[![JSR](https://jsr.io/badges/@zweiundeins/cashctrl-ts-sdk)](https://jsr.io/@zweiundeins/cashctrl-ts-sdk)
[![npm](https://img.shields.io/npm/v/@zweiundeins/cashctrl-ts-sdk)](https://www.npmjs.com/package/@zweiundeins/cashctrl-ts-sdk)
[![CI](https://github.com/zweiundeins/cashctrl-ts-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/zweiundeins/cashctrl-ts-sdk/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A typed TypeScript client for the [CashCtrl](https://cashctrl.com) accounting
API, covering all **376 endpoints**.

CashCtrl publishes no OpenAPI spec and no official SDK, so this repo generates
both: endpoints and request parameters are scraped from the
[published HTML reference](https://app.cashctrl.com/static/help/en/api/index.html),
and response types are inferred from live read-only API calls.

Zero dependencies, `fetch`-only. Verified on Deno 2.7, Node 22 and Bun 1.3.

> Unofficial and not affiliated with CashCtrl.

## Install

Published to both registries from the same source.

```sh
deno add jsr:@zweiundeins/cashctrl-ts-sdk    # Deno
npm  install @zweiundeins/cashctrl-ts-sdk    # Node
bun  add     @zweiundeins/cashctrl-ts-sdk    # Bun
pnpm add     @zweiundeins/cashctrl-ts-sdk
```

```ts
import { CashCtrl } from "@zweiundeins/cashctrl-ts-sdk";
```

The npm build ships ESM and CommonJS with `.d.ts` declarations, has zero
dependencies, and requires Node 18+. It does not depend on Deno at install or
run time. The SDK source uses no Deno APIs; only the build tooling is Deno.

You need an API key: in CashCtrl, go to **Settings > Users & Roles > Add > Add
API user**. The key is scoped to a single organisation and inherits the role you
assign it.

## Usage

Resources mirror the API's own path structure, so
`POST /api/v1/account/costcenter/category/create.json` is
`cc.account.costcenter.category.create({...})`.

```ts
import { CashCtrl } from "@zweiundeins/cashctrl-ts-sdk";

const cc = new CashCtrl({
  organisation: "myorg", // the subdomain of myorg.cashctrl.com
  apiKey: process.env.CASHCTRL_APIKEY!,
  lang: "de", // language for error messages and generated PDFs
});

// Lists unwrap the `data` envelope for you.
const accounts = await cc.account.list({ onlyActive: true, dir: "ASC" });

// Reads return the single entity, not the envelope.
const account = await cc.account.read({ id: accounts[0].id });

// Writes return { success, insertId, ... }.
const { insertId } = await cc.person.create({
  categoryId: 1,
  company: "ACME AG",
});

// Nested JSON params are typed all the way down.
await cc.order.create({
  associateId: insertId!,
  categoryId: 4,
  date: new Date(),
  items: [
    { accountId: 42, name: "Consulting", unitPrice: 180, quantity: 8 },
  ],
});
```

Every method takes an optional trailing `AbortSignal`.

### Errors

CashCtrl returns **HTTP 200 for validation failures**, with `success: false` in
the body. The SDK promotes those to a thrown error so they cannot be missed:

```ts
import { CashCtrlValidationError } from "@zweiundeins/cashctrl-ts-sdk";

try {
  await cc.journal.create({ amount: 0, debitId: 0, creditId: 0 });
} catch (err) {
  if (err instanceof CashCtrlValidationError) {
    console.log(err.byField()); // { debitId: ["This field cannot be empty."] }
  }
}
```

| Error                     | When                           |
| ------------------------- | ------------------------------ |
| `CashCtrlValidationError` | HTTP 200 with `success: false` |
| `CashCtrlAuthError`       | 401, 403                       |
| `CashCtrlRateLimitError`  | 429, carries `retryAfter`      |
| `CashCtrlHttpError`       | any other non-2xx              |

429 and 5xx are retried with exponential backoff by default. Configure with
`retry: { attempts, baseDelayMs }`, or `attempts: 0` to disable.

### Parameter encoding

The API is form-encoded even though it returns JSON, so the SDK flattens
structured values for you:

| You pass                  | Sent as                  |
| ------------------------- | ------------------------ |
| `true`                    | `"true"`                 |
| `new Date(2026, 6, 27)`   | `"2026-07-27"`           |
| `[1, 2, 3]` (a CSV param) | `"1,2,3"`                |
| `[{...}]` (a JSON param)  | `'[{"...":...}]'`        |
| `null`                    | `""`, clearing the field |
| `undefined`               | omitted entirely         |

The `null` versus `undefined` distinction matters on `update` endpoints, which
treat an omitted parameter as an empty value.

### Localized text

CashCtrl stores translatable fields as an XML blob rather than a JSON object:

```
<values><de>Kasse</de><en>Cash</en><fr>Caisse</fr></values>
```

```ts
import { localize, toLocalized } from "@zweiundeins/cashctrl-ts-sdk";

localize(account.name, "en"); // "Cash"
localize(account.name, "it"); // falls back if `it` is missing
localize("Plain text", "en"); // "Plain text" (passes through)
toLocalized({ de: "Kasse", en: "Cash" }); // "<values><de>Kasse</de>...</values>"
```

### Documents

The 59 endpoints that return a file hand back the raw `Response` so you can
stream it:

```ts
const pdf = await cc.order.document.readPdf({ ids: orderId });
await Deno.writeFile("invoice.pdf", new Uint8Array(await pdf.arrayBuffer()));
```

Most are recognisable by a format suffix (`.pdf`, `.xlsx`, `.csv`, `.zip`,
`.vcf`, `.xml`, `.html`). Four are not — `file.get()`, `domain.current.logo()`,
`order.payment.download()` and `salary.payment.download()` — but they behave the
same way. `file.get()` redirects to object storage; `fetch` follows it.

### Escape hatch

For anything the generated surface does not cover:

```ts
const raw = await cc.http.get<{ data: unknown[] }>("/api/v1/tax/list.json");
await cc.http.post("/api/v1/some/new/endpoint.json", { foo: "bar" });
```

## Resources

`account`, `currency`, `customfield`, `domain`, `file`, `fiscalperiod`,
`history`, `inventory`, `journal`, `location`, `order`, `person`, `report`,
`rounding`, `salary`, `sequencenumber`, `setting`, `tax`, `text` — 62 resource
classes in total once nested ones are counted.

## OpenAPI spec

[`spec/openapi.json`](spec/openapi.json) is an OpenAPI 3.1 document for all 376
endpoints, valid under `redocly lint`. Use it with any generator or API client.
It is kept in the repo rather than shipped in the package, to keep installs
small.

Response schemas are inlined per endpoint, which is why the file is 1.9 MB.
[`spec/index.json`](spec/index.json) is the same surface without them — every
endpoint and parameter with prose capped at 200 characters, 450 KB — for tools
that need to search the whole API rather than call one part of it.

### Side-effecting GETs

Two GET endpoints change state, so "it is a GET, so it is safe" does not hold
here. They are exported for anything that decides what to call automatically:

```ts
import {
  isSideEffectingGet,
  SIDE_EFFECTING_GETS,
} from "@zweiundeins/cashctrl-ts-sdk";
```

`fiscalperiod/reopen_months.json` reopens closed months, and
`sequencenumber/get` consumes the next number in a sequence without giving it
back.

## How generation works

```
scripts/scrape-docs.ts   HTML reference -> spec/api.json        376 endpoints
scripts/probe-api.ts     live GET calls -> spec/responses.json  108 shapes
scripts/generate.ts      both           -> src/generated/*, spec/openapi.json
scripts/build-index.ts   spec/api.json  -> spec/index.json        search index
```

```sh
deno task generate    # regenerate from the committed specs (offline)
deno task index       # rebuild the search index
deno task scrape      # re-scrape the docs (--refresh bypasses the cache)
deno task probe       # re-probe response shapes (needs an API key)
deno task test        # unit tests, no network
deno task write-test  # every write endpoint, disposable organisation only
deno task build:npm   # build the npm package into ./npm
deno task ci          # everything CI runs
```

### Staying in sync with upstream

CashCtrl ships API changes without announcing them, so
[`.github/workflows/upstream.yml`](.github/workflows/upstream.yml) re-scrapes
their reference every Monday, regenerates, and opens a PR when anything moved.
`scripts/diff-spec.ts` turns the change into a readable summary (endpoints added
or removed, parameters added, removed or retyped) that becomes the PR body, so
the generated-code diff never has to be read directly.

```sh
deno run --allow-read --allow-write scripts/diff-spec.ts old.json new.json
```

### How probing reaches parameterised endpoints

Most read endpoints need an id, so the prober harvests them: it calls the `list`
and `tree` endpoints first and reuses their ids for the sibling `read.json`.
Where that convention does not hold - the parameter is not called `id`, or the
value lives under another resource, or inside a nested array - a small
`FIXTURES` table says where to look, and the prober runs several passes so
chains resolve (`journal/import/list` yields an import id, which yields import
entries, which yield one to read).

Three details matter for type quality:

- **Up to three records are sampled per endpoint**, not one. A field that is
  null on the first record is often populated on the third, and a tree node only
  reveals children if the sampled record has any.
- **A mandatory parameter with documented values is probed once per value.**
  `customfield/list` returns different fields per module.
- **A failed call never replaces a good shape.** This job runs weekly and
  unattended; a transient 500 upstream silently downgrading the generated types
  would be worse than leaving them stale.

`deno task probe` is **read-only by construction**: it calls only GET endpoints
whose final path segment is on a verb allowlist (`list`, `read`, `tree`,
`balance`, ...), and hard-denies the GET endpoints that have side effects,
namely `fiscalperiod/reopen_months.json` (reopens closed months) and
`sequencenumber/get` (consumes a sequence number). Document reads are denied
too: fetching an order or salary document appends a `DOWNLOAD` entry to the
organisation's history log, and an audit log is the wrong place to leave a
trace. It never issues a POST. `spec/responses.json` records field names and
types only, never values.

See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## Testing and coverage

Be clear-eyed about what is and is not verified.

| Layer                  | Coverage           | How                                      |
| ---------------------- | ------------------ | ---------------------------------------- |
| Request construction   | **376/376 (100%)** | `tests/contract_test.ts`, mock transport |
| Response shapes        | 108/376 (29%)      | live read-only probing, one organisation |
| Full CRUD round-trips  | 8 resources        | `scripts/roundtrip-test.ts`, live writes |
| Write endpoints driven | **192/192 (100%)** | `scripts/write-test.ts`, live writes     |

`tests/contract_test.ts` calls every generated method with every documented
parameter and asserts the HTTP verb, the exact URL path, that each parameter
reaches the wire, and that it is encoded the way CashCtrl expects. Expected
encodings are spelled out by hand rather than by reusing the SDK's own
serializer, so a bug cannot be mirrored into the expectation.

It is mutation-tested. Each of these deliberate faults is caught, with the
number of endpoints that flag it:

| Injected fault                 | Endpoints failing |
| ------------------------------ | ----------------- |
| One endpoint path corrupted    | 1                 |
| A POST issued as a GET         | 42                |
| `true` encoded as `1`          | 410               |
| Dates as `DD.MM.YYYY`          | 83                |
| CSV joined with `;`            | 140               |
| One parameter silently dropped | 54                |

### Live round-trips

`scripts/roundtrip-test.ts` does real create -> read-back -> update ->
`updatePreserving` -> delete cycles against a live organisation, then verifies
nothing was left behind.

It is **safe to run against a production organisation**, and deliberately
limited to make that true. It touches only master data with no accounting
effect, and none of it has an `nr` drawn from a sequence number. That
restriction matters: creating an order, person, article or salary statement
consumes the next number in its sequence, and deleting the record does **not**
give the number back, so a test run would leave a permanent gap in
audit-relevant invoice numbering. Journal entries are excluded separately as
real, VAT-relevant postings.

```sh
deno task roundtrip     # 8 resources, 48 assertions, cleans up after itself
```

Covering orders, journal entries and the rest of the accounting tier means
pointing this at a **disposable trial organisation**, not your books. That is
what `scripts/write-test.ts` is for.

### The write suite

`deno task write-test` drives the **write half of the API** - all 192 POST
endpoints - in ten dependency-ordered suites: master data, the chart of
accounts, file upload, people, inventory, journal entries, orders, the
bank-statement importer, payroll, and year-end.

It is **not** safe to point at real books, and is built so it cannot be. It
reads `CASHCTRL_TEST_DOMAINID` and `CASHCTRL_TEST_APIKEY` and never
`CASHCTRL_DOMAINID`/`CASHCTRL_APIKEY`, refuses to start if the two resolve to
the same organisation, and requires the target to be repeated on the command
line:

```sh
deno task write-test --dry-run                    # offline, coverage only
deno task write-test --org=<organisation>          # the real thing, 183/192
deno task write-test --org=<org> --all             # plus year-end, 192/192
deno task write-test --org=<org> --only=orders     # one suite while iterating
deno task write-test --org=<org> --mail=me@example.com   # include the 3 mail endpoints
```

`yearend` is opt-in, behind `--all`. Completing a fiscal period makes it
permanently undeletable — reopening does not undo that — so every run of that
suite leaves one behind. Worth doing deliberately, wasteful by default.

Every call goes through the generated method rather than raw HTTP, and a
recording `fetch` collects the paths actually reached, so the run ends with a
coverage report measured against every POST in `spec/api.json` instead of a
claim. Each suite tears down what it created, last created first.

Last full run against a disposable organisation (`--all --mail=...`): **266
assertions passed, 2 failed, 192/192 endpoints reached**. A default run skips
the year-end suite and reaches 183/192. The two failures are server-side, see
below.

The three `mail` endpoints send real e-mail, so they are skipped unless `--mail`
gives them a recipient; without it the run reaches 189/192.

#### What it costs to run

Two suites are deliberately destructive, which is why they need a disposable
organisation. `bankimport` executes an import that posts real journal entries;
the suite deletes them again. `yearend` creates its own fiscal period - the year
before the earliest existing one, so it never touches the year anybody is
booking into - completes it, reopens it and then deletes it.

That last step does not always work: **a fiscal period that has been completed
can never be deleted again**, reopening included, so every run of `yearend`
leaves one extra fiscal period behind, renamed `<tag>-DELETE-ME` on the way out.
That is why the suite is opt-in. The same is true of a depreciated fixed asset
and of a salary template a statement has used. All three are reported at the end
under "left behind" so they are never mistaken for a leak.

#### What the write paths actually revealed

Running the whole write surface against a live organisation turned up places
where CashCtrl's published reference and its behaviour disagree. Four of those
were bugs in this SDK and are now fixed, in
[`scripts/overrides.ts`](scripts/overrides.ts), which is the single reviewable
place where the generator knowingly departs from the scraped docs. Every entry
there records how the deviation was verified.

**Fixed: parameters the reference omits entirely.** `customfield/reorder` and
`customfield/group/reorder` require a `type` naming the module (`PERSON`,
`ORDER`, ...). Without it the server answers "Type is missing" with no field
errors, so the generated methods could never succeed whatever the caller passed.
`overrides.ts` adds the parameter back, and the search index and OpenAPI
document carry it too — an agent reading the index would otherwise keep
generating the call that cannot work.

**Fixed: `setting/read.json` is not enveloped.** Every other `read.json` returns
`{ data: ... }`; this one returns the settings object directly, so the generated
`read()` unwrapped a key that was not there and handed back `undefined`. The
generator now lets a _successful_ probe that observed no envelope outrank the
naming convention. A missing probe still does not — absence of evidence is not
evidence of absence, and that distinction is what keeps the other 20 unprobed
reads unwrapping correctly.

**Fixed: `setting/update` takes caller-chosen keys.** The reference documents no
parameters, which generated `Record<string, never>` — a signature that cannot
express any request. It accepts the same keys `setting/read` returns, so it is
now typed openly and the suite round-trips a real setting.

**Fixed: four parameters typed TEXT whose value must be a JSON array** —
`tax.components`, `tax.rates`, `person.addresses`, `person.bankAccounts`. A
string you encoded yourself was always accepted, so this is ergonomics rather
than a correction: all four now take the array directly and the serializer
encodes it. Worth knowing anyway, because `tax`'s two document no format at all
— the value is an array of objects whose fields appear only in the `read.json`
response.

**Still yours to work around: parameters documented as optional that the server
requires.** Not fixed, deliberately: several of them are only mandatory when the
organisation lacks a matching sequence number, so making them required in the
type would break the callers for whom they are genuinely optional.

`parentId` on `account/category/create`; `description` on `tax/create`;
`layoutId` on `order/category/create` and `salary/template/create`; `date` on
`order/bookentry/update` and `salary/bookentry/create`; `nr` on
`inventory/article/create`, `order/create` and `salary/statement/create`; `nr`
and `purchaseCreditId` on `inventory/asset/create`; `mailTo` on all three `mail`
endpoints; and all four date fields on `fiscalperiod/update`, whose only
documented requirement is `id`.

**Server-side faults**, reported as failures rather than worked around:

- `notifyType: "NONE"` is a documented value for all three `update_recurrence`
  endpoints and makes every one of them answer 500. Omitting the parameter is
  equivalent and works.
- `salary/type/create` answers 500 for the documented required set
  (`categoryId`, `name`, `number`, `type`). Only a near-complete payload gets
  through, so the suite clones an existing type and renames its variables.
- `person/import/execute` and `inventory/article/import/execute` answer "An
  unexpected error occurred" for every file shape tried, after `create` and
  `mapping` both succeed. These are the 2 failures in the run above.

**Undocumented behaviour worth knowing**: the CSV bank importer rejects a
three-column file outright and needs a fourth; `mapping` takes the importer's
own field constants (`COMPANY`, `NAME_EN`, ...) from the `mapping_combo`
endpoint, not field names on the entity; an order must be in a status flagged
`isBook` before it accepts a book entry or a payment, and the `amount` parameter
does not override that; `file/prepare` returns
`{ data: [{ fileId, writeUrl }] }` while being typed as the generic
`WriteEnvelope`; and a fiscal period that has been completed can never be
deleted again, reopening included.

**What is still not proven:** `person/import/execute` and
`inventory/article/import/execute`, which the server refuses. Every other write
endpoint has been executed against a real server.

## Caveats

These are the honest limits of generating from a source never meant to be
machine-read:

- **Request params are authoritative; response types are best-effort.** The docs
  specify parameters only. Entity types are inferred from live responses in a
  single organisation (108 of 376 endpoints), so a field that organisation never
  populated may be typed more loosely than reality.
- Fields that were `null` in every sample are widened using the documented
  request param type where one exists (`taxId` becomes `number | null`), and
  typed `unknown` otherwise.
- Arrays empty in every sample infer as `unknown[]`.
- 1 endpoint failed probing and falls back to `unknown`; it is recorded with its
  error in `spec/responses.json`. A further 8 are skipped because the
  organisation has no records of that kind to read.
- POST endpoints are never probed, so writes return the generic `WriteEnvelope`.
- Entity types merge the `read.json` and `list.json` shapes, so fields only
  `read` returns are marked optional.

Re-running `deno task probe && deno task generate` against your own organisation
will tighten the types for your data.

## License

MIT
