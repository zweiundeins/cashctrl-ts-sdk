/**
 * Read-only smoke test against a live organisation. Verifies that the
 * generated surface actually talks to CashCtrl and that inferred types
 * match what comes back.
 *
 * Run: deno run -A --env-file=.env scripts/smoke-test.ts
 */

import { CashCtrl, CashCtrlValidationError } from "../src/mod.ts";

const apiKey = Deno.env.get("CASHCTRL_APIKEY");
const organisation = Deno.env.get("CASHCTRL_DOMAINID");
if (!apiKey || !organisation) {
  console.error("Set CASHCTRL_APIKEY and CASHCTRL_DOMAINID");
  Deno.exit(1);
}

const cc = new CashCtrl({ organisation, apiKey, lang: "en" });
let failures = 0;

function check(label: string, condition: unknown, detail = ""): void {
  if (condition) {
    console.log(`  ok    ${label}${detail ? ` - ${detail}` : ""}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

console.log("accounts");
const accounts = await cc.account.list({ onlyActive: true });
check("account.list returns rows", accounts.length > 0, `${accounts.length}`);
const first = accounts[0];
check("row has numeric id", typeof first?.id === "number", `id=${first?.id}`);
check("row has string name", typeof first?.name === "string", first?.name);

console.log("\naccount.read (single object, unwrapped from `data`)");
const account = await cc.account.read({ id: first.id });
check("read returns an object", account && typeof account === "object");
check("read id matches", account.id === first.id, `${account.id}`);

console.log("\nnested resources");
const categories = await cc.account.category.list();
check(
  "account.category.list",
  Array.isArray(categories),
  `${categories.length}`,
);
const tree = await cc.account.category.tree();
check("account.category.tree", Array.isArray(tree), `${tree.length}`);

console.log("\nboolean + enum params serialize correctly");
const desc = await cc.account.list({
  onlyActive: true,
  dir: "DESC",
  sort: "number",
});
const asc = await cc.account.list({
  onlyActive: true,
  dir: "ASC",
  sort: "number",
});
check(
  "dir=DESC reverses dir=ASC",
  desc[0]?.id !== asc[0]?.id || desc.length <= 1,
  `first DESC=${desc[0]?.number} ASC=${asc[0]?.number}`,
);

console.log("\ntax + currency");
const taxes = await cc.tax.list();
check("tax.list", taxes.length > 0, `${taxes.length} tax codes`);
const currencies = await cc.currency.list();
check(
  "currency.list",
  currencies.length > 0,
  `${currencies.length} currencies`,
);

console.log("\nvalidation errors surface as CashCtrlValidationError");
try {
  await cc.account.read({ id: 999999999 });
  check("bad id throws", false, "no error thrown");
} catch (err) {
  check(
    "bad id throws CashCtrlValidationError",
    err instanceof CashCtrlValidationError,
    (err as Error).constructor.name,
  );
}

console.log("\nraw escape hatch");
const raw = await cc.http.get<{ data: unknown[] }>("/api/v1/tax/list.json");
check("http.get passthrough", Array.isArray(raw.data), `${raw.data.length}`);

console.log(failures ? `\n${failures} FAILURES` : "\nall checks passed");
Deno.exit(failures ? 1 : 0);
