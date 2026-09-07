/**
 * The write suites, in dependency order.
 *
 * Each suite creates what it needs, exercises every write endpoint of the
 * resources it owns, and registers cleanup as it goes so a failure halfway
 * through still tears down what came before it.
 *
 * Where a payload shape is undocumented - `tax.components`, the `status` JSON
 * of an order category - the suite clones an existing record from the target
 * organisation rather than hard-coding a guess, so it keeps working against a
 * differently configured chart of accounts.
 */

import { localize } from "../src/mod.ts";
import { type Ctx, insertId, type Suite, type World } from "./write-harness.ts";

/** The CRUD subset most master-data resources share. */
interface Crud {
  create(params: Record<string, unknown>): Promise<{ insertId?: number }>;
  update(params: Record<string, unknown>): Promise<unknown>;
  delete(params: { ids: number | number[] }): Promise<unknown>;
  read?(params: { id: number }): Promise<Record<string, unknown>>;
  list?(params?: Record<string, unknown>): Promise<Record<string, unknown>[]>;
}

const text = (value: unknown) => localize(String(value ?? ""), "en");

/**
 * create -> read back -> update -> delete for one resource.
 *
 * Returns the id while it is still alive, for suites that need to chain off
 * it; deletion is deferred, not immediate.
 */
async function crud(
  ctx: Ctx,
  label: string,
  resource: Crud,
  create: Record<string, unknown>,
  update: Record<string, unknown>,
  /** Used when the record can no longer be deleted; see `Ctx.defer`. */
  fallback?: (id: number) => Promise<unknown>,
): Promise<number | undefined> {
  const created = await ctx.step(
    `${label} create`,
    async () => insertId(await resource.create(create)),
  );
  if (created === undefined) return undefined;
  ctx.defer(
    `${label} ${created}`,
    () => resource.delete({ ids: created }),
    fallback && (() => fallback(created)),
  );

  if (resource.read) {
    const record = await ctx.step(
      `${label} read back`,
      () => resource.read!({ id: created }),
    );
    if (record) {
      const [field, expected] = Object.entries(create)[0];
      // Case-insensitive: the server normalises some fields on the way in
      // (a tax `code` comes back upper-cased), which is not a failure to
      // persist what was sent.
      ctx.check(
        `${label} persisted '${field}'`,
        text(record[field]).toLowerCase().includes(
          String(expected).toLowerCase(),
        ),
        text(record[field]).slice(0, 40),
      );
    }
  }

  await ctx.step(
    `${label} update`,
    () => resource.update({ ...create, ...update, id: created }),
  );
  return created;
}

/** Reads the ids every later suite needs, before anything is written. */
export async function discover(ctx: Ctx): Promise<World> {
  const cc = ctx.cc;
  const accounts = await cc.account.list() as Record<string, unknown>[];
  const byNumber = new Map<string, number>();
  for (const a of accounts) byNumber.set(String(a.number), a.id as number);

  const account = (number: string): number => {
    const id = byNumber.get(number);
    if (id === undefined) {
      throw new Error(`account ${number} does not exist in this organisation`);
    }
    return id;
  };
  const accountLike = (prefix: string): number => {
    for (const a of accounts) {
      if (String(a.number).startsWith(prefix)) return a.id as number;
    }
    throw new Error(`no account starting with ${prefix}`);
  };

  let next = 9000;
  const freeAccountNumber = (): string => {
    while (byNumber.has(String(next))) next++;
    const number = String(next);
    byNumber.set(number, -1); // reserve, so two calls never collide
    return number;
  };

  const accountCategories = await cc.account.category.tree() as Record<
    string,
    unknown
  >[];

  const currencies = await cc.currency.list() as Record<string, unknown>[];
  const currencyId = (currencies.find((c) => c.isDefault) ?? currencies[0])
    .id as number;

  const taxes = await cc.tax.list() as Record<string, unknown>[];
  const orderCategories = await cc.order.category
    .list() as Record<string, unknown>[];

  const periods = await cc.fiscalperiod.list() as Record<string, unknown>[];
  const current = periods.find((p) => p.isCurrent) ?? periods.at(-1)!;

  console.log(
    `  ${accounts.length} accounts, ${currencies.length} currencies, ` +
      `${taxes.length} tax codes, ${orderCategories.length} order ` +
      `categories, ${periods.length} fiscal periods`,
  );

  return {
    account,
    accountLike,
    freeAccountNumber,
    currencyId,
    accountCategoryParentId: accountCategories[0]?.id as number | undefined,
    sampleTax: taxes[0],
    sampleOrderCategory: orderCategories[0],
    fiscalPeriodId: current.id as number,
    originalFiscalPeriodId: current.id as number,
  };
}

/**
 * Master data with no dependencies beyond the chart of accounts. Everything
 * here is create/update/delete and, where the resource has one, reorder.
 */
const masterdata: Suite = {
  name: "masterdata",
  async run(ctx) {
    const cc = ctx.cc;
    const t = ctx.tag;

    await crud(ctx, "inventory/unit", cc.inventory.unit as unknown as Crud, {
      name: `${t}-unit`,
    }, { name: `${t}-unit2` });

    await crud(ctx, "person/title", cc.person.title as unknown as Crud, {
      name: `${t}-title`,
    }, { name: `${t}-title2` });

    await crud(ctx, "location", cc.location as unknown as Crud, {
      name: `${t}-loc`,
      city: "Testville",
    }, { name: `${t}-loc2` });

    await crud(ctx, "text", cc.text as unknown as Crud, {
      name: `${t}-text`,
      type: "ORDER_FOOTER",
      value: "hello",
    }, { name: `${t}-text2` });

    await crud(ctx, "sequencenumber", cc.sequencenumber as unknown as Crud, {
      name: `${t}-seq`,
      pattern: `${t}-$y-$nnn`,
    }, { name: `${t}-seq2` });

    await crud(ctx, "currency", cc.currency as unknown as Crud, {
      code: "XTS", // ISO 4217 "reserved for testing", never a real currency.
      rate: 1.5,
    }, { rate: 1.75 });

    await ctx.step("fiscalperiod/task create+delete", async () => {
      const id = insertId(
        // Only takes a name; the task lands in the current fiscal period.
        await cc.fiscalperiod.task.create({ name: `${t}-task` }),
      );
      await cc.fiscalperiod.task.delete({ ids: id });
    });

    // Categories, kept alive: later suites file records into them.
    await crud(
      ctx,
      "person/category",
      cc.person.category as unknown as Crud,
      { name: `${t}-pcat` },
      { name: `${t}-pcat2` },
    );
    await crud(
      ctx,
      "inventory/article/category",
      cc.inventory.article.category as unknown as Crud,
      { name: `${t}-acat` },
      { name: `${t}-acat2` },
    );
    await crud(
      ctx,
      "inventory/asset/category",
      cc.inventory.asset.category as unknown as Crud,
      { name: `${t}-ascat` },
      { name: `${t}-ascat2` },
    );
    await crud(
      ctx,
      "file/category",
      cc.file.category as unknown as Crud,
      { name: `${t}-fcat` },
      { name: `${t}-fcat2` },
    );

    // Custom fields: a group, then a field inside it. Both reorder.
    const groupId = await crud(
      ctx,
      "customfield/group",
      cc.customfield.group as unknown as Crud,
      { name: `${t}-cfg`, type: "PERSON" },
      { name: `${t}-cfg2` },
    );
    if (groupId !== undefined) {
      // Reorder moves records to another record's position, so it needs a
      // second, distinct one. Targeting itself returns an empty error object.
      const otherGroupId = await ctx.step(
        "customfield/group create (reorder target)",
        async () =>
          insertId(
            await cc.customfield.group.create({
              name: `${t}-cfg-b`,
              type: "PERSON",
            }),
          ),
      );
      if (otherGroupId !== undefined) {
        ctx.defer(
          `customfield/group ${otherGroupId}`,
          () => cc.customfield.group.delete({ ids: otherGroupId }),
        );
        // `type` appears nowhere in the published reference but the server
        // refuses without it ("Type is missing"); scripts/overrides.ts adds
        // it back, which is what makes this callable at all.
        await ctx.step(
          "customfield/group reorder",
          () =>
            cc.customfield.group.reorder({
              ids: groupId,
              target: otherGroupId,
              type: "PERSON",
            }),
        );
      }
      const fieldId = await crud(
        ctx,
        "customfield",
        cc.customfield as unknown as Crud,
        {
          type: "PERSON",
          dataType: "TEXT",
          rowLabel: `${t}-cf`,
          groupId: String(groupId),
        },
        { rowLabel: `${t}-cf2` },
      );
      if (fieldId !== undefined) {
        const otherFieldId = await ctx.step(
          "customfield create (reorder target)",
          async () =>
            insertId(
              await cc.customfield.create({
                type: "PERSON",
                dataType: "TEXT",
                rowLabel: `${t}-cf-b`,
                groupId: String(groupId),
              }),
            ),
        );
        if (otherFieldId !== undefined) {
          ctx.defer(
            `customfield ${otherFieldId}`,
            () => cc.customfield.delete({ ids: otherFieldId }),
          );
          await ctx.step(
            "customfield reorder",
            () =>
              cc.customfield.reorder({
                ids: fieldId,
                target: otherFieldId,
                type: "PERSON",
              }),
          );
        }
      }
    }

    // Reports.
    const collectionId = await crud(
      ctx,
      "report/collection",
      cc.report.collection as unknown as Crud,
      { name: `${t}-rcol` },
      { name: `${t}-rcol2` },
    );
    if (collectionId !== undefined) {
      await ctx.step(
        "report/collection reorder",
        () =>
          cc.report.collection.reorder({
            ids: collectionId,
            target: collectionId,
          }),
      );
      const elementId = await crud(
        ctx,
        "report/element",
        cc.report.element as unknown as Crud,
        { type: "BALANCE", name: `${t}-relem`, collectionId },
        { name: `${t}-relem2` },
      );
      if (elementId !== undefined) {
        await ctx.step(
          "report/element reorder",
          () =>
            cc.report.element.reorder({ ids: elementId, target: elementId }),
        );
      }
    }

    await crud(ctx, "order/layout", cc.order.layout as unknown as Crud, {
      name: `${t}-olay`,
    }, { name: `${t}-olay2` });
  },
};

/**
 * Uploads a small file and returns its id, or `undefined` if any step failed.
 *
 * Three endpoints in one: `prepare` hands back a temporary id and a write URL,
 * the bytes go up with a plain PUT, and then either `persist` or `create`
 * makes the file permanent. The caller picks which, because both are write
 * endpoints that need covering and they are not interchangeable: `create`
 * also sets metadata.
 */
async function uploadFile(
  ctx: Ctx,
  name: string,
  mimeType: string,
  body: string,
  finish: "persist" | "create",
): Promise<number | undefined> {
  const bytes = new TextEncoder().encode(body);
  const prepared = await ctx.step(
    `file/prepare (${finish})`,
    () =>
      ctx.cc.file.prepare({
        files: [{ name, mimeType, size: bytes.byteLength }],
      }),
  );
  if (!prepared) return undefined;

  // POST responses are never probed, so `prepare` is typed as the generic
  // WriteEnvelope while it actually answers with a `data` array of
  // { fileId, writeUrl }. Read it defensively rather than trusting the type.
  const payload = prepared as unknown as { data?: unknown[] };
  const list = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(prepared)
    ? prepared as unknown[]
    : [];
  const entry = list[0] as Record<string, unknown> | undefined;
  const tempId = entry?.fileId ?? entry?.id;
  const writeUrl = entry?.writeUrl ?? entry?.url;
  if (
    !ctx.check(
      "file/prepare returned an id and a write URL",
      tempId !== undefined && typeof writeUrl === "string",
      JSON.stringify(prepared).slice(0, 120),
    )
  ) return undefined;

  // Returns the status rather than nothing: `step` signals failure with
  // `undefined`, so a callback that falls off the end reads as a failure.
  const uploaded = await ctx.step("file PUT to storage", async () => {
    const res = await ctx.fetch(String(writeUrl), {
      method: "PUT",
      body: bytes,
      headers: { "Content-Type": mimeType },
    });
    await res.body?.cancel();
    if (!res.ok) throw new Error(`PUT ${res.status}`);
    return res.status;
  });
  if (uploaded === undefined) return undefined;

  if (finish === "persist") {
    const ok = await ctx.step(
      "file/persist",
      () => ctx.cc.file.persist({ ids: String(tempId) }),
    );
    return ok === undefined ? undefined : Number(tempId);
  }
  return await ctx.step(
    "file/create",
    async () =>
      insertId(await ctx.cc.file.create({ id: String(tempId), name })),
  );
}

/** The chart of accounts, cost centres, bank accounts, tax codes, roundings. */
const accounts: Suite = {
  name: "accounts",
  async run(ctx) {
    const cc = ctx.cc;
    const t = ctx.tag;
    const w = ctx.world;

    // `parentId` is undocumented as required but the server insists on it.
    const parentId = w.accountCategoryParentId;
    const categoryId = parentId === undefined
      ? (ctx.check("account/category: a root category to nest under", false),
        undefined)
      : await crud(
        ctx,
        "account/category",
        cc.account.category as unknown as Crud,
        { name: `${t}-acctcat`, parentId },
        { name: `${t}-acctcat2` },
      );

    if (categoryId !== undefined) {
      const number = w.freeAccountNumber();
      const accountId = await crud(
        ctx,
        "account",
        cc.account as unknown as Crud,
        { name: `${t}-acct`, number, categoryId },
        { name: `${t}-acct2` },
      );
      if (accountId !== undefined) {
        await ctx.step(
          "account categorize",
          () => cc.account.categorize({ ids: accountId, target: categoryId }),
        );
        await ctx.step(
          "account update_attachments",
          () => cc.account.updateAttachments({ id: accountId, fileIds: [] }),
        );
      }
    }

    // Bank account. CH93 0076 2011 6238 5295 7 is the IBAN every Swiss bank
    // publishes as its example, so it validates without belonging to anyone.
    const bankId = await crud(
      ctx,
      "account/bank",
      cc.account.bank as unknown as Crud,
      {
        name: `${t}-bank`,
        iban: "CH9300762011623852957",
        bic: "POFICHBEXXX",
        type: "DEFAULT",
      },
      { name: `${t}-bank2` },
    );
    if (bankId !== undefined) {
      await ctx.step(
        "account/bank update_attachments",
        () => cc.account.bank.updateAttachments({ id: bankId, fileIds: [] }),
      );
    }

    // Cost centres.
    const ccCategoryId = await crud(
      ctx,
      "account/costcenter/category",
      cc.account.costcenter.category as unknown as Crud,
      { name: `${t}-cccat` },
      { name: `${t}-cccat2` },
    );
    const costCenterId = await crud(
      ctx,
      "account/costcenter",
      cc.account.costcenter as unknown as Crud,
      {
        name: `${t}-cc`,
        number: Number(w.freeAccountNumber()),
        ...(ccCategoryId === undefined ? {} : { categoryId: ccCategoryId }),
      },
      { name: `${t}-cc2` },
    );
    if (costCenterId !== undefined && ccCategoryId !== undefined) {
      await ctx.step(
        "account/costcenter categorize",
        () =>
          cc.account.costcenter.categorize({
            ids: costCenterId,
            target: ccCategoryId,
          }),
      );
      await ctx.step(
        "account/costcenter update_attachments",
        () =>
          cc.account.costcenter.updateAttachments({
            id: costCenterId,
            fileIds: [],
          }),
      );
    }

    await crud(ctx, "rounding", cc.rounding as unknown as Crud, {
      name: `${t}-round`,
      accountId: w.accountLike("1"),
      rounding: 0.05,
    }, { name: `${t}-round2` });

    // Tax codes go through the typed methods rather than `crud`, whose
    // Record<string, unknown> params would erase exactly the structure worth
    // checking here: `components` and `rates` are documented as TEXT, but
    // each has a full sub-table the generator now emits as an object array.
    const taxAccountId =
      (w.sampleTax?.components as { accountId?: number }[] | undefined)
        ?.[0]?.accountId ?? w.accountLike("2");
    const code = t.slice(-6);

    const taxId = await ctx.step("tax create", async () =>
      insertId(
        await cc.tax.create({
          code,
          // `description` is documented as optional; rejected when empty.
          description: `${t} tax code`,
          components: [
            // `code` is documented as optional, but without it the whole
            // array is discarded: "At least one component must be set."
            {
              accountId: taxAccountId,
              applyRule: "CREDIT",
              calcType: "NET",
              code: "302",
            },
          ],
          rates: [{ percentage: 8.1 }],
        }),
      ));
    if (taxId !== undefined) {
      ctx.defer(`tax ${taxId}`, () => cc.tax.delete({ ids: taxId }));
      const record = await ctx.step(
        "tax read back",
        () => cc.tax.read({ id: taxId }),
      ) as Record<string, unknown> | undefined;
      if (record) {
        ctx.check(
          "tax persisted the rate",
          Number(
            (record.rates as { percentage?: number }[] | undefined)?.[0]
              ?.percentage,
          ) === 8.1,
          String(record.currentPercentage),
        );
      }
      await ctx.step("tax update", () =>
        cc.tax.update({
          id: taxId,
          code,
          description: `${t} tax code 2`,
          components: [
            {
              accountId: taxAccountId,
              applyRule: "CREDIT",
              calcType: "NET",
              code: "302",
            },
          ],
          rates: [{ percentage: 7.7 }],
        }));
    }
  },
};

/** Upload, metadata, categorise, archive, restore, purge. */
const files: Suite = {
  name: "files",
  async run(ctx) {
    const cc = ctx.cc;
    const t = ctx.tag;

    const categoryId = await ctx.step(
      "file/category create (for categorize)",
      async () =>
        insertId(await cc.file.category.create({ name: `${t}-filecat` })),
    );
    if (categoryId !== undefined) {
      ctx.defer(
        `file/category ${categoryId}`,
        () => cc.file.category.delete({ ids: categoryId }),
      );
    }

    // Path one: prepare -> PUT -> persist.
    const persisted = await uploadFile(
      ctx,
      `${t}-persist.txt`,
      "text/plain",
      "persisted by the write suite",
      "persist",
    );

    // Path two: prepare -> PUT -> create, which also writes metadata.
    const created = await uploadFile(
      ctx,
      `${t}-created.txt`,
      "text/plain",
      "created by the write suite",
      "create",
    );

    if (created !== undefined) {
      await ctx.step(
        "file/update",
        () => cc.file.update({ id: created, name: `${t}-renamed.txt` }),
      );
      if (categoryId !== undefined) {
        await ctx.step(
          "file/categorize",
          () => cc.file.categorize({ ids: created, target: categoryId }),
        );
      }
    }

    // delete without `force` archives; restore brings it back; delete with
    // `force` and then empty_archive is the only way to actually remove it.
    if (persisted !== undefined) {
      await ctx.step(
        "file/delete (archive)",
        () => cc.file.delete({ ids: persisted }),
      );
      await ctx.step(
        "file/restore",
        () => cc.file.restore({ ids: persisted }),
      );
      await ctx.step(
        "file/delete (force)",
        () => cc.file.delete({ ids: persisted, force: true }),
      );
    }
    await ctx.step("file/empty_archive", () => cc.file.emptyArchive());

    if (created !== undefined) {
      ctx.defer(
        `file ${created}`,
        () => cc.file.delete({ ids: created, force: true }),
      );
    }
  },
};

/**
 * A person complete enough to be invoiced and paid, owned by the calling
 * suite.
 *
 * Suites deliberately do not share records: cleanup runs at the end of each
 * suite, so anything one suite creates is gone before the next one starts.
 *
 * `addresses` and `bankAccounts` are JSON arrays despite being documented as
 * TEXT; without them a payment to this person fails with "Recipient: Address
 * must be set".
 */
async function createPayee(ctx: Ctx): Promise<number | undefined> {
  const id = await ctx.step("person create (payee)", async () =>
    insertId(
      await ctx.cc.person.create({
        company: `${ctx.tag} Payee AG`,
        firstName: "Pay",
        lastName: "Ee",
        isVendor: true,
        // Salary statements refuse a person that is not flagged an employee.
        isEmployee: true,
        addresses: [
          {
            type: "MAIN",
            address: "Teststrasse 1",
            zip: "3000",
            city: "Bern",
            country: "CHE",
          },
        ],
        bankAccounts: [
          {
            iban: "CH9300762011623852957",
            bic: "POFICHBEXXX",
            type: "DEFAULT",
          },
        ],
      }),
    ));
  if (id !== undefined) {
    // A person named on a payment can no longer be deleted, and payments have
    // no delete endpoint, so deactivating is the only tidying left.
    ctx.defer(
      `person ${id} (payee)`,
      () => ctx.cc.person.delete({ ids: id }),
      () =>
        ctx.cc.person.update({
          id,
          company: `${ctx.tag} Payee AG`,
          firstName: "Pay",
          lastName: "Ee",
          isInactive: true,
        }),
    );
  }
  return id;
}

/** create -> mapping -> execute, the three endpoints every importer shares. */
async function importCsv(
  ctx: Ctx,
  label: string,
  csv: string,
  mapping: readonly { from: string; to: string }[],
  create: (fileId: number) => Promise<{ insertId?: number }>,
  applyMapping: (
    id: number,
    mapping: readonly { from: string; to: string }[],
  ) => Promise<unknown>,
  execute: (id: number) => Promise<unknown>,
): Promise<void> {
  const fileId = await uploadFile(
    ctx,
    `${ctx.tag}-${label.replace(/\W+/g, "-")}.csv`,
    "text/csv",
    csv,
    "create",
  );
  if (fileId === undefined) return;
  ctx.defer(
    `${label} import file ${fileId}`,
    () => ctx.cc.file.delete({ ids: fileId, force: true }),
  );

  const importId = await ctx.step(
    `${label} create`,
    async () => insertId(await create(fileId)),
  );
  if (importId === undefined) return;

  await ctx.step(`${label} mapping`, () => applyMapping(importId, mapping));
  await ctx.step(`${label} execute`, () => execute(importId));
}

/** Business partners, including the CSV importer. */
const persons: Suite = {
  name: "persons",
  async run(ctx) {
    const cc = ctx.cc;
    const t = ctx.tag;

    const categoryId = await ctx.step(
      "person/category create (for categorize)",
      async () =>
        insertId(await cc.person.category.create({ name: `${t}-pcat` })),
    );
    if (categoryId !== undefined) {
      ctx.defer(
        `person/category ${categoryId}`,
        () => cc.person.category.delete({ ids: categoryId }),
      );
    }

    const personId = await crud(ctx, "person", cc.person as unknown as Crud, {
      company: `${t} AG`,
      firstName: "Test",
      lastName: "Person",
      // Documented as TEXT, really a JSON array - widened in overrides.ts.
      // An address is needed before an order to this person can be paid:
      // "Recipient: Address must be set."
      addresses: [
        {
          type: "MAIN",
          address: "Teststrasse 1",
          zip: "3000",
          city: "Bern",
          country: "CHE",
        },
      ],
      // Same story. Needed before this person can be paid: without it the
      // payment complains "Recipient: Address must be set".
      bankAccounts: [
        {
          iban: "CH9300762011623852957",
          bic: "POFICHBEXXX",
          type: "DEFAULT",
        },
      ],
      isVendor: true,
      // Salary statements refuse a person that is not flagged an employee.
      isEmployee: true,
      ...(categoryId === undefined ? {} : { categoryId }),
    }, { lastName: "Person-Renamed" });

    if (personId !== undefined) {
      if (categoryId !== undefined) {
        await ctx.step(
          "person categorize",
          () => cc.person.categorize({ ids: personId, target: categoryId }),
        );
      }
      await ctx.step(
        "person update_attachments",
        () => cc.person.updateAttachments({ id: personId, fileIds: [] }),
      );
    }

    await importCsv(
      ctx,
      "person/import",
      `company,firstName,lastName\n${t}-imported AG,Imported,Person\n`,
      // `to` is one of the importer's own field constants, not a field name
      // on Person. person/import/mapping_combo lists them; the docs point at
      // it but nothing says the value is a constant rather than a field.
      [
        { from: "company", to: "COMPANY" },
        { from: "firstName", to: "FIRST_NAME" },
        { from: "lastName", to: "LAST_NAME" },
      ],
      (fileId) =>
        cc.person.import.create({
          fileId,
          ...(categoryId === undefined ? {} : { categoryId }),
        }),
      (id, mapping) => cc.person.import.mapping({ id, mapping }),
      (id) => cc.person.import.execute({ id }),
    );
  },
};

/** Articles and fixed assets. */
const inventory: Suite = {
  name: "inventory",
  async run(ctx) {
    const cc = ctx.cc;
    const t = ctx.tag;
    const w = ctx.world;

    const articleCategoryId = await ctx.step(
      "inventory/article/category create (for categorize)",
      async () =>
        insertId(
          await cc.inventory.article.category.create({ name: `${t}-acat` }),
        ),
    );
    if (articleCategoryId !== undefined) {
      ctx.defer(
        `inventory/article/category ${articleCategoryId}`,
        () => cc.inventory.article.category.delete({ ids: articleCategoryId }),
      );
    }

    const articleId = await crud(
      ctx,
      "inventory/article",
      cc.inventory.article as unknown as Crud,
      {
        name: `${t}-article`,
        // Documented as optional, but one of `nr` or `sequenceNumberId` must
        // be present: "This field cannot be empty" otherwise.
        nr: `${t}-a1`,
        ...(articleCategoryId === undefined
          ? {}
          : { categoryId: articleCategoryId }),
      },
      { name: `${t}-article2` },
    );
    if (articleId !== undefined) {
      if (articleCategoryId !== undefined) {
        await ctx.step(
          "inventory/article categorize",
          () =>
            cc.inventory.article.categorize({
              ids: articleId,
              target: articleCategoryId,
            }),
        );
      }
      await ctx.step(
        "inventory/article update_attachments",
        () =>
          cc.inventory.article.updateAttachments({
            id: articleId,
            fileIds: [],
          }),
      );
    }

    await importCsv(
      ctx,
      "inventory/article/import",
      `name,price\n${t}-imported,42\n`,
      // Same constants, from inventory/article/import/mapping_combo.
      [
        { from: "name", to: "NAME_EN" },
        { from: "price", to: "SALES_PRICE_NET" },
      ],
      (fileId) => cc.inventory.article.import.create({ fileId }),
      (id, mapping) => cc.inventory.article.import.mapping({ id, mapping }),
      (id) => cc.inventory.article.import.execute({ id }),
    );

    // Fixed assets.
    const assetCategoryId = await ctx.step(
      "inventory/asset/category create (for categorize)",
      async () =>
        insertId(
          await cc.inventory.asset.category.create({ name: `${t}-ascat` }),
        ),
    );
    if (assetCategoryId !== undefined) {
      ctx.defer(
        `inventory/asset/category ${assetCategoryId}`,
        () => cc.inventory.asset.category.delete({ ids: assetCategoryId }),
      );
    }

    const assetId = await crud(
      ctx,
      "inventory/asset",
      cc.inventory.asset as unknown as Crud,
      {
        name: `${t}-asset`,
        accountId: w.accountLike("15"),
        dateAdded: new Date(),
        purchasePrice: 1000,
        // Both undocumented as required, both rejected when empty.
        nr: `${t}-f1`,
        purchaseCreditId: w.accountLike("10"),
        ...(assetCategoryId === undefined
          ? {}
          : { categoryId: assetCategoryId }),
      },
      { name: `${t}-asset2` },
    );
    if (assetId !== undefined) {
      if (assetCategoryId !== undefined) {
        await ctx.step(
          "inventory/asset categorize",
          () =>
            cc.inventory.asset.categorize({
              ids: assetId,
              target: assetCategoryId,
            }),
        );
      }
      await ctx.step(
        "inventory/asset update_attachments",
        () =>
          cc.inventory.asset.updateAttachments({ id: assetId, fileIds: [] }),
      );
    }
  },
};

/** Journal entries: real, VAT-relevant postings. */
const journal: Suite = {
  name: "journal",
  async run(ctx) {
    const cc = ctx.cc;
    const t = ctx.tag;
    const w = ctx.world;

    const id = await ctx.step("journal create", async () =>
      insertId(
        await cc.journal.create({
          amount: 12.34,
          debitId: w.accountLike("1"),
          creditId: w.accountLike("3"),
          dateAdded: new Date(),
          title: `${t}-journal`,
          reference: t,
        }),
      ));
    if (id === undefined) return;
    ctx.defer(`journal ${id}`, () => cc.journal.delete({ ids: id }));

    const record = await ctx.step(
      "journal read back",
      () => cc.journal.read({ id }),
    );
    if (record) {
      ctx.check(
        "journal posted the amount",
        Number(record.amount) === 12.34,
        String(record.amount),
      );
    }

    await ctx.step("journal update", () =>
      cc.journal.update({
        id,
        amount: 56.78,
        debitId: w.accountLike("1"),
        creditId: w.accountLike("3"),
        dateAdded: new Date(),
        title: `${t}-journal2`,
      }));

    await ctx.step(
      "journal update_attachments",
      () => cc.journal.updateAttachments({ id, fileIds: [] }),
    );

    await ctx.step(
      // `notifyType: "NONE"` is documented but makes the server answer 500 on
      // all three update_recurrence endpoints; omitting it is the documented
      // way to say "no notification" anyway.
      "journal update_recurrence",
      () =>
        cc.journal.updateRecurrence({
          id,
          recurrence: "MONTHLY",
          startDate: new Date(),
        }),
    );
  },
};

/** Ids of the statuses CashCtrl generated for an order category. */
async function categoryStatusIds(
  ctx: Ctx,
  categoryId: number,
): Promise<number[]> {
  const category = await ctx.cc.order.category.read({ id: categoryId });
  const status = (category as Record<string, unknown>).status;
  return Array.isArray(status)
    ? status.map((s) => (s as { id: number }).id).filter(Number.isFinite)
    : [];
}

/**
 * Orders end to end: categories with their status lists, an invoice with
 * items, the status/recurrence/attachment side-writes, a dossier, the
 * `continue` conversion into a purchase order, book entries and a payment.
 */
const orders: Suite = {
  name: "orders",
  async run(ctx) {
    const cc = ctx.cc;
    const t = ctx.tag;
    const w = ctx.world;

    const debtors = w.sampleOrderCategory?.accountId as number | undefined ??
      w.accountLike("11");
    const creditors = w.accountLike("2");
    const revenue = w.accountLike("3");
    const bank = w.accountLike("10");

    // `layoutId` is documented as optional but rejected when empty, so the
    // category needs a layout to exist before it does.
    const layoutId = await ctx.step(
      "order/layout create (for the category)",
      async () =>
        insertId(await cc.order.layout.create({ name: `${t}-olay-cat` })),
    );
    if (layoutId !== undefined) {
      ctx.defer(
        `order/layout ${layoutId}`,
        () => cc.order.layout.delete({ ids: layoutId }),
      );
    }

    const statuses = [
      { icon: "BLUE", name: "Draft" },
      { icon: "GREEN", name: "Paid", isBook: true, isClosed: true },
    ] as const;

    const salesCategoryId = await crud(
      ctx,
      "order/category (sales)",
      cc.order.category as unknown as Crud,
      {
        accountId: debtors,
        nameSingular: `${t}-inv`,
        namePlural: `${t}-invs`,
        status: statuses,
        type: "SALES",
        isDisplayPrices: true,
        ...(layoutId === undefined ? {} : { layoutId }),
      },
      { nameSingular: `${t}-inv2` },
    );
    if (salesCategoryId === undefined) return;

    await ctx.step(
      "order/category reorder",
      () =>
        cc.order.category.reorder({
          ids: salesCategoryId,
          target: salesCategoryId,
        }),
    );

    const purchaseCategoryId = await ctx.step(
      "order/category create (purchase)",
      async () =>
        insertId(
          await cc.order.category.create({
            accountId: creditors,
            nameSingular: `${t}-bill`,
            namePlural: `${t}-bills`,
            status: statuses,
            type: "PURCHASE",
            bookType: "CREDIT",
            ...(layoutId === undefined ? {} : { layoutId }),
          }),
        ),
    );
    if (purchaseCategoryId !== undefined) {
      ctx.defer(
        `order/category ${purchaseCategoryId}`,
        () => cc.order.category.delete({ ids: purchaseCategoryId }),
      );
    }

    const statusIds = await categoryStatusIds(ctx, salesCategoryId);
    ctx.check("order category has statuses", statusIds.length > 0);

    const personId = await createPayee(ctx);
    if (personId === undefined) return;

    // The invoice itself.
    const orderId = await ctx.step("order create", async () =>
      insertId(
        await cc.order.create({
          associateId: personId,
          categoryId: salesCategoryId,
          date: new Date(),
          description: `${t}-order`,
          // The new category has no sequence number attached, so the document
          // number has to come from us. Documented as optional.
          nr: `${t}-o1`,
          items: [
            {
              accountId: revenue,
              name: `${t}-item`,
              unitPrice: 100,
              quantity: 2,
            },
          ],
        }),
      ));
    if (orderId === undefined) return;
    ctx.defer(`order ${orderId}`, () => cc.order.delete({ ids: orderId }));

    const order = await ctx.step(
      "order read back",
      () => cc.order.read({ id: orderId }),
    ) as Record<string, unknown> | undefined;
    if (order) {
      ctx.check(
        "order total is 2 x 100",
        Number(order.total) === 200,
        String(order.total),
      );
    }

    await ctx.step("order update", () =>
      cc.order.update({
        id: orderId,
        associateId: personId,
        categoryId: salesCategoryId,
        date: new Date(),
        description: `${t}-order2`,
        nr: `${t}-o1`,
      }));

    if (statusIds.length) {
      // The second status is the one flagged `isBook`. An order in a
      // non-booking status is refused with "This document does not allow
      // book entries", so move it there before the book entry below.
      const bookingStatus = statusIds[statusIds.length - 1];
      await ctx.step(
        "order update_status",
        () => cc.order.updateStatus({ ids: orderId, statusId: bookingStatus }),
      );
    }

    await ctx.step(
      "order update_attachments",
      () => cc.order.updateAttachments({ id: orderId, fileIds: [] }),
    );

    await ctx.step("order update_recurrence", () =>
      cc.order.updateRecurrence({
        id: orderId,
        recurrence: "MONTHLY",
        startDate: new Date(),
      }));

    await ctx.step(
      "order/document update",
      () => cc.order.document.update({ id: orderId, footer: `${t}-footer` }),
    );

    // Continue the invoice as a purchase order, which is also what puts both
    // documents into a shared dossier.
    let continuedId: number | undefined;
    if (purchaseCategoryId !== undefined) {
      continuedId = await ctx.step("order continue", async () =>
        insertId(
          await cc.order.continue({
            ids: orderId,
            categoryId: purchaseCategoryId,
            associateId: String(personId),
            date: new Date(),
          }),
        ));
      if (continuedId !== undefined) {
        ctx.defer(
          `order ${continuedId} (continued)`,
          () => cc.order.delete({ ids: continuedId! }),
        );
      }
    }

    // The dossier id is carried on the order, not returned by `continue`.
    const afterContinue = await cc.order.read({ id: orderId }) as Record<
      string,
      unknown
    >;
    const groupId = afterContinue.groupId as number | null;
    if (typeof groupId === "number") {
      await ctx.step(
        "order dossier_remove",
        () => cc.order.dossierRemove({ groupId, ids: orderId }),
      );
      await ctx.step(
        "order dossier_add",
        () => cc.order.dossierAdd({ groupId, ids: orderId }),
      );
    } else {
      ctx.check(
        "order has a dossier after continue",
        false,
        `groupId=${groupId}`,
      );
    }

    // Book entry against the invoice, then a payment on the purchase side.
    const bookEntryId = await ctx.step(
      "order/bookentry create",
      async () =>
        insertId(
          await cc.order.bookentry.create({
            accountId: bank,
            orderIds: orderId,
            amount: 50,
            date: new Date(),
            description: `${t}-payment`,
          }),
        ),
    );
    if (bookEntryId !== undefined) {
      await ctx.step(
        "order/bookentry update",
        () =>
          cc.order.bookentry.update({
            id: bookEntryId,
            accountId: bank,
            amount: 75,
            // Documented as optional, rejected when empty.
            date: new Date(),
          }),
      );
      await ctx.step(
        "order/bookentry delete",
        () => cc.order.bookentry.delete({ ids: bookEntryId }),
      );
    }

    // A payment needs a purchase order with its own items and a payee that
    // has an address; the order produced by `continue` carries neither an
    // open amount nor a recipient address.
    if (purchaseCategoryId !== undefined) {
      const billId = await ctx.step(
        "order create (purchase, to pay)",
        async () =>
          insertId(
            await cc.order.create({
              associateId: personId,
              categoryId: purchaseCategoryId,
              date: new Date(),
              nr: `${t}-p1`,
              description: `${t}-bill`,
              items: [
                {
                  accountId: w.accountLike("4"),
                  name: `${t}-cost`,
                  unitPrice: 100,
                  quantity: 1,
                },
              ],
            }),
          ),
      );
      if (billId !== undefined) {
        ctx.defer(
          `order ${billId} (purchase)`,
          () => cc.order.delete({ ids: billId }),
        );
        // The open amount stays 0 until the order reaches a booking status,
        // and a payment on a zero open amount is refused as "not positive".
        // The `amount` parameter does not override this.
        const billStatuses = await categoryStatusIds(ctx, purchaseCategoryId);
        if (billStatuses.length) {
          await ctx.step(
            "order update_status (to book the bill)",
            () =>
              cc.order.updateStatus({
                ids: billId,
                statusId: billStatuses[billStatuses.length - 1],
              }),
          );
        }
        await ctx.step("order/payment create", () =>
          cc.order.payment.create({
            date: new Date(),
            orderIds: billId,
            type: "CASH_PDF",
          }));
      }
    }

    const mailTo = ctx.flag("mail");
    if (mailTo) {
      await ctx.step("order/document mail", () =>
        cc.order.document.mail({
          orderIds: orderId,
          mailFrom: mailTo,
          mailTo,
          mailSubject: `${t} write-suite test`,
          mailText: "Sent by the CashCtrl SDK write suite.",
        }));
    } else {
      console.log("    skip order/document mail (pass --mail=<address>)");
    }
  },
};

/**
 * The bank-statement importer: upload a CSV, map its columns, then walk an
 * entry through update, delete, restore, confirm and unconfirm before
 * executing the import into the journal.
 */
const bankimport: Suite = {
  name: "bankimport",
  async run(ctx) {
    const cc = ctx.cc;
    const t = ctx.tag;
    const w = ctx.world;

    const fileId = await uploadFile(
      ctx,
      `${t}-bank.csv`,
      "text/csv",
      // The importer rejects a three-column CSV outright ("file is invalid or
      // not supported") and needs a fourth. `skipRows` stays 0: the header row
      // is what `columnDate` and friends name.
      `Date,Amount,Description,Reference\r\n` +
        `2026-03-04,-19.90,${t}-bankline,${t}-r1\r\n` +
        `2026-03-05,-5.00,${t}-bankline2,${t}-r2\r\n`,
      "create",
    );
    if (fileId === undefined) return;
    ctx.defer(
      `bank import file ${fileId}`,
      () => cc.file.delete({ ids: fileId, force: true }),
    );

    const importId = await ctx.step(
      "journal/import create",
      async () =>
        insertId(
          await cc.journal.import.create({
            fileId,
            targetAccountId: w.accountLike("10"),
            skipRows: 0,
            mappings: [
              {
                columnDate: "Date",
                columnAmount: "Amount",
                columnDescription: "Description",
                fixedCreditId: w.accountLike("3"),
              },
            ],
          }),
        ),
    );
    if (importId === undefined) return;

    const entries = await ctx.step(
      "journal/import/entry list",
      () => cc.journal.import.entry.list({ importId }),
    ) as Record<string, unknown>[] | undefined;
    const entryId = entries?.[0]?.id as number | undefined;
    if (!ctx.check("import produced an entry", entryId !== undefined)) return;

    await ctx.step(
      "journal/import/entry update",
      () =>
        cc.journal.import.entry.update({
          id: entryId!,
          amount: 19.9,
          contraAccountId: w.accountLike("4"),
          dateAdded: new Date("2026-03-04"),
          title: `${t}-entry`,
        }),
    );

    await ctx.step(
      "journal/import/entry delete",
      () => cc.journal.import.entry.delete({ ids: entryId! }),
    );
    await ctx.step(
      "journal/import/entry restore",
      () => cc.journal.import.entry.restore({ ids: entryId! }),
    );
    await ctx.step(
      "journal/import/entry confirm",
      () => cc.journal.import.entry.confirm({ ids: entryId! }),
    );
    await ctx.step(
      "journal/import/entry unconfirm",
      () => cc.journal.import.entry.unconfirm({ ids: entryId! }),
    );
    await ctx.step(
      "journal/import/entry confirm (again, for execute)",
      () => cc.journal.import.entry.confirm({ ids: entryId! }),
    );

    await ctx.step(
      "journal/import execute",
      () => cc.journal.import.execute({ id: importId }),
    );

    // Executing posts real journal entries. There is no journal/import/delete,
    // so the import record itself stays; the postings it made are ours to
    // clean up, and they carry the tag.
    ctx.defer("journal entries from the import", async () => {
      const posted = await cc.journal.list({ query: t }) as Record<
        string,
        unknown
      >[];
      const ids = posted.map((j) => j.id as number).filter(Number.isFinite);
      if (ids.length) await cc.journal.delete({ ids });
    });
  },
};

/**
 * Payroll. Every id here has to be built first - a category, a type, a status
 * and a template - before a statement can exist at all, so this suite is one
 * long chain and each link reports separately.
 */
const salary: Suite = {
  name: "salary",
  async run(ctx) {
    const cc = ctx.cc;
    const t = ctx.tag;
    const w = ctx.world;
    const wages = w.accountLike("5");
    const bank = w.accountLike("10");

    const categoryId = await crud(
      ctx,
      "salary/category",
      cc.salary.category as unknown as Crud,
      { name: `${t}-scat` },
      { name: `${t}-scat2` },
    );

    await crud(
      ctx,
      "salary/insurance/type",
      cc.salary.insurance.type as unknown as Crud,
      { name: `${t}-ins` },
      { name: `${t}-ins2` },
    );

    await crud(ctx, "salary/setting", cc.salary.setting as unknown as Crud, {
      name: `${t}-sset`,
      variableName: `$${t.replace(/\W/g, "")}s`,
      type: "DECIMAL",
      decimalValue: 1,
    }, { name: `${t}-sset2` });

    await crud(ctx, "salary/sum", cc.salary.sum as unknown as Crud, {
      name: `${t}-ssum`,
      variableName: `$${t.replace(/\W/g, "")}m`,
    }, { name: `${t}-ssum2` });

    await crud(ctx, "salary/layout", cc.salary.layout as unknown as Crud, {
      name: `${t}-slay`,
    }, { name: `${t}-slay2` });

    await crud(
      ctx,
      "salary/certificate/template",
      cc.salary.certificate.template as unknown as Crud,
      { name: `${t}-scert` },
      { name: `${t}-scert2` },
    );

    const statusId = await crud(
      ctx,
      "salary/status",
      cc.salary.status as unknown as Crud,
      // `isBook` matters: a statement in a non-booking status is refused
      // with "This salary statement does not allow book entries".
      { name: `${t}-sstat`, icon: "GREEN", isBook: true },
      { name: `${t}-sstat2` },
    );
    if (statusId !== undefined) {
      await ctx.step(
        "salary/status reorder",
        () => cc.salary.status.reorder({ ids: statusId, target: statusId }),
      );
    }

    let typeId: number | undefined;
    if (categoryId !== undefined) {
      // The documented required set - categoryId, name, number, type - makes
      // the server answer 500, with or without the optional accounts and
      // calculation. Only a near-complete payload gets through, so clone an
      // existing type and rename its variables, which must be unique.
      const existing = await cc.salary.type.list() as Record<string, unknown>[];
      const sample = existing.length
        ? await cc.salary.type.read({ id: existing[0].id as number }) as Record<
          string,
          unknown
        >
        : undefined;
      if (!sample) {
        ctx.check("salary/type: an existing type to clone", false);
      } else {
        const suffix = t.slice(-4);
        const {
          id: _id,
          created: _c,
          createdBy: _cb,
          lastUpdated: _u,
          lastUpdatedBy: _ub,
          ...rest
        } = sample;
        const rename = (value: unknown) =>
          typeof value === "string" ? `${value}${suffix}` : value;
        const create = {
          ...rest,
          categoryId,
          name: `${t}-stype`,
          number: "9001",
          variableName: rename(rest.variableName),
          fields: Array.isArray(rest.fields)
            ? rest.fields.map((field) => {
              const { id: _fid, ...f } = field as Record<string, unknown>;
              return { ...f, variableName: rename(f.variableName) };
            })
            : rest.fields,
        };
        typeId = await crud(
          ctx,
          "salary/type",
          cc.salary.type as unknown as Crud,
          create,
          { name: `${t}-stype2` },
        );
        if (typeId !== undefined) {
          await ctx.step(
            "salary/type categorize",
            () =>
              cc.salary.type.categorize({ ids: typeId!, target: categoryId }),
          );
        }
      }
    }

    // Same undocumented-but-required `layoutId` as order/category.
    const salaryLayouts = await cc.salary.layout.list() as Record<
      string,
      unknown
    >[];
    const salaryLayoutId = salaryLayouts[0]?.id as number | undefined;
    const templateId = salaryLayoutId === undefined
      ? (ctx.check("salary/template: a layout to attach", false), undefined)
      : await crud(
        ctx,
        "salary/template",
        cc.salary.template as unknown as Crud,
        { name: `${t}-stpl`, layoutId: salaryLayoutId },
        { name: `${t}-stpl2` },
        // A template a statement has used can never be deleted again.
        (id) =>
          cc.salary.template.update({
            id,
            name: `${t}-stpl2`,
            layoutId: salaryLayoutId,
            isInactive: true,
          }),
      );

    // Salary statements are licensed per employee per period, so creating a
    // fresh person here burns quota that never comes back. Reuse an employee
    // the organisation already pays.
    const existingStatements = await cc.salary.statement.list() as Record<
      string,
      unknown
    >[];
    const personId = existingStatements[0]?.personId as number | undefined ??
      await createPayee(ctx);
    if (
      personId === undefined || statusId === undefined ||
      templateId === undefined
    ) {
      ctx.check(
        "salary: person, status and template available for a statement",
        false,
        `person=${personId} status=${statusId} template=${templateId}`,
      );
      return;
    }

    await ctx.step(
      "salary/statement calculate",
      () =>
        cc.salary.statement.calculate({
          personId,
          templateId,
          date: new Date(),
          datePayment: new Date(),
        }),
    );

    const statementId = await ctx.step(
      "salary/statement create",
      async () =>
        insertId(
          await cc.salary.statement.create({
            personId,
            statusId,
            templateId,
            date: new Date(),
            datePayment: new Date(),
            // No sequence number on our fresh template, so supply the number.
            nr: `${t}-s1`,
          }),
        ),
    );
    if (statementId === undefined) return;
    ctx.defer(
      `salary/statement ${statementId}`,
      () => cc.salary.statement.delete({ ids: statementId }),
    );

    await ctx.step("salary/statement update", () =>
      cc.salary.statement.update({
        id: statementId,
        personId,
        statusId,
        templateId,
        date: new Date(),
        datePayment: new Date(),
        nr: `${t}-s1`,
      }));

    await ctx.step(
      "salary/statement update_status",
      () => cc.salary.statement.updateStatus({ ids: statementId, statusId }),
    );
    await ctx.step(
      "salary/statement update_multiple",
      () =>
        cc.salary.statement.updateMultiple({
          ids: statementId,
          notes: `${t}-bulk`,
        }),
    );
    await ctx.step(
      "salary/statement update_recurrence",
      () =>
        cc.salary.statement.updateRecurrence({
          id: statementId,
          recurrence: "MONTHLY",
          startDate: new Date(),
        }),
    );
    await ctx.step(
      "salary/statement update_attachments",
      () =>
        cc.salary.statement.updateAttachments({
          id: statementId,
          fileIds: [],
        }),
    );

    await ctx.step(
      "salary/document update",
      () =>
        cc.salary.document.update({
          id: statementId,
          footer: `${t}-footer`,
        }),
    );

    // Unlike order/bookentry/create, this one answers "1 book entries
    // created" with no insertId, so the id has to be read back from the list.
    const booked = await ctx.step(
      "salary/bookentry create",
      () =>
        cc.salary.bookentry.create({
          statementIds: statementId,
          debitId: wages,
          creditId: bank,
          // Documented as optional, rejected when empty.
          date: new Date(),
        }),
    );
    const bookEntries = booked === undefined ? undefined : await ctx.step(
      "salary/bookentry list",
      () => cc.salary.bookentry.list({ id: statementId }),
    ) as Record<string, unknown>[] | undefined;
    const bookEntryId = bookEntries?.[0]?.id as number | undefined;
    ctx.check(
      "salary/bookentry create produced an entry",
      bookEntryId !== undefined,
    );
    if (bookEntryId !== undefined) {
      await ctx.step(
        "salary/bookentry update",
        () =>
          cc.salary.bookentry.update({
            id: bookEntryId,
            debitId: wages,
            creditId: bank,
            date: new Date(),
          }),
      );
      await ctx.step(
        "salary/bookentry delete",
        () => cc.salary.bookentry.delete({ ids: bookEntryId }),
      );
    }

    await ctx.step("salary/payment create", () =>
      cc.salary.payment.create({
        date: new Date(),
        statementIds: statementId,
        type: "CASH_PDF",
      }));

    // Certificates are generated per employee and fiscal year rather than
    // created, so take whichever one the organisation already has.
    const certificates = await cc.salary.certificate.list() as
      | Record<string, unknown>[]
      | undefined;
    const certificateId = certificates?.[0]?.id as number | undefined;
    if (certificateId === undefined) {
      ctx.check(
        "salary/certificate: one exists to update",
        false,
        "none in this organisation",
      );
    } else {
      await ctx.step(
        "salary/certificate update",
        () =>
          cc.salary.certificate.update({
            id: certificateId,
            notes: `${t}-cert`,
          }),
      );
    }

    const mailTo = ctx.flag("mail");
    if (mailTo) {
      await ctx.step("salary/document mail", () =>
        cc.salary.document.mail({
          statementIds: statementId,
          mailFrom: mailTo,
          // Documented as optional on all three mail endpoints, rejected
          // when empty.
          mailTo,
          mailSubject: `${t} write-suite test`,
          mailText: "Sent by the CashCtrl SDK write suite.",
        }));
      if (certificateId !== undefined) {
        await ctx.step(
          "salary/certificate/document mail",
          () =>
            cc.salary.certificate.document.mail({
              certificateIds: certificateId,
              mailFrom: mailTo,
              mailTo,
              mailSubject: `${t} write-suite test`,
              mailText: "Sent by the CashCtrl SDK write suite.",
            }),
        );
      }
    } else {
      console.log("    skip salary mail endpoints (pass --mail=<address>)");
    }
  },
};

/** Organisation settings: a real round-trip, then put it back. */
const settings: Suite = {
  name: "settings",
  async run(ctx) {
    const cc = ctx.cc;

    // setting/read.json answers with a flat object rather than the
    // `{ data: ... }` envelope every other read uses. The generator now
    // follows the probe evidence for that one endpoint instead of the verb
    // convention, so this returns the settings rather than undefined.
    const before = await ctx.step("setting read", () => cc.setting.read()) as
      | Record<string, unknown>
      | undefined;
    if (
      !ctx.check(
        "setting read returned settings",
        before !== undefined && Object.keys(before).length > 0,
        `${Object.keys(before ?? {}).length} keys`,
      )
    ) return;

    // The reference documents no parameters for setting/update, but it takes
    // the keys read returns. THOUSAND_SEPARATOR is the most harmless one:
    // display-only, and restored below.
    const original = before!.THOUSAND_SEPARATOR;
    if (typeof original !== "string") {
      ctx.check("settings: THOUSAND_SEPARATOR to round-trip", false);
      return;
    }
    const swapped = original === "." ? "'" : ".";
    ctx.defer(
      "restore THOUSAND_SEPARATOR",
      () => cc.setting.update({ THOUSAND_SEPARATOR: original }),
    );

    await ctx.step(
      "setting update",
      () => cc.setting.update({ THOUSAND_SEPARATOR: swapped }),
    );
    const after = await ctx.step(
      "setting read back",
      () => cc.setting.read(),
    ) as Record<string, unknown> | undefined;
    ctx.check(
      "setting update changed the value",
      after?.THOUSAND_SEPARATOR === swapped,
      `${original} -> ${after?.THOUSAND_SEPARATOR}`,
    );
  },
};

/**
 * Year-end, run against a fiscal period this suite creates and deletes again,
 * so completing and reopening a period never touches the year anybody is
 * still booking into.
 *
 * `switch` changes the current period for the whole organisation, so the
 * original is restored before the suite returns, including when it throws.
 */
const yearend: Suite = {
  name: "yearend",
  // Opt-in: completing a fiscal period makes it undeletable for good, so
  // every run of this suite leaves one behind. Fine deliberately, wasteful
  // by default.
  optIn: true,
  async run(ctx) {
    const cc = ctx.cc;
    const t = ctx.tag;
    const original = ctx.world.originalFiscalPeriodId;

    const periodId = await ctx.step(
      // A custom period for a fixed year collides as soon as the
      // organisation already has that year ("The salary period cannot
      // overlap any existing period"). `EARLIEST` creates the year before
      // the earliest existing one: always free, always old, and never the
      // year anybody is still booking into.
      "fiscalperiod create (year before the earliest)",
      async () => {
        // Answers "Fiscal period 2018 created" with no insertId, so identify
        // it by being the one that now starts earliest.
        await cc.fiscalperiod.create({ type: "EARLIEST" });
        const periods = await cc.fiscalperiod.list() as Record<
          string,
          unknown
        >[];
        const earliest = periods.reduce((a, b) =>
          String(a.start ?? "") <= String(b.start ?? "") ? a : b
        );
        return earliest.id as number;
      },
    );
    if (periodId === undefined) return;

    // Restore first, delete second: the period cannot be deleted while it is
    // the current one. Booking exchange differences puts real entries into
    // the period, and a period with book entries cannot be deleted either,
    // so those come out first.
    ctx.defer(
      `fiscalperiod ${periodId}`,
      async () => {
        const entries = await cc.journal.list({
          fiscalPeriodId: periodId,
        }) as Record<string, unknown>[];
        const ids = entries.map((e) => e.id as number).filter(Number.isFinite);
        if (ids.length) await cc.journal.delete({ ids });
        await cc.fiscalperiod.delete({ ids: periodId });
      },
      // Completing a period makes it undeletable for good - reopening does
      // not undo that - so the best that can be done is to name it clearly.
      async () => {
        const stuck = await cc.fiscalperiod.read({
          id: String(periodId),
        }) as Record<string, unknown>;
        const at = (v: unknown) => String(v ?? "").slice(0, 10);
        await cc.fiscalperiod.update({
          id: periodId,
          name: `${t}-DELETE-ME`,
          start: at(stuck.start),
          end: at(stuck.end),
          salaryStart: at(stuck.salaryStart),
          salaryEnd: at(stuck.salaryEnd),
        });
      },
    );
    ctx.defer(
      `switch back to fiscal period ${original}`,
      () => cc.fiscalperiod.switch({ id: original }),
    );

    // fiscalperiod/read documents `id` as TEXT, so it takes a string here.
    const period = await cc.fiscalperiod.read({
      id: String(periodId),
    }) as Record<string, unknown>;
    const day = (value: unknown) => String(value ?? "").slice(0, 10);
    const year = day(period.start).slice(0, 4);

    // `id` is the only documented required parameter, but update rejects the
    // four date fields when they are empty, so they have to be sent back.
    await ctx.step(
      "fiscalperiod update",
      () =>
        cc.fiscalperiod.update({
          id: periodId,
          name: `${t}-${year}`,
          start: day(period.start),
          end: day(period.end),
          salaryStart: day(period.salaryStart),
          salaryEnd: day(period.salaryEnd),
        }),
    );

    await ctx.step(
      "fiscalperiod switch",
      () => cc.fiscalperiod.switch({ id: periodId }),
    );

    // Nothing is depreciable in a year that has just been created, so give
    // the period a fixed asset to depreciate before asking what to book.
    const assetId = await ctx.step(
      "inventory/asset create (depreciable, in this period)",
      async () =>
        insertId(
          await cc.inventory.asset.create({
            name: `${t}-deprasset`,
            nr: `${t}-d1`,
            accountId: ctx.world.accountLike("15"),
            purchaseCreditId: ctx.world.accountLike("10"),
            purchasePrice: 10000,
            dateAdded: day(period.start),
            deprType: "LINEAR",
            deprDuration: 5,
            deprAccountId: ctx.world.accountLike("6"),
          }),
        ),
    );
    if (assetId !== undefined) {
      ctx.defer(
        `inventory/asset ${assetId}`,
        () => cc.inventory.asset.delete({ ids: assetId }),
        // Booking a depreciation makes the asset undeletable, so name it for
        // whoever tidies the organisation later.
        () =>
          cc.inventory.asset.update({
            id: assetId,
            name: `${t}-deprasset (undeletable)`,
            accountId: ctx.world.accountLike("15"),
            dateAdded: day(period.start),
            purchasePrice: 10000,
            // Update insists on these two just as create does.
            nr: `${t}-d1`,
            purchaseCreditId: ctx.world.accountLike("10"),
          }),
      );
    }

    // Both booking endpoints need to know what there is to book, and the
    // matching GET is the documented way to find out.
    const depreciable = await ctx.step(
      "fiscalperiod depreciations list",
      () => cc.fiscalperiod.depreciations({ id: periodId }),
    ) as Record<string, unknown>[] | undefined;
    const depreciationIds = (depreciable ?? [])
      .map((d) => (d.accountId ?? d.id) as number)
      .filter(Number.isFinite);
    if (depreciationIds.length) {
      await ctx.step(
        "fiscalperiod bookdepreciations",
        () =>
          cc.fiscalperiod.bookdepreciations({
            id: periodId,
            depreciation: depreciationIds,
          }),
      );
    } else {
      console.log("    skip bookdepreciations (nothing depreciable found)");
    }

    const diffs = await ctx.step(
      "fiscalperiod exchangediff list",
      () => cc.fiscalperiod.exchangediff({ id: periodId }),
    ) as Record<string, unknown>[] | undefined;
    const exchangeDiff = (diffs ?? [])
      .filter((d) => Number.isFinite(d.accountId))
      .map((d) => ({
        accountId: d.accountId as number,
        currencyRate: Number(d.currencyRate ?? 1),
      }));
    if (exchangeDiff.length) {
      await ctx.step(
        "fiscalperiod bookexchangediff",
        () => cc.fiscalperiod.bookexchangediff({ id: periodId, exchangeDiff }),
      );
    } else {
      console.log("    skip bookexchangediff (no foreign currency accounts)");
    }

    // Month identifiers are "YYYY-MM" inside the period being completed.
    await ctx.step(
      "fiscalperiod complete_months",
      () =>
        cc.fiscalperiod.completeMonths({
          id: periodId,
          months: [`${year}-01`, `${year}-02`],
        }),
    );
    await ctx.step(
      "fiscalperiod complete",
      () => cc.fiscalperiod.complete({ id: periodId }),
    );
    await ctx.step(
      "fiscalperiod reopen",
      () => cc.fiscalperiod.reopen({ id: periodId }),
    );
  },
};

export const suites: Suite[] = [
  masterdata,
  accounts,
  files,
  persons,
  inventory,
  journal,
  orders,
  bankimport,
  salary,
  settings,
  yearend,
];
