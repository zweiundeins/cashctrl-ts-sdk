# Testing and coverage

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

#### In CI

[`.github/workflows/write-test.yml`](../.github/workflows/write-test.yml) runs
the suite weekly and on demand, against the organisation named by the
`CASHCTRL_TEST_DOMAINID` / `CASHCTRL_TEST_APIKEY` repository secrets. Not on
push: it writes, it takes a few minutes and several hundred calls against a
third party, and two concurrent runs would interleave — the settings suite flips
an organisation-wide setting and restores it. A `concurrency` group keeps it to
one at a time, and a queued run is dropped rather than cancelled, since
cancelling mid-suite would kill it between a create and its cleanup.

The year-end suite stays out of the scheduled run, because each pass leaves a
fiscal period that can never be deleted. The manual trigger has an `all` input
for when the year-end code itself changes.

Two endpoints fail for reasons on CashCtrl's side. They are listed in
`KNOWN_FAILURES` with what was tried, reported separately from real failures,
and do not fail the run — otherwise the suite could never be green and a red
result would stop meaning anything. The check runs both ways: an entry that
_stops_ failing also fails the run, because an endpoint that starts working is
news, and a stale entry would mask a real regression later.

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
