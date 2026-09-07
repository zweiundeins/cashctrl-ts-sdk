/**
 * Exercises the write half of the API against a disposable organisation.
 *
 * `scripts/roundtrip-test.ts` is the safe sibling: it touches only master data
 * and is safe to point at real books. This one is not. It books journal
 * entries, consumes sequence numbers, completes and reopens fiscal periods,
 * and empties the file archive. It reads `CASHCTRL_TEST_DOMAINID` /
 * `CASHCTRL_TEST_APIKEY` only, and refuses to start unless the organisation is
 * repeated on the command line.
 *
 * Every write goes through the generated SDK method, not raw HTTP, so a wrong
 * path or a mis-encoded parameter fails here the same way it would for a user.
 * A recording `fetch` collects the paths actually reached and the run ends with
 * a coverage report against every POST endpoint in `spec/api.json`, so
 * "all write paths are tested" is a measured number rather than a claim.
 *
 * Run: deno task write-test --dry-run          (offline, coverage only)
 *      deno task write-test --org=<organisation>          (skips year-end)
 *      deno task write-test --org=<organisation> --all    (everything)
 *      deno task write-test --org=<organisation> --only=orders,journal
 *      deno task write-test --org=<organisation> --mail=you@example.com
 */

import { CashCtrl } from "../src/mod.ts";
import {
  allWritePaths,
  Ctx,
  KNOWN_FAILURES,
  recordingFetch,
  resolveTarget,
} from "./write-harness.ts";
import { discover, suites } from "./write-suites.ts";
import { stubFetch } from "./write-dryrun.ts";

const args = Deno.args;
const dryRun = args.includes("--dry-run");

let target = { organisation: "dry-run", apiKey: "dry-run" };
if (!dryRun) {
  try {
    target = resolveTarget(args);
  } catch (err) {
    console.error(`\n${(err as Error).message}\n`);
    Deno.exit(2);
  }
}

const seen = new Set<string>();
const transport = recordingFetch(seen, dryRun ? stubFetch() : globalThis.fetch);
const cc = new CashCtrl({
  organisation: target.organisation,
  apiKey: target.apiKey,
  lang: "en",
  fetch: transport,
});

// Short: several name fields cap at 50 characters and the suites append to it.
const tag = `zzz-w${Date.now().toString(36).slice(-5)}`;
const ctx = new Ctx(cc, tag, args, transport);

const only = args.find((a) => a.startsWith("--only="))
  ?.slice("--only=".length).split(",").filter(Boolean);
// `--only=yearend` runs that suite alone, which is the wrong tool for "run
// everything including the ones that leave a mark".
const all = args.includes("--all");

console.log(
  dryRun
    ? "write suite DRY RUN against a stub server - coverage only, " +
      "nothing here is evidence the API works"
    : `write suite against ${target.organisation}.cashctrl.com`,
);
console.log(`tag: ${tag}\n`);

console.log("discovering organisation");
ctx.world = await discover(ctx);
console.log();

const selected = suites.filter((s) =>
  only ? only.includes(s.name) : all || !s.optIn
);
const skipped = suites.filter((s) => !selected.includes(s));

for (const suite of selected) {
  console.log(suite.name);
  ctx.enterSuite(suite.name);
  try {
    await suite.run(ctx);
  } catch (err) {
    ctx.check(`${suite.name} aborted`, false, (err as Error).message);
  } finally {
    await ctx.runCleanups();
  }
  console.log();
}

// ---------------------------------------------------------------- reporting

const writePaths = allWritePaths();
const covered = writePaths.filter((p) => seen.has(p));
const missed = writePaths.filter((p) => !seen.has(p));
const pct = ((covered.length / writePaths.length) * 100).toFixed(1);

console.log("=".repeat(72));
console.log(`${ctx.passed} passed, ${ctx.failed} failed`);
console.log(
  `write endpoints reached: ${covered.length}/${writePaths.length} (${pct}%)`,
);

if (skipped.length) {
  const optedOut = skipped.filter((s) => s.optIn && !only);
  console.log(`suites not run: ${skipped.map((s) => s.name).join(", ")}`);
  if (optedOut.length) {
    console.log(
      `  ${
        optedOut.map((s) => s.name).join(", ")
      } is opt-in because it leaves records behind; add --all to include it`,
    );
  }
}

if (missed.length) {
  console.log(`\nnot reached (${missed.length}):`);
  for (const path of missed) console.log(`  ${path}`);
}

if (ctx.gaps.length) {
  console.log(
    `\nreached only through the escape hatch, because the generated method ` +
      `cannot express the request (${ctx.gaps.length}):`,
  );
  for (const g of ctx.gaps) console.log(`  ${g}`);
}

// A known failure only counts as "still broken" when its suite actually ran;
// a --only run that skips it proves nothing either way. Neither does a dry
// run: the stub answers every write with success, so it can say nothing about
// what CashCtrl does.
const ranSuites = new Set(selected.map((s) => s.name));
const applicable = dryRun
  ? []
  : KNOWN_FAILURES.filter((k) => ranSuites.has(k.step.split(":")[0]));
const isKnown = (failure: string) =>
  applicable.some((k) => failure.startsWith(k.step));

const expected = ctx.failures.filter(isKnown);
const unexpected = ctx.failures.filter((f) => !isKnown(f));
const fixedUpstream = applicable.filter((k) =>
  !ctx.failures.some((f) => f.startsWith(k.step))
);

if (expected.length) {
  console.log(
    `\nfailing upstream, expected (${expected.length}) - see KNOWN_FAILURES:`,
  );
  for (const f of expected) console.log(`  ${f}`);
}

if (unexpected.length) {
  console.log(`\nfailures (${unexpected.length}):`);
  for (const f of unexpected) console.log(`  ${f}`);
}

if (fixedUpstream.length) {
  console.log(
    `\n!! these are listed as failing upstream but passed ` +
      `(${fixedUpstream.length}). CashCtrl fixed them; drop them from ` +
      `KNOWN_FAILURES so a real regression cannot hide behind the entry:`,
  );
  for (const k of fixedUpstream) console.log(`  ${k.step}`);
}

if (ctx.undeletable.length) {
  console.log(
    `\nleft behind because the API refuses to delete them once referenced, ` +
      `deactivated instead (${ctx.undeletable.length}):`,
  );
  for (const u of ctx.undeletable) console.log(`  ${u}`);
}

if (ctx.leaked.length) {
  console.log(
    `\n!! CLEANUP FAILED, delete these by hand (${ctx.leaked.length}):`,
  );
  for (const l of ctx.leaked) console.log(`  ${l}`);
}

const bad = unexpected.length + fixedUpstream.length + ctx.leaked.length;
console.log(
  bad
    ? `\nFAIL: ${unexpected.length} unexpected, ${fixedUpstream.length} ` +
      `no longer failing, ${ctx.leaked.length} not cleaned up`
    : `\nOK${
      expected.length ? ` (${expected.length} known upstream failures)` : ""
    }`,
);
Deno.exit(bad ? 1 : 0);
