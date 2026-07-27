import { assertEquals, assertRejects } from "@std/assert";
import { CashCtrl } from "../src/client.ts";
import type { CashCtrlOptions } from "../src/http.ts";
import {
  CashCtrlAuthError,
  CashCtrlHttpError,
  CashCtrlValidationError,
} from "../src/errors.ts";

/** Builds a client whose fetch is replaced by a recording stub. */
function stub(
  handler: (url: URL, init: RequestInit) => Response,
  options: Partial<CashCtrlOptions> = {},
) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const client = new CashCtrl({
    organisation: "testorg",
    apiKey: "secret",
    retry: { attempts: 0 },
    fetch: (input, init = {}) => {
      const url = input instanceof URL ? input : new URL(String(input));
      calls.push({ url, init });
      return Promise.resolve(handler(url, init));
    },
    ...options,
  });
  return { client, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

Deno.test("builds the organisation base URL", async () => {
  const { client, calls } = stub(() => json({ data: [] }));
  await client.account.list();
  assertEquals(calls[0].url.origin, "https://testorg.cashctrl.com");
  assertEquals(calls[0].url.pathname, "/api/v1/account/list.json");
});

Deno.test("sends the API key as basic auth with an empty password", async () => {
  const { client, calls } = stub(() => json({ data: [] }));
  await client.account.list();
  const header =
    (calls[0].init.headers as Record<string, string>).Authorization;
  assertEquals(header, `Basic ${btoa("secret:")}`);
});

Deno.test("GET params go in the query string", async () => {
  const { client, calls } = stub(() => json({ data: [] }));
  await client.account.list({ onlyActive: true, categoryId: 7, dir: "DESC" });
  const q = calls[0].url.searchParams;
  assertEquals(q.get("onlyActive"), "true");
  assertEquals(q.get("categoryId"), "7");
  assertEquals(q.get("dir"), "DESC");
});

Deno.test("POST params are form-encoded, not JSON", async () => {
  const { client, calls } = stub(() => json({ success: true, insertId: 5 }));
  await client.account.create({ categoryId: 1, name: "Cash", number: 1000 });
  const body = calls[0].init.body as URLSearchParams;
  assertEquals(body instanceof URLSearchParams, true);
  assertEquals(body.get("name"), "Cash");
  assertEquals(body.get("number"), "1000");
});

Deno.test("lang is attached to every request when configured", async () => {
  const { client, calls } = stub(() => json({ data: [] }), { lang: "de" });
  await client.account.list();
  assertEquals(calls[0].url.searchParams.get("lang"), "de");
});

Deno.test("unwraps the data envelope for list endpoints", async () => {
  const { client } = stub(() =>
    json({ success: true, total: 2, data: [{ id: 1 }, { id: 2 }] })
  );
  const accounts = await client.account.list();
  assertEquals(accounts.length, 2);
  assertEquals(accounts[0].id, 1);
});

Deno.test("unwraps the data envelope for read endpoints", async () => {
  const { client } = stub(() => json({ success: true, data: { id: 42 } }));
  const account = await client.account.read({ id: 42 });
  assertEquals(account.id, 42);
});

Deno.test("a 200 with success:false throws with field errors", async () => {
  const { client } = stub(() =>
    json({
      success: false,
      errors: [
        { field: "debitId", message: "This field cannot be empty." },
        { field: "amount", message: "This field cannot be empty." },
      ],
    })
  );
  const error = await assertRejects(
    () => client.journal.create({ amount: 0, debitId: 0, creditId: 0 }),
    CashCtrlValidationError,
  );
  assertEquals(error.errors.length, 2);
  assertEquals(error.byField().debitId, ["This field cannot be empty."]);
});

Deno.test("normalizes the map form of the errors field", async () => {
  const { client } = stub(() =>
    json({ success: false, errors: { name: ["Too long."] } })
  );
  const error = await assertRejects(
    () => client.account.create({ categoryId: 1, name: "x", number: 1 }),
    CashCtrlValidationError,
  );
  assertEquals(error.errors[0], { field: "name", message: "Too long." });
});

Deno.test("401 raises an auth error", async () => {
  const { client } = stub(() => new Response("nope", { status: 401 }));
  await assertRejects(() => client.account.list(), CashCtrlAuthError);
});

Deno.test("404 raises a plain HTTP error", async () => {
  const { client } = stub(() => new Response("gone", { status: 404 }));
  await assertRejects(() => client.account.list(), CashCtrlHttpError);
});

Deno.test("retries 5xx then succeeds", async () => {
  let attempt = 0;
  const { client } = stub(() => {
    attempt++;
    return attempt < 3
      ? new Response("boom", { status: 503 })
      : json({ data: [{ id: 1 }] });
  }, { retry: { attempts: 3, baseDelayMs: 1 } });
  const accounts = await client.account.list();
  assertEquals(attempt, 3);
  assertEquals(accounts.length, 1);
});

Deno.test("document endpoints return the raw Response", async () => {
  const { client } = stub(() =>
    new Response("%PDF-1.4", { headers: { "content-type": "application/pdf" } })
  );
  const response = await client.order.document.readPdf({ ids: 1 });
  assertEquals(response instanceof Response, true);
  assertEquals(await response.text(), "%PDF-1.4");
});

Deno.test("nested resources route to the right path", async () => {
  const { client, calls } = stub(() => json({ data: [] }));
  await client.account.costcenter.category.list();
  assertEquals(
    calls[0].url.pathname,
    "/api/v1/account/costcenter/category/list.json",
  );
});

Deno.test("null clears a field, undefined omits it", async () => {
  const { client, calls } = stub(() => json({ success: true }));
  await client.account.update({
    id: 1,
    categoryId: 1,
    name: "Cash",
    number: 1000,
    notes: null,
    currencyId: undefined,
  });
  const body = calls[0].init.body as URLSearchParams;
  assertEquals(body.get("notes"), "");
  assertEquals(body.has("currencyId"), false);
});
