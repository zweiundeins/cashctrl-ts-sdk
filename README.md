# cashctrl-ts-sdk

A typed TypeScript client for the [CashCtrl](https://cashctrl.com) accounting
API, covering all **376 endpoints**.

CashCtrl publishes no OpenAPI spec and no official SDK, so this repo generates
both from the [published HTML reference](https://app.cashctrl.com/static/help/en/api/index.html),
with response types inferred from live read-only API calls.

Zero dependencies, `fetch`-only: runs on Deno, Node 18+, Bun and edge workers.

## Install

```ts
// Deno
import { CashCtrl } from "jsr:@zweiundeins/cashctrl";

// Node / Bun
// npx jsr add @zweiundeins/cashctrl
import { CashCtrl } from "@zweiundeins/cashctrl";
```

## Usage

Resources mirror the API's own path structure, so
`POST /api/v1/account/costcenter/category/create.json` is
`cc.account.costcenter.category.create({...})`.

```ts
import { CashCtrl, localize, toLocalized } from "@zweiundeins/cashctrl";

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

### Errors

CashCtrl returns **HTTP 200 for validation failures**, with `success: false`.
The SDK promotes those to a thrown error so they cannot be missed:

```ts
import { CashCtrlValidationError, CashCtrlRateLimitError } from "@zweiundeins/cashctrl";

try {
  await cc.journal.create({ amount: 0, debitId: 0, creditId: 0 });
} catch (err) {
  if (err instanceof CashCtrlValidationError) {
    console.log(err.byField()); // { debitId: ["This field cannot be empty."] }
  }
}
```

`CashCtrlAuthError` (401/403), `CashCtrlRateLimitError` (429) and
`CashCtrlHttpError` (everything else) cover the transport failures. 429 and 5xx
are retried with exponential backoff by default; configure via
`retry: { attempts, baseDelayMs }`.

### Localized text

CashCtrl stores translatable fields as an XML blob rather than a JSON object:

```
<values><de>Kasse</de><en>Cash</en><fr>Caisse</fr></values>
```

```ts
localize(account.name, "en");              // "Cash"
localize("Plain text", "en");              // "Plain text" (passes through)
toLocalized({ de: "Kasse", en: "Cash" });  // "<values><de>Kasse</de>...</values>"
```

### Documents

Endpoints returning PDF/XLSX/CSV/ZIP hand back the raw `Response` so you can
stream it:

```ts
const pdf = await cc.order.document.readPdf({ ids: orderId });
await Deno.writeFile("invoice.pdf", new Uint8Array(await pdf.arrayBuffer()));
```

### Escape hatch

Anything the generated surface does not cover:

```ts
const raw = await cc.http.get<{ data: unknown[] }>("/api/v1/tax/list.json");
await cc.http.post("/api/v1/some/new/endpoint.json", { foo: "bar" });
```

## OpenAPI spec

[`spec/openapi.json`](spec/openapi.json) is an OpenAPI 3.1 document for all 376
endpoints, usable with any generator or API client. Request parameters come
from the official docs; response schemas come from live probing (see caveats).

## How generation works

```
scripts/scrape-docs.ts   HTML reference  -> spec/api.json        (376 endpoints)
scripts/probe-api.ts     live GET calls  -> spec/responses.json  (95 shapes)
scripts/generate.ts      both            -> src/generated/*, spec/openapi.json
```

```sh
deno task scrape      # re-scrape the docs (--refresh to bypass the cache)
deno task probe       # re-probe response shapes (needs an API key)
deno task generate    # regenerate the SDK
deno task test        # unit tests, no network
deno task smoke       # live read-only check against a real org
```

`deno task probe` is **read-only by construction**: it calls only GET endpoints
on a verb allowlist (`list`, `read`, `tree`, `balance`, ...) and hard-denies the
GET endpoints that have side effects, namely
`fiscalperiod/reopen_months.json` (reopens closed months) and
`sequencenumber/get` (consumes a sequence number). It never issues a POST.

## Caveats

These are honest limits of generating from a source that was never meant to be
machine-read:

- **Request params are authoritative; response types are best-effort.** The
  docs specify parameters only. Entity types are inferred from live responses
  in one organisation (95 of 376 endpoints), so a field that organisation never
  populated may be typed more loosely than reality.
- Fields that were `null` in every sample are widened using the documented
  request param type where one exists (`taxId` -> `number | null`), and typed
  `unknown` otherwise.
- Empty arrays in every sample infer as `unknown[]`.
- 8 endpoints failed probing (missing fixtures or a 500 on this org) and fall
  back to `unknown`. They are recorded with their error in
  `spec/responses.json`.
- POST endpoints are not probed, so writes return the generic `WriteEnvelope`.
- Entity types merge the `read.json` and `list.json` shapes, so fields that
  only `read` returns are marked optional.

Re-run `deno task probe && deno task generate` against your own organisation to
tighten the types for your data.

## License

MIT
