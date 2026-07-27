import { assertEquals } from "@std/assert";
import { mergeUpdate } from "../src/merge.ts";
import { CashCtrl } from "../src/client.ts";
import { ORDER_UPDATE_FIELDS } from "../src/generated/resources.ts";

Deno.test("carries existing values through", () => {
  const existing = { id: 1, description: "Invoice", dueDays: 30 };
  const merged = mergeUpdate<Record<string, unknown>>(
    existing,
    { dueDays: 10 },
    ["id", "description", "dueDays"],
  );
  // description survives even though the caller never mentioned it.
  assertEquals(merged, { id: 1, description: "Invoice", dueDays: 10 });
});

Deno.test("drops read-only fields not in the writable list", () => {
  const existing = { id: 1, created: "2026-01-01", createdBy: "me", nr: "A1" };
  const merged = mergeUpdate<Record<string, unknown>>(existing, {}, [
    "id",
    "nr",
  ]);
  assertEquals(merged, { id: 1, nr: "A1" });
});

Deno.test("an explicit null still clears a field", () => {
  const existing = { id: 1, notes: "old note" };
  const merged = mergeUpdate<Record<string, unknown>>(
    existing,
    { notes: null },
    ["id", "notes"],
  );
  // null reaches the transport, which sends "" and clears it server-side.
  assertEquals(merged, { id: 1, notes: null });
});

Deno.test("undefined in changes means leave as-is, not clear", () => {
  const existing = { id: 1, notes: "keep me" };
  const merged = mergeUpdate<Record<string, unknown>>(
    existing,
    { notes: undefined },
    ["id", "notes"],
  );
  assertEquals(merged, { id: 1, notes: "keep me" });
});

Deno.test("undefined in existing is omitted entirely", () => {
  const existing = { id: 1, notes: undefined };
  const merged = mergeUpdate<Record<string, unknown>>(existing, {}, [
    "id",
    "notes",
  ]);
  assertEquals("notes" in merged, false);
});

Deno.test("ORDER_UPDATE_FIELDS matches the documented params", () => {
  // Guards against the generator drifting from the scraped spec.
  for (const required of ["id", "associateId", "categoryId", "date"]) {
    assertEquals(ORDER_UPDATE_FIELDS.includes(required), true, required);
  }
  // Read-only fields must never be resent.
  for (
    const readOnly of ["created", "createdBy", "subTotal", "dateLastBooked"]
  ) {
    assertEquals(ORDER_UPDATE_FIELDS.includes(readOnly), false, readOnly);
  }
});

Deno.test("updatePreserving posts the merged record", async () => {
  const calls: { init: RequestInit }[] = [];
  const client = new CashCtrl({
    organisation: "testorg",
    apiKey: "secret",
    retry: { attempts: 0 },
    fetch: (_url, init = {}) => {
      calls.push({ init: init as RequestInit });
      return Promise.resolve(
        new Response(JSON.stringify({ success: true }), {
          headers: { "content-type": "application/json" },
        }),
      );
    },
  });

  // A realistic read result, including fields we must not lose or resend.
  const existing = {
    id: 42,
    associateId: 7,
    categoryId: 4,
    date: "2026-07-01",
    description: "June consulting",
    dueDays: 10,
    notes: "internal",
    created: "2026-07-01T10:00:00",
    createdBy: "someone",
    subTotal: 1440,
  };

  await client.order.updatePreserving(existing, {
    id: 42,
    items: [{ accountId: 1, name: "New line", unitPrice: 100 }],
  });

  const body = calls[0].init.body as URLSearchParams;
  assertEquals(body.get("description"), "June consulting"); // preserved
  assertEquals(body.get("notes"), "internal"); // preserved
  assertEquals(body.get("dueDays"), "10"); // preserved
  assertEquals(body.get("associateId"), "7"); // preserved
  assertEquals(body.has("created"), false); // read-only, not resent
  assertEquals(body.has("subTotal"), false); // computed, not resent
  assertEquals(
    body.get("items"),
    '[{"accountId":1,"name":"New line","unitPrice":100}]',
  );
});
