/**
 * Executes real create/read/update/delete round-trips against a live
 * organisation, so the write path is actually exercised rather than merely
 * typechecked.
 *
 * SAFE TO RUN ON A PRODUCTION ORGANISATION. Every resource here is master
 * data with no accounting effect, and crucially none of them has an `nr`
 * assigned from a sequence number.
 *
 * That last point is the whole reason this file has tiers. Creating an order,
 * person, article or salary statement consumes the next number in its
 * sequence, and deleting the record does NOT give the number back. On books
 * numbered RE-202601.01, RE-202512.02, ... a test run would leave a permanent
 * gap in an audit-relevant sequence. Journal entries are excluded for a
 * different reason: they are real postings, VAT-relevant even if deletable.
 *
 * Those resources are listed in ACCOUNTING_TIER and are never touched. To
 * cover them, point this at a disposable trial organisation and pass
 * --include-accounting.
 *
 * Everything created is named with a recognisable prefix and deleted again;
 * anything that survives is reported loudly at the end.
 *
 * Run: deno run -A --env-file=.env scripts/roundtrip-test.ts [--include-accounting]
 */

import { CashCtrl, CashCtrlValidationError } from "../src/mod.ts";

const apiKey = Deno.env.get("CASHCTRL_APIKEY");
const organisation = Deno.env.get("CASHCTRL_DOMAINID");
if (!apiKey || !organisation) {
  console.error("Set CASHCTRL_APIKEY and CASHCTRL_DOMAINID");
  Deno.exit(1);
}

/** Resources that consume a sequence number or post to the books. */
const ACCOUNTING_TIER = [
  "order",
  "person",
  "inventory/article",
  "salary/statement",
  "journal",
];

const includeAccounting = Deno.args.includes("--include-accounting");
if (includeAccounting) {
  console.error(
    "--include-accounting is not implemented on purpose.\n" +
      `It would touch: ${ACCOUNTING_TIER.join(", ")}.\n` +
      "Creating those consumes sequence numbers that deletion does not " +
      "return, leaving permanent gaps in invoice/person numbering, and " +
      "journal entries are real postings. Use a disposable trial " +
      "organisation and implement the tier there.",
  );
  Deno.exit(1);
}

// Recognisable, sorts to the end of any list, obviously not real data.
// Kept short: several name fields cap at 50 characters, and a long prefix
// makes the suffixed update values overflow and fail validation.
const TAG = `zzz-sdk-${Date.now().toString(36)}`;

const cc = new CashCtrl({ organisation, apiKey, lang: "en" });

let passed = 0;
let failed = 0;
const leaked: string[] = [];

function check(label: string, ok: unknown, detail = ""): void {
  if (ok) {
    passed++;
    console.log(`    ok   ${label}${detail ? ` (${detail})` : ""}`);
  } else {
    failed++;
    console.log(`    FAIL ${label}${detail ? ` (${detail})` : ""}`);
  }
}

/** A resource exposing the CRUD subset this test drives. */
interface Crud {
  create(params: Record<string, unknown>): Promise<{ insertId?: number }>;
  read(params: { id: number }): Promise<Record<string, unknown>>;
  update(params: Record<string, unknown>): Promise<unknown>;
  updatePreserving(
    existing: Readonly<Record<string, unknown>>,
    changes: Record<string, unknown>,
  ): Promise<unknown>;
  delete(params: { ids: number }): Promise<unknown>;
  list(params?: Record<string, unknown>): Promise<Record<string, unknown>[]>;
}

interface Case {
  name: string;
  resource: () => Crud;
  create: Record<string, unknown>;
  /** Field the update step changes, and the value to change it to. */
  updateField: string;
  updateValue: string;
  /** Extra field set at create, which updatePreserving must not clobber. */
  preserveField?: string;
  preserveValue?: string;
}

const cases: Case[] = [
  {
    name: "inventory/unit",
    resource: () => cc.inventory.unit as unknown as Crud,
    create: { name: `${TAG}-unit` },
    updateField: "name",
    updateValue: `${TAG}-unit-renamed`,
  },
  {
    name: "person/title",
    resource: () => cc.person.title as unknown as Crud,
    create: { name: `${TAG}-title` },
    updateField: "name",
    updateValue: `${TAG}-title-renamed`,
  },
  {
    name: "person/category",
    resource: () => cc.person.category as unknown as Crud,
    create: { name: `${TAG}-pcat` },
    updateField: "name",
    updateValue: `${TAG}-pcat-renamed`,
  },
  {
    name: "inventory/article/category",
    resource: () => cc.inventory.article.category as unknown as Crud,
    create: { name: `${TAG}-acat` },
    updateField: "name",
    updateValue: `${TAG}-acat-renamed`,
  },
  {
    name: "file/category",
    resource: () => cc.file.category as unknown as Crud,
    create: { name: `${TAG}-fcat` },
    updateField: "name",
    updateValue: `${TAG}-fcat-renamed`,
  },
  {
    name: "location",
    resource: () => cc.location as unknown as Crud,
    create: { name: `${TAG}-loc`, city: "Testville" },
    updateField: "name",
    updateValue: `${TAG}-loc-renamed`,
    preserveField: "city",
    preserveValue: "Testville",
  },
  {
    name: "customfield/group",
    resource: () => cc.customfield.group as unknown as Crud,
    create: { name: `${TAG}-cfg`, type: "PERSON" },
    updateField: "name",
    updateValue: `${TAG}-cfg-renamed`,
  },
  {
    name: "text",
    resource: () => cc.text as unknown as Crud,
    create: { name: `${TAG}-text`, type: "ORDER_FOOTER", value: "hello" },
    updateField: "name",
    updateValue: `${TAG}-text-renamed`,
    preserveField: "value",
    preserveValue: "hello",
  },
];

console.log(`round-trip against ${organisation}.cashctrl.com`);
console.log(`tag: ${TAG}`);
console.log(`skipping accounting tier: ${ACCOUNTING_TIER.join(", ")}\n`);

for (const testCase of cases) {
  console.log(testCase.name);
  const resource = testCase.resource();
  let id: number | undefined;

  try {
    // CREATE
    const created = await resource.create(testCase.create);
    id = created.insertId;
    check("create returns insertId", typeof id === "number", `id=${id}`);
    if (typeof id !== "number") continue;

    // READ BACK: does the server hold what we think we sent?
    const record = await resource.read({ id });
    check("read-back returns the record", record?.id === id);
    for (const [field, value] of Object.entries(testCase.create)) {
      // `name` may come back wrapped in localized XML, so compare loosely.
      const actual = String(record[field] ?? "");
      check(
        `create field '${field}' persisted`,
        actual.includes(String(value)),
        `${actual.slice(0, 48)}`,
      );
    }

    // UPDATE
    await resource.update({
      ...testCase.create,
      id,
      [testCase.updateField]: testCase.updateValue,
    });
    const updated = await resource.read({ id });
    check(
      "update changed the field",
      String(updated[testCase.updateField] ?? "").includes(
        testCase.updateValue,
      ),
    );

    // UPDATE PRESERVING: the whole point is that untouched fields survive.
    if (testCase.preserveField) {
      await resource.updatePreserving(updated, {
        id,
        [testCase.updateField]: `${testCase.updateValue}-2`,
      });
      const preserved = await resource.read({ id });
      check(
        `updatePreserving kept '${testCase.preserveField}'`,
        String(preserved[testCase.preserveField] ?? "").includes(
          testCase.preserveValue!,
        ),
        `${testCase.preserveField}=${preserved[testCase.preserveField]}`,
      );
      check(
        "updatePreserving still applied the change",
        String(preserved[testCase.updateField] ?? "").includes(
          `${testCase.updateValue}-2`,
        ),
      );
    }
  } catch (err) {
    failed++;
    const message = err instanceof CashCtrlValidationError
      ? JSON.stringify(err.byField())
      : (err as Error).message;
    console.log(`    FAIL threw: ${message.slice(0, 160)}`);
  } finally {
    // DELETE, always, even if assertions failed above.
    if (typeof id === "number") {
      try {
        await resource.delete({ ids: id });
        const remaining = await resource.list();
        const stillThere = remaining.some((r) => r.id === id);
        check("delete removed the record", !stillThere);
        if (stillThere) leaked.push(`${testCase.name} id=${id}`);
      } catch (err) {
        leaked.push(`${testCase.name} id=${id}`);
        console.log(
          `    FAIL cleanup: ${(err as Error).message.slice(0, 120)}`,
        );
        failed++;
      }
    }
  }
  console.log();
}

console.log(`${passed} passed, ${failed} failed`);
if (leaked.length) {
  console.log(
    `\n!! LEFTOVER RECORDS, delete these by hand:\n  ${leaked.join("\n  ")}`,
  );
}
Deno.exit(failed || leaked.length ? 1 : 0);
