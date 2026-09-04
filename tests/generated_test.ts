import { assertEquals, assertStringIncludes } from "@std/assert";

/**
 * Guards on the generated output. Both of these were wrong once and the
 * failure is silent: the types still compile, they just describe the API
 * incorrectly.
 */
const models = await Deno.readTextFile(
  new URL("../src/generated/models.ts", import.meta.url),
);

Deno.test("tree types refer to themselves rather than stopping at sample depth", () => {
  assertStringIncludes(models, "data?: ReportTreeResult[];");
  assertStringIncludes(models, "data?: ReportElementDataResult[];");
  // The truncated forms the generator used to emit.
  assertEquals(models.includes("ReportTreeResultData "), false);
  assertEquals(models.includes("ReportElementDataResultData "), false);
});

Deno.test("an array empty in one sample keeps the type from the other", () => {
  // openMonthIds is empty for a closed period and populated for an open one;
  // merging the two must not leave it as unknown[].
  const period = models.slice(models.indexOf("export type Fiscalperiod = {"));
  assertStringIncludes(
    period.slice(0, period.indexOf("};")),
    "openMonthIds: string[];",
  );
});

Deno.test("endpoints reachable only with a harvested parameter are typed", () => {
  for (
    const entity of [
      "export type Customfield = {",
      "export type JournalImportEntry = {",
      "export type OrderBookentry = {",
    ]
  ) {
    assertStringIncludes(models, entity);
  }
});
