# How the SDK is generated

CashCtrl publishes no OpenAPI spec and no official SDK, so this repo builds both
from the published HTML reference plus live read-only probing.

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

## Staying in sync with upstream

CashCtrl ships API changes without announcing them, so
[`.github/workflows/upstream.yml`](../.github/workflows/upstream.yml) re-scrapes
their reference every Monday, re-probes response shapes, regenerates, and opens
a PR when anything moved. `scripts/diff-spec.ts` turns the change into a
readable summary (endpoints added or removed, parameters added, removed or
retyped) that becomes the PR body, so the generated-code diff never has to be
read directly.

The probe step needs the `CASHCTRL_TEST_DOMAINID` / `CASHCTRL_TEST_APIKEY`
secrets and is skipped without them, in which case the PR body asks for a manual
`deno task probe` instead. Without it, regeneration reuses the old
`spec/responses.json` and any endpoint CashCtrl has added comes out typed
`unknown`.

```sh
deno run --allow-read --allow-write scripts/diff-spec.ts old.json new.json
```

## How probing reaches parameterised endpoints

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

See [CONTRIBUTING.md](../CONTRIBUTING.md) for details.

## OpenAPI spec

[`spec/openapi.json`](../spec/openapi.json) is an OpenAPI 3.1 document for all
376 endpoints, valid under `redocly lint`. Use it with any generator or API
client. It is kept in the repo rather than shipped in the package, to keep
installs small.

Response schemas are inlined per endpoint, which is why the file is 1.9 MB.
[`spec/index.json`](../spec/index.json) is the same surface without them — every
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
