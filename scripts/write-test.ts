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
 *      deno task write-test --org=<organisation>
 *      deno task write-test --org=<organisation> --only=orders,journal
 *      deno task write-test --org=<organisation> --mail=you@example.com
 */

import { CashCtrl } from "../src/mod.ts";
import {
  allWritePaths,
  Ctx,
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

const selected = suites.filter((s) => only ? only.includes(s.name) : !s.optIn);
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
  console.log(`suites not run: ${skipped.map((s) => s.name).join(", ")}`);
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

if (ctx.failures.length) {
  console.log(`\nfailures (${ctx.failures.length}):`);
  for (const f of ctx.failures) console.log(`  ${f}`);
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

Deno.exit(ctx.failed || ctx.leaked.length ? 1 : 0);
