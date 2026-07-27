# Contributing

## The one rule

**Do not hand-edit anything in `src/generated/`.** Those files are produced by
`scripts/generate.ts` and CI fails if regenerating changes them. Fix the
generator instead, then re-run `deno task generate` and commit both.

Everything else in `src/` (the transport, errors, localized-text helpers) is
handwritten and edited normally.

## Layout

```
scripts/scrape-docs.ts   HTML reference -> spec/api.json         no key needed
scripts/probe-api.ts     live GET calls -> spec/responses.json   needs API key
scripts/generate.ts      both           -> src/generated/*, spec/openapi.json
scripts/ir.ts            shared types for the three stages
scripts/naming.ts        path -> class/method/type naming rules

src/http.ts              transport: auth, form encoding, retries, envelopes
src/errors.ts            error hierarchy
src/localized.ts         CashCtrl's <values> XML helpers
src/client.ts            root class wiring the generated resources together
```

## Development

```sh
deno task ci            # everything CI runs
deno task test          # unit tests, no network
deno task test:compat   # cross-runtime check
deno task generate      # regenerate from the committed specs
deno task check         # typecheck + lint + fmt
```

`deno task generate` works offline: `spec/api.json` and `spec/responses.json`
are committed, so you only need the network to refresh them.

## Refreshing from upstream

When CashCtrl changes their API:

```sh
deno task scrape -- --refresh   # re-fetch and re-parse the HTML reference
deno task probe                 # re-probe response shapes (needs a .env)
deno task generate              # rebuild the SDK and the OpenAPI spec
```

Review the `spec/*.json` diff before committing: that diff is the actual API
change, and it is much easier to read than the generated TypeScript.

## Probing safety

`scripts/probe-api.ts` runs against a real organisation, so it is constrained
to be read-only:

- Only `GET` endpoints whose final path segment is on the `SAFE_VERBS`
  allowlist are called.
- `DENY` blocks the GET endpoints that have side effects:
  `fiscalperiod/reopen_months.json` reopens closed months, and
  `sequencenumber/get` consumes a sequence number.
- No `POST` is ever issued.

If you add a verb to `SAFE_VERBS`, confirm in the API reference that it does
not mutate. When in doubt, leave it out; an endpoint missing from
`spec/responses.json` just falls back to `unknown`, which is harmless.

`spec/responses.json` stores field names and types only, never values, and the
organisation name is redacted. Check that any regenerated file still holds
only structure before committing.

## Erasable syntax

The source must run under runtimes that strip types without transpiling, such
as `node --experimental-strip-types`. That rules out TypeScript parameter
properties (`constructor(readonly x: number)`), `enum`, and namespaces.
`erasableSyntaxOnly` is enabled in `deno.json`, so `deno check` catches
violations, and `deno task test:compat` runs the SDK on Deno, Node and Bun.

## Upstream changes

`.github/workflows/upstream.yml` re-scrapes the CashCtrl reference every
Monday and opens a PR when it moved. `scripts/diff-spec.ts` renders the change
as a readable summary that becomes the PR body.

Note that the automated PR regenerates against the *existing*
`spec/responses.json`, so response types for brand-new endpoints come out as
`unknown`. Run `deno task probe` against a real organisation and push to the
PR branch before merging if you want them typed. The PR checklist says so.

To check by hand:

```sh
cp spec/api.json /tmp/before.json
deno task scrape -- --refresh
deno run --allow-read --allow-write scripts/diff-spec.ts /tmp/before.json spec/api.json
```

`diff-spec.ts` exits 1 when there are changes, 0 when there are none, so it
composes with shell conditionals.

## Releasing

1. Bump `version` in `deno.json` and add a `CHANGELOG.md` entry.
2. Commit, then tag: `git tag v0.2.0 && git push --tags`.
3. The publish workflow verifies the tag matches `deno.json`, then publishes to
   both registries:
   - **JSR** via OIDC. No token secret, but the package must be linked to this
     GitHub repo in its jsr.io settings first.
   - **npm** via dnt, which rewrites the `.ts` import extensions and emits
     ESM + CJS + declarations. Needs an `NPM_TOKEN` repository secret with
     publish rights on the `@zweiundeins` scope. Published with provenance.

Build the npm package locally with `deno task build:npm`; the output lands in
`./npm` (gitignored) and is publishable with `npm publish ./npm`.
