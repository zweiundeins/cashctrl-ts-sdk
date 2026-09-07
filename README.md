# cashctrl-ts-sdk

[![JSR](https://jsr.io/badges/@zweiundeins/cashctrl-ts-sdk)](https://jsr.io/@zweiundeins/cashctrl-ts-sdk)
[![npm](https://img.shields.io/npm/v/@zweiundeins/cashctrl-ts-sdk)](https://www.npmjs.com/package/@zweiundeins/cashctrl-ts-sdk)
[![CI](https://github.com/zweiundeins/cashctrl-ts-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/zweiundeins/cashctrl-ts-sdk/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A typed TypeScript client for the [CashCtrl](https://cashctrl.com) accounting
API, covering all **376 endpoints**.

CashCtrl publishes no OpenAPI spec and no official SDK, so this repo generates
both from the
[published HTML reference](https://app.cashctrl.com/static/help/en/api/index.html)
plus live probing. Zero dependencies, `fetch`-only, verified on Deno 2.7, Node
22 and Bun 1.3.

> Unofficial and not affiliated with CashCtrl.

## Install

```sh
deno add jsr:@zweiundeins/cashctrl-ts-sdk    # Deno
npm  install @zweiundeins/cashctrl-ts-sdk    # Node
bun  add     @zweiundeins/cashctrl-ts-sdk    # Bun
pnpm add     @zweiundeins/cashctrl-ts-sdk
```

```ts
import { CashCtrl } from "@zweiundeins/cashctrl-ts-sdk";
```

The npm build ships ESM and CommonJS with declarations and needs Node 18+; only
the build tooling is Deno, never the published package.

You need an API key: **Settings > Users & Roles > Add > Add API user**. It is
scoped to one organisation and inherits the role you give it.

## Usage

Resources mirror the API's own path structure, so
`POST /api/v1/account/costcenter/category/create.json` is
`cc.account.costcenter.category.create({...})`. Every method takes an optional
trailing `AbortSignal`.

```ts
import { CashCtrl } from "@zweiundeins/cashctrl-ts-sdk";

const cc = new CashCtrl({
  organisation: "myorg", // the subdomain of myorg.cashctrl.com
  apiKey: process.env.CASHCTRL_APIKEY!,
  lang: "de", // language for error messages and generated PDFs
});

const accounts = await cc.account.list({ onlyActive: true }); // unwrapped
const { insertId } = await cc.person.create({ company: "ACME AG" });

// Nested JSON params are typed all the way down.
await cc.order.create({
  associateId: insertId!,
  categoryId: 4,
  date: new Date(),
  items: [{ accountId: 42, name: "Consulting", unitPrice: 180, quantity: 8 }],
});
```

**Updates are full replacements.** CashCtrl treats an omitted parameter as an
empty value, so a partial `update` silently clears every field left out. Use
`cc.person.updatePreserving(existing, { id, lastName: "Neu" })`, which does the
read-modify-write for you.

### Errors

CashCtrl returns **HTTP 200 for validation failures**, with `success: false` in
the body. The SDK promotes those to a thrown error so they cannot be missed:

```ts
try {
  await cc.journal.create({ amount: 0, debitId: 0, creditId: 0 });
} catch (err) {
  if (err instanceof CashCtrlValidationError) {
    console.log(err.byField()); // { debitId: ["This field cannot be empty."] }
  }
}
```

`CashCtrlValidationError` (HTTP 200, `success: false`), `CashCtrlAuthError`
(401/403), `CashCtrlRateLimitError` (429, carries `retryAfter`) and
`CashCtrlHttpError` (any other non-2xx). 429 and 5xx are retried with
exponential backoff; configure with `retry: { attempts, baseDelayMs }`.

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

The `null` versus `undefined` distinction is what makes `updatePreserving` work:
`undefined` leaves a field alone, `null` clears it.

### Localized text, documents, escape hatch

Translatable fields are an XML blob (`<values><de>Kasse</de>...</values>`), not
JSON. `localize`, `parseLocalized`, `toLocalized` and `isLocalized` convert both
ways, falling back to another language when one is missing and passing plain
strings through untouched.

The 59 endpoints that return a file hand back the raw `Response`:

```ts
const pdf = await cc.order.document.readPdf({ ids: orderId });
await Deno.writeFile("invoice.pdf", new Uint8Array(await pdf.arrayBuffer()));
```

For anything the generated surface does not cover, `cc.http.get` and
`cc.http.post` take a path and params directly.

## Resources

`account`, `currency`, `customfield`, `domain`, `file`, `fiscalperiod`,
`history`, `inventory`, `journal`, `location`, `order`, `person`, `report`,
`rounding`, `salary`, `sequencenumber`, `setting`, `tax`, `text` — 62 classes
once nested ones are counted.

## What is verified

| Layer                | Coverage           | How                                      |
| -------------------- | ------------------ | ---------------------------------------- |
| Request construction | **376/376 (100%)** | `tests/contract_test.ts`, mock transport |
| Write endpoints      | **192/192 (100%)** | `scripts/write-test.ts`, live writes     |
| Response shapes      | 108/376 (29%)      | live probing, one organisation           |

Request parameters come from the docs and are authoritative. **Response types
are best-effort**: inferred from one organisation's live data, so a field it
never populated may be typed more loosely than reality, and an array empty in
every sample infers as `unknown[]`. POST responses are never probed, so writes
return the generic `WriteEnvelope`. Re-probing against your own organisation
(`deno task probe && deno task generate`) tightens them for your data.

## Documentation

- [docs/testing.md](docs/testing.md) — what each layer covers, including the
  suite that drives all 192 write endpoints against a disposable organisation.
- [docs/api-notes.md](docs/api-notes.md) — undocumented CashCtrl behaviour that
  suite turned up. Useful to any caller, not only users of this SDK.
- [docs/generation.md](docs/generation.md) — the generation pipeline, the
  `spec/` artefacts (OpenAPI 3.1 and a search index), side-effecting GETs, and
  the weekly upstream check.
- [CONTRIBUTING.md](CONTRIBUTING.md) — working on the generator.

## License

MIT
