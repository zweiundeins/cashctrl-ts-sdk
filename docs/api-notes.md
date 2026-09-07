# CashCtrl API notes

Found by executing all 192 write endpoints against a live organisation. Most of
these are places where the published reference and the API's behaviour disagree,
so they apply to any caller, not only to this SDK.

## Fixed in the SDK

Four of them were bugs here. All are corrected in
[`scripts/overrides.ts`](../scripts/overrides.ts), which records how each
deviation was verified.

**Parameters the reference omits entirely.** `customfield/reorder` and
`customfield/group/reorder` need a `type` naming the module (`PERSON`, `ORDER`,
…). Without it the server answers "Type is missing" with no field errors, so the
generated methods could not succeed whatever the caller passed. The search index
and OpenAPI document carry the parameter too, since an agent reading the index
would otherwise keep generating a call that cannot work.

**`setting/read.json` is not enveloped.** Every other `read.json` returns
`{ data: ... }`; this one returns the settings object directly, so the generated
`read()` unwrapped a key that was not there and returned `undefined`. A probe
that succeeded and saw no envelope now outranks the naming convention. A missing
probe does not, which is what keeps the other 20 unprobed reads unwrapping.

**`setting/update` takes caller-chosen keys.** The reference documents no
parameters, which generated `Record<string, never>` — a signature that cannot
express a request. It accepts the keys `setting/read` returns.

**19 structured parameters were generated as `string`.** CashCtrl marks a
structured parameter by giving it a nested parameter table, which the scraper
records as `fields`, but for these 19 it labels the type `TEXT`. The generator
read the label rather than the table, so `person.addresses` was typed `string`
despite eleven documented fields. Now object arrays with their documented fields
and enums: `person.addresses`, `bankAccounts`, `contacts`, `children`,
`servicePeriods`, `insuranceContracts`, `salary/insurance/type.codes`,
`salary/statement/update_multiple.attachments`, `tax.components`, `tax.rates`.

## Documented as optional, required by the server

Not corrected in the types, deliberately: several are only mandatory when the
organisation has no matching sequence number, so making them required would
break the callers for whom they really are optional.

| Endpoint                                                              | Parameter                                  |
| --------------------------------------------------------------------- | ------------------------------------------ |
| `account/category/create`                                             | `parentId`                                 |
| `tax/create`                                                          | `description`                              |
| `tax/create`, `tax/update`                                            | `code` on each `components` entry          |
| `order/category/create`, `salary/template/create`                     | `layoutId`                                 |
| `order/bookentry/update`, `salary/bookentry/create`                   | `date`                                     |
| `inventory/article/create`, `order/create`, `salary/statement/create` | `nr`                                       |
| `inventory/asset/create`                                              | `nr`, `purchaseCreditId`                   |
| all three `document/mail` endpoints                                   | `mailTo`                                   |
| `fiscalperiod/update`                                                 | `start`, `end`, `salaryStart`, `salaryEnd` |

Omitting `code` from a tax component discards the whole array, reported as "At
least one component must be set".

## Server-side faults

- `notifyType: "NONE"` is a documented value on all three `update_recurrence`
  endpoints and makes every one answer 500. Omitting the parameter is equivalent
  and works.
- `salary/type/create` answers 500 for its own documented required set
  (`categoryId`, `name`, `number`, `type`). Only a near-complete payload gets
  through, so the write suite clones an existing type and renames its variables.
- `person/import/execute` and `inventory/article/import/execute` answer "An
  unexpected error occurred" after `create` and `mapping` both succeed, for
  every file shape tried: comma and semicolon delimiters, LF and CRLF, three and
  four columns, one and two data rows. These are the only two write endpoints
  never executed successfully.

Reported to CashCtrl on 2026-09-07.

## Undocumented behaviour

- The CSV bank importer rejects a three-column file outright, with a message
  about the format rather than the column count. A fourth column fixes it.
- `person/import/mapping` and `inventory/article/import/mapping` want the
  importer's own field constants in `to` (`COMPANY`, `NAME_EN`,
  `SALES_PRICE_NET`, …), listed by the sibling `mapping_combo` endpoint, not
  field names on the entity.
- An order accepts a book entry or a payment only once it reaches a status
  flagged `isBook`. Before that the open amount is 0 and the payment is refused
  as not positive; the `amount` parameter does not override this.
- `file/prepare` answers `{ data: [{ fileId, writeUrl }] }`, not the usual write
  envelope.
- A fiscal period that has been completed can never be deleted, and reopening it
  does not restore that. The same is true of a depreciated fixed asset and of a
  salary template a statement has used.

## Document endpoints without a format suffix

Most of the 59 file-returning endpoints are recognisable by their suffix
(`.pdf`, `.xlsx`, `.csv`, `.zip`, `.vcf`, `.xml`, `.html`). Four are not —
`file.get()`, `domain.current.logo()`, `order.payment.download()` and
`salary.payment.download()` — but they behave the same way and return a raw
`Response`. `file.get()` redirects to object storage; `fetch` follows it.
