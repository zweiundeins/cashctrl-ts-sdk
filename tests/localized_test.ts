import { assertEquals } from "@std/assert";
import {
  isLocalized,
  localize,
  parseLocalized,
  toLocalized,
} from "../src/localized.ts";

// Verbatim from a live `account/read.json` response.
const LIVE =
  "<values><de>Kasse</de><en>Cash</en><fr>Caisse</fr><it>Cassa</it></values>";

Deno.test("detects the values wrapper", () => {
  assertEquals(isLocalized(LIVE), true);
  assertEquals(isLocalized("Kasse"), false);
  assertEquals(isLocalized(null), false);
});

Deno.test("parses every language", () => {
  assertEquals(parseLocalized(LIVE), {
    de: "Kasse",
    en: "Cash",
    fr: "Caisse",
    it: "Cassa",
  });
});

Deno.test("localize picks the requested language", () => {
  assertEquals(localize(LIVE, "de"), "Kasse");
  assertEquals(localize(LIVE, "en"), "Cash");
});

Deno.test("localize passes plain strings straight through", () => {
  assertEquals(localize("Just text", "de"), "Just text");
  assertEquals(localize(null, "de"), "");
});

Deno.test("localize falls back when the language is missing", () => {
  const partial = "<values><de>Nur Deutsch</de></values>";
  assertEquals(localize(partial, "it"), "Nur Deutsch");
});

Deno.test("round-trips through toLocalized", () => {
  const text = { de: "Kasse", en: "Cash" };
  assertEquals(parseLocalized(toLocalized(text)), text);
});

Deno.test("escapes XML metacharacters", () => {
  const xml = toLocalized({ en: "Fish & Chips <hot>" });
  assertEquals(xml, "<values><en>Fish &amp; Chips &lt;hot&gt;</en></values>");
  assertEquals(parseLocalized(xml).en, "Fish & Chips <hot>");
});
