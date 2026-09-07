/**
 * Shared machinery for `scripts/write-test.ts`: the safety guard that keeps
 * the harness off production, a recording `fetch` that proves which write
 * endpoints were actually reached, and the assertion/cleanup bookkeeping the
 * suites are written against.
 *
 * Split out from the suites so the dangerous part - deciding which
 * organisation gets written to - is short enough to audit in one screen.
 */

import { type CashCtrl, CashCtrlValidationError } from "../src/mod.ts";

/** Every POST path in the scraped reference, i.e. the full write surface. */
export function allWritePaths(specPath = "spec/api.json"): string[] {
  const raw = JSON.parse(Deno.readTextFileSync(specPath));
  const endpoints: { method: string; path: string }[] = Array.isArray(raw)
    ? raw
    : (raw.endpoints ?? Object.values(raw).find(Array.isArray));
  return endpoints
    .filter((e) => e.method.toUpperCase() === "POST")
    .map((e) => e.path)
    .sort();
}

/**
 * Resolves the target organisation.
 *
 * Reads `CASHCTRL_TEST_*` and never `CASHCTRL_DOMAINID`/`CASHCTRL_APIKEY`, so
 * this harness cannot resolve to the production organisation even if the
 * production variables are the only ones exported. The org name must also be
 * repeated on the command line, so `deno task write-test` alone does nothing.
 */
export function resolveTarget(args: string[]): {
  organisation: string;
  apiKey: string;
} {
  const organisation = Deno.env.get("CASHCTRL_TEST_DOMAINID")?.trim();
  const apiKey = Deno.env.get("CASHCTRL_TEST_APIKEY")?.trim();
  if (!organisation || !apiKey) {
    throw new Error(
      "Set CASHCTRL_TEST_DOMAINID and CASHCTRL_TEST_APIKEY to a disposable " +
        "organisation. This harness deliberately ignores CASHCTRL_DOMAINID " +
        "and CASHCTRL_APIKEY so it can never run against production.",
    );
  }

  const prodOrg = Deno.env.get("CASHCTRL_DOMAINID")?.trim();
  const prodKey = Deno.env.get("CASHCTRL_APIKEY")?.trim();
  if (prodOrg && prodOrg === organisation) {
    throw new Error(
      `CASHCTRL_TEST_DOMAINID is the same organisation as CASHCTRL_DOMAINID ` +
        `(${organisation}). Refusing: this harness deletes fiscal periods.`,
    );
  }
  if (prodKey && prodKey === apiKey) {
    throw new Error(
      "CASHCTRL_TEST_APIKEY is the production API key. Refusing.",
    );
  }

  const flag = args.find((a) => a.startsWith("--org="));
  const confirmed = flag?.slice("--org=".length);
  if (confirmed !== organisation) {
    throw new Error(
      `This harness creates and deletes real records, books real journal ` +
        `entries and completes fiscal periods.\n` +
        `Confirm the target by repeating it:\n\n` +
        `  deno task write-test --org=${organisation}\n`,
    );
  }
  return { organisation, apiKey };
}

/** A `fetch` that records the path of every write it lets through. */
export function recordingFetch(
  seen: Set<string>,
  inner: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  return (input, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST") {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : input.url;
      seen.add(new URL(url).pathname);
    }
    return inner(input, init);
  };
}

export interface Suite {
  name: string;
  /** Skipped unless explicitly selected; for suites that leave a mark. */
  optIn?: boolean;
  run(ctx: Ctx): Promise<void>;
}

/** Ids and records discovered from the target organisation before writing. */
export interface World {
  /** Financial accounts keyed by their account number, e.g. `"1020"`. */
  account(number: string): number;
  /** First account whose number starts with `prefix`. */
  accountLike(prefix: string): number;
  /** An account number not yet in use, so `account/create` cannot collide. */
  freeAccountNumber(): string;
  currencyId: number;
  /**
   * A root account category. `account/category/create` documents only `name`
   * as required, but the server rejects it without a `parentId`.
   */
  accountCategoryParentId?: number;
  /** An existing tax code, cloned when creating one (the format is undocumented). */
  sampleTax?: Record<string, unknown>;
  /** An existing order category, cloned for its `status` JSON. */
  sampleOrderCategory?: Record<string, unknown>;
  fiscalPeriodId: number;
  /** Fiscal period the run started in, restored by the year-end suite. */
  originalFiscalPeriodId: number;
}

export class Ctx {
  readonly cc: CashCtrl;
  readonly tag: string;
  readonly args: string[];
  /** The same `fetch` the client uses, for the raw PUT a file upload needs. */
  readonly fetch: typeof globalThis.fetch;
  world!: World;

  passed = 0;
  failed = 0;
  readonly failures: string[] = [];
  readonly leaked: string[] = [];
  /** Endpoints that only work around a defect in the generated surface. */
  readonly gaps: string[] = [];
  /** Records the API offers no way to delete, deactivated instead. */
  readonly undeletable: string[] = [];
  #cleanups: {
    label: string;
    fn: () => Promise<unknown>;
    fallback?: () => Promise<unknown>;
  }[] = [];
  #suite = "";

  constructor(
    cc: CashCtrl,
    tag: string,
    args: string[],
    fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  ) {
    this.cc = cc;
    this.tag = tag;
    this.args = args;
    this.fetch = fetchImpl;
  }

  flag(name: string): string | undefined {
    const hit = this.args.find((a) => a.startsWith(`--${name}=`));
    return hit?.slice(name.length + 3);
  }

  enterSuite(name: string): void {
    this.#suite = name;
    this.#cleanups = [];
  }

  check(label: string, ok: unknown, detail = ""): boolean {
    const suffix = detail ? ` (${detail})` : "";
    if (ok) {
      this.passed++;
      console.log(`    ok   ${label}${suffix}`);
      return true;
    }
    this.failed++;
    this.failures.push(`${this.#suite}: ${label}${suffix}`);
    console.log(`    FAIL ${label}${suffix}`);
    return false;
  }

  /**
   * Runs one write and reports it. Returns `undefined` when it threw, so a
   * suite can bail out of a chain without a try/catch at every link.
   */
  async step<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    try {
      const value = await fn();
      this.check(label, true);
      return value;
    } catch (err) {
      this.check(label, false, describe(err));
      return undefined;
    }
  }

  /**
   * Records that an endpoint could only be reached through `cc.http`, because
   * the generated method cannot express what the server needs. Not a failure
   * of the API - a defect in this SDK - so it is reported separately.
   */
  gap(endpoint: string, why: string): void {
    this.gaps.push(`${endpoint}: ${why}`);
    console.log(`    GAP  ${endpoint} - ${why}`);
  }

  /**
   * Registers cleanup, run last-in-first-out after the suite finishes.
   *
   * `fallback` is for records the API will not delete once something refers
   * to them - a person named on a payment, a salary template a statement
   * used - where deactivating is the only tidying available.
   */
  defer(
    label: string,
    fn: () => Promise<unknown>,
    fallback?: () => Promise<unknown>,
  ): void {
    this.#cleanups.push({ label, fn, fallback });
  }

  async runCleanups(): Promise<void> {
    for (const { label, fn, fallback } of this.#cleanups.reverse()) {
      try {
        await fn();
        continue;
      } catch (err) {
        if (!fallback) {
          this.leaked.push(`${this.#suite}: ${label} - ${describe(err)}`);
          continue;
        }
        try {
          await fallback();
          this.undeletable.push(`${this.#suite}: ${label} - ${describe(err)}`);
        } catch (fallbackErr) {
          this.leaked.push(
            `${this.#suite}: ${label} - ${describe(fallbackErr)}`,
          );
        }
      }
    }
    this.#cleanups = [];
  }
}

export function describe(err: unknown): string {
  if (err instanceof CashCtrlValidationError) {
    const byField = err.byField();
    // Not every validation failure is attributed to a field: "Type is missing"
    // arrives with an empty map, and printing `{}` loses the only useful part.
    return Object.keys(byField).length
      ? JSON.stringify(byField).slice(0, 200)
      : err.message.slice(0, 200);
  }
  return (err as Error).message.slice(0, 200);
}

/** `insertId`, or throws with the server's own complaint attached. */
export function insertId(result: { insertId?: number }): number {
  if (typeof result.insertId !== "number") {
    throw new Error(`no insertId in ${JSON.stringify(result).slice(0, 160)}`);
  }
  return result.insertId;
}
