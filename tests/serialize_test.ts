import { assertEquals } from "@std/assert";
import { formatDate, serializeParam } from "../src/http.ts";

Deno.test("scalars", () => {
  assertEquals(serializeParam("hi"), "hi");
  assertEquals(serializeParam(42), "42");
  assertEquals(serializeParam(0), "0");
  assertEquals(serializeParam(-1.5), "-1.5");
});

Deno.test("booleans become the strings CashCtrl expects", () => {
  assertEquals(serializeParam(true), "true");
  assertEquals(serializeParam(false), "false");
});

Deno.test("undefined is omitted, null clears the field", () => {
  // Update endpoints treat an omitted param as empty, so the two must differ.
  assertEquals(serializeParam(undefined), undefined);
  assertEquals(serializeParam(null), "");
});

Deno.test("dates use YYYY-MM-DD", () => {
  assertEquals(serializeParam(new Date(2026, 6, 27)), "2026-07-27");
  assertEquals(formatDate(new Date(2026, 0, 5)), "2026-01-05");
});

Deno.test("scalar arrays become CSV", () => {
  assertEquals(serializeParam([1, 2, 3]), "1,2,3");
  assertEquals(serializeParam(["a", "b"]), "a,b");
  assertEquals(serializeParam([]), "");
});

Deno.test("object arrays become JSON", () => {
  assertEquals(
    serializeParam([{ accountId: 1, name: "Work" }]),
    '[{"accountId":1,"name":"Work"}]',
  );
});

Deno.test("plain objects become JSON", () => {
  assertEquals(serializeParam({ a: 1 }), '{"a":1}');
});
