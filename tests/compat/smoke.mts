/**
 * Cross-runtime check: the SDK must work on any runtime with web-standard
 * `fetch`, not just Deno. Run under Node (`node --experimental-strip-types`)
 * and Bun (`bun run`). No network: fetch is stubbed.
 */

import { CashCtrl } from "../../src/mod.ts";
import { localize, toLocalized } from "../../src/localized.ts";
import { serializeParam } from "../../src/http.ts";
import { CashCtrlValidationError } from "../../src/errors.ts";

const runtime = "Deno" in globalThis
  ? "Deno"
  : "Bun" in globalThis
  ? "Bun"
  : "Node";

let failures = 0;
function check(label: string, condition: unknown): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}`);
  }
}

console.log(`cross-runtime smoke test on ${runtime}`);

const calls: { url: URL; init: RequestInit }[] = [];
const cc = new CashCtrl({
  organisation: "testorg",
  apiKey: "secret",
  retry: { attempts: 0 },
  fetch: (input, init = {}) => {
    const url = input instanceof URL ? input : new URL(String(input));
    calls.push({ url, init });
    const body = url.pathname.includes("journal")
      ? { success: false, errors: [{ field: "amount", message: "Required." }] }
      : { success: true, total: 1, data: [{ id: 1, name: "Cash" }] };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      }),
    );
  },
});

// Transport: URL building, basic auth, param serialization.
const accounts = await cc.account.list({ onlyActive: true });
check("list unwraps the data envelope", accounts.length === 1);
check(
  "builds the org URL",
  calls[0].url.origin === "https://testorg.cashctrl.com",
);
check(
  "serializes booleans",
  calls[0].url.searchParams.get("onlyActive") === "true",
);

const auth = (calls[0].init.headers as Record<string, string>).Authorization;
check("base64 basic auth works", auth === `Basic ${btoa("secret:")}`);

// Nested resource routing.
await cc.account.costcenter.category.list();
check(
  "nested resources route correctly",
  calls[1].url.pathname === "/api/v1/account/costcenter/category/list.json",
);

// Form encoding on writes.
await cc.account.create({ categoryId: 1, name: "Cash", number: 1000 });
check(
  "POST bodies are URLSearchParams",
  calls[2].init.body instanceof URLSearchParams,
);

// Error promotion.
let threw = false;
try {
  await cc.journal.create({ amount: 0, debitId: 1, creditId: 2 });
} catch (err) {
  threw = err instanceof CashCtrlValidationError;
}
check("success:false becomes a thrown error", threw);

// Pure helpers.
check(
  "date serialization",
  serializeParam(new Date(2026, 6, 27)) === "2026-07-27",
);
check("csv serialization", serializeParam([1, 2, 3]) === "1,2,3");
check(
  "localized round-trip",
  localize(toLocalized({ de: "Kasse", en: "Cash" }), "en") === "Cash",
);

// Throw rather than calling process.exit: an uncaught throw exits non-zero on
// Deno, Node and Bun alike, without reaching for a runtime-specific global.
if (failures) throw new Error(`${failures} failure(s) on ${runtime}`);
console.log(`\nall passed on ${runtime}`);
