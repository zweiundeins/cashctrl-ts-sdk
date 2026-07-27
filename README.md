# cashctrl-ts-sdk

[![JSR](https://jsr.io/badges/@zweiundeins/cashctrl-ts-sdk)](https://jsr.io/@zweiundeins/cashctrl-ts-sdk)
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

```sh
deno add jsr:@zweiundeins/cashctrl-ts-sdk   # Deno
npx jsr add @zweiundeins/cashctrl-ts-sdk    # Node
bunx jsr add @zweiundeins/cashctrl-ts-sdk   # Bun
```

```ts
import { CashCtrl } from "@zweiundeins/cashctrl-ts-sdk";
```

You need an API key: in CashCtrl, go to **Settings > Users & Roles > Add >
Add API user**. The key is scoped to a single organisation and inherits the
role you assign it.

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

| Error | When |
| --- | --- |
| `CashCtrlValidationError` | HTTP 200 with `success: false` |
| `CashCtrlAuthError` | 401, 403 |
| `CashCtrlRateLimitError` | 429, carries `retryAfter` |
| `CashCtrlHttpError` | any other non-2xx |

429 and 5xx are retried with exponential backoff by default. Configure with
`retry: { attempts, baseDelayMs }`, or `attempts: 0` to disable.

### Parameter encoding

The API is form-encoded even though it returns JSON, so the SDK flattens
structured values for you:

| You pass | Sent as |
| --- | --- |
| `true` | `"true"` |
| `new Date(2026, 6, 27)` | `"2026-07-27"` |
| `[1, 2, 3]` (a CSV param) | `"1,2,3"` |
| `[{...}]` (a JSON param) | `'[{"...":...}]'` |
| `null` | `""`, clearing the field |
| `undefined` | omitted entirely |

The `null` versus `undefined` distinction matters on `update` endpoints, which
treat an omitted parameter as an empty value.

### Localized text

CashCtrl stores translatable fields as an XML blob rather than a JSON object:

```
<values><de>Kasse</de><en>Cash</en><fr>Caisse</fr></values>
```

```ts
import { localize, toLocalized } from "@zweiundeins/cashctrl-ts-sdk";

localize(account.name, "en");              // "Cash"
localize(account.name, "it");              // falls back if `it` is missing
localize("Plain text", "en");              // "Plain text" (passes through)
toLocalized({ de: "Kasse", en: "Cash" });  // "<values><de>Kasse</de>...</values>"
```

### Documents

Endpoints returning PDF/XLSX/CSV/ZIP/vCard hand back the raw `Response` so you
can stream it:

```ts
const pdf = await cc.order.document.readPdf({ ids: orderId });
await Deno.writeFile("invoice.pdf", new Uint8Array(await pdf.arrayBuffer()));
```

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

## How generation works

```
scripts/scrape-docs.ts   HTML reference -> spec/api.json        376 endpoints
scripts/probe-api.ts     live GET calls -> spec/responses.json   95 shapes
scripts/generate.ts      both           -> src/generated/*, spec/openapi.json
```

```sh
deno task generate    # regenerate from the committed specs (offline)
deno task scrape      # re-scrape the docs (--refresh bypasses the cache)
deno task probe       # re-probe response shapes (needs an API key)
deno task test        # unit tests, no network
deno task ci          # everything CI runs
```

`deno task probe` is **read-only by construction**: it calls only GET endpoints
whose final path segment is on a verb allowlist (`list`, `read`, `tree`,
`balance`, ...), and hard-denies the GET endpoints that have side effects,
namely `fiscalperiod/reopen_months.json` (reopens closed months) and
`sequencenumber/get` (consumes a sequence number). It never issues a POST.
`spec/responses.json` records field names and types only, never values.

See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## Caveats

These are the honest limits of generating from a source never meant to be
machine-read:

- **Request params are authoritative; response types are best-effort.** The
  docs specify parameters only. Entity types are inferred from live responses
  in a single organisation (95 of 376 endpoints), so a field that organisation
  never populated may be typed more loosely than reality.
- Fields that were `null` in every sample are widened using the documented
  request param type where one exists (`taxId` becomes `number | null`), and
  typed `unknown` otherwise.
- Arrays empty in every sample infer as `unknown[]`.
- 8 endpoints failed probing (missing fixtures, or a 500 on that organisation)
  and fall back to `unknown`. Each is recorded with its error in
  `spec/responses.json`.
- POST endpoints are never probed, so writes return the generic
  `WriteEnvelope`.
- Entity types merge the `read.json` and `list.json` shapes, so fields only
  `read` returns are marked optional.

Re-running `deno task probe && deno task generate` against your own
organisation will tighten the types for your data.

## License

MIT
