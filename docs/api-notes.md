# What driving every write endpoint revealed

Notes from executing all 192 write endpoints against a live organisation.
Several are places where CashCtrl's published reference and its behaviour
disagree; they apply to any caller, not just this SDK.

Running the whole write surface against a live organisation turned up places
where CashCtrl's published reference and its behaviour disagree. Four of those
were bugs in this SDK and are now fixed, in
[`scripts/overrides.ts`](../scripts/overrides.ts), which is the single
reviewable place where the generator knowingly departs from the scraped docs.
Every entry there records how the deviation was verified.

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

**Fixed: 19 structured parameters generated as `string`.** CashCtrl documents a
structured parameter by giving it a nested parameter table, which the scraper
records as `fields`. For 19 params it also labels the type `TEXT`, and the
generator — reading the label, not the table — emitted `string` and discarded
the shape. `person.addresses` was typed `string` despite having eleven
documented fields.

A sub-table is the statement that a value is structured; there is nothing else
it could mean, and CashCtrl types the other 116 such params `JSON` itself. So
this is one rule rather than 19 entries, and it costs nothing once upstream
fixes a label. `person.addresses`, `bankAccounts`, `contacts`, `children`,
`servicePeriods`, `insuranceContracts`, `salary/insurance/type.codes`,
`tax.components` and `tax.rates` are now object arrays with their documented
fields and enums, not opaque strings.

**Still yours to work around: parameters documented as optional that the server
requires.** Not fixed, deliberately: several of them are only mandatory when the
organisation lacks a matching sequence number, so making them required in the
type would break the callers for whom they are genuinely optional.

`parentId` on `account/category/create`; `description` on `tax/create`;
`layoutId` on `order/category/create` and `salary/template/create`; `date` on
`order/bookentry/update` and `salary/bookentry/create`; `nr` on
`inventory/article/create`, `order/create` and `salary/statement/create`; `nr`
and `purchaseCreditId` on `inventory/asset/create`; `mailTo` on all three `mail`
endpoints; `code` inside each entry of `tax.components`, without which the whole
array is discarded as "At least one component must be set"; and all four date
fields on `fiscalperiod/update`, whose only documented requirement is `id`.

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

## Document endpoints without a format suffix

Most of the 59 file-returning endpoints are recognisable by their suffix
(`.pdf`, `.xlsx`, `.csv`, `.zip`, `.vcf`, `.xml`, `.html`). Four are not —
`file.get()`, `domain.current.logo()`, `order.payment.download()` and
`salary.payment.download()` — but they behave the same way and return a raw
`Response`. `file.get()` redirects to object storage; `fetch` follows it.
