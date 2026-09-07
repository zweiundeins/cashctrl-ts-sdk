/**
 * A stand-in CashCtrl server, used by `--dry-run`.
 *
 * It exists to answer one question offline: does the write suite actually
 * reach every POST endpoint, or does a chain break early and silently skip
 * the ten endpoints downstream of it? The coverage report is only trustworthy
 * if the suites can run to completion, and against a real organisation a
 * failure and a gap look the same in the numbers.
 *
 * So this returns the minimum plausible response for each shape - an
 * `insertId` for every write, records with the ids the suites read back - and
 * nothing more. It is not a CashCtrl emulator and proves nothing about the
 * API. Only `--org=...` against a live organisation does that.
 */

let nextId = 1000;

const ACCOUNTS = [
  "1000",
  "1020",
  "1100",
  "1500",
  "2000",
  "3000",
  "4000",
  "5000",
  "6000",
].map((number, i) => ({
  id: 100 + i,
  number,
  name: `Account ${number}`,
  categoryId: 1,
}));

function tryParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Bodies for the GET endpoints the suites read ids out of. */
function readGet(path: string, params: URLSearchParams): unknown {
  switch (path) {
    case "/api/v1/account/list.json":
      return { data: ACCOUNTS };
    case "/api/v1/currency/list.json":
      return { data: [{ id: 1, code: "CHF", isDefault: true }] };
    case "/api/v1/tax/list.json":
      return {
        data: [{
          id: 1,
          code: "VAT81",
          components: "[]",
          rates: '[{"percentage":8.1}]',
        }],
      };
    case "/api/v1/order/category/list.json":
      return { data: [{ id: 1, accountId: 102, nameSingular: "Invoice" }] };
    case "/api/v1/order/category/read.json": {
      const record: Record<string, unknown> = {};
      for (const [key, value] of params) record[key] = value;
      // Statuses last: the create form carries `status` as a JSON string, and
      // the suite needs the server-assigned ids back, not what it sent.
      record.status = [{ id: 11, name: "Draft" }, { id: 12, name: "Paid" }];
      record.id = Number(params.get("id"));
      return { data: record };
    }
    case "/api/v1/fiscalperiod/list.json":
      // Two entries so the year-end suite can pick out the one it just made.
      return {
        data: [
          { id: 1, name: "2026", start: "2026-01-01", isCurrent: true },
          { id: 2, name: "2018", start: "2018-01-01", isCurrent: false },
        ],
      };
    case "/api/v1/fiscalperiod/depreciations.json":
      return { data: [{ accountId: 103, amount: 100 }] };
    case "/api/v1/fiscalperiod/exchangediff.json":
      return { data: [{ accountId: 101, currencyRate: 0.93 }] };
    case "/api/v1/journal/import/entry/list.json":
      return { data: [{ id: 7001, amount: 19.9 }] };
    case "/api/v1/salary/certificate/list.json":
      return { data: [{ id: 8001 }] };
    case "/api/v1/order/read.json":
      return {
        data: { id: Number(params.get("id")), total: 200, groupId: 9001 },
      };
    case "/api/v1/journal/read.json":
      return { data: { id: Number(params.get("id")), amount: 12.34 } };
    case "/api/v1/journal/list.json":
      return { data: [] };
    case "/api/v1/setting/read.json": {
      // Not enveloped, because the real endpoint is not either. Echoes the
      // last update so the settings suite can read its own write back.
      const written = lastCreate.get("/api/v1/setting/update.json");
      return { THOUSAND_SEPARATOR: written?.get("THOUSAND_SEPARATOR") ?? "'" };
    }
    case "/api/v1/account/category/tree.json":
      return { data: [{ id: 1, parentId: null, name: "Assets" }] };
    case "/api/v1/salary/layout/list.json":
      return { data: [{ id: 20, name: "Print, General" }] };
    case "/api/v1/salary/type/list.json":
      return { data: [{ id: 1, number: "1000" }] };
    case "/api/v1/salary/type/read.json": {
      // The suite reads this twice: once to clone a sample, then again to
      // check its own create round-tripped, so echo the request over the
      // sample rather than returning a fixed record.
      const record: Record<string, unknown> = {
        categoryId: 1,
        name: "Monthly salary",
        number: "1000",
        type: "ADDITION",
        calculation: "$mSalaryBase",
        variableName: "$mSalary",
        fields: [{ id: 2, variableName: "$mSalaryBase", dataType: "NUMBER" }],
        sums: [{ id: 1, sumId: 1 }],
      };
      for (const [key, value] of params) record[key] = value;
      record.id = Number(params.get("id"));
      return { data: record };
    }
    case "/api/v1/salary/statement/list.json":
      return { data: [{ id: 9001, personId: 5001 }] };
    case "/api/v1/salary/bookentry/list.json":
      return { data: [{ id: 9101 }] };
    case "/api/v1/fiscalperiod/read.json":
      return {
        data: {
          id: Number(params.get("id")),
          start: "2018-01-01 00:00:00.0",
          end: "2018-12-31 23:59:59.0",
          salaryStart: "2018-01-01 00:00:00.0",
          salaryEnd: "2018-12-31 23:59:59.0",
        },
      };
  }

  if (path.endsWith("/read.json")) {
    // Echo the request back, so `crud`'s read-back assertions can pass. JSON
    // params go out as encoded strings and come back parsed, the way the real
    // API returns them - otherwise a suite that reads a structured field back
    // sees a string and fails for a reason the server never would.
    const record: Record<string, unknown> = { id: Number(params.get("id")) };
    for (const [key, value] of params) {
      if (key === "id") continue;
      record[key] = /^[[{]/.test(value) ? tryParse(value) : value;
    }
    return { data: record };
  }
  return { data: [] };
}

/** POST bodies. `file/prepare` is the only one with a shape that matters. */
function writeResponse(path: string): unknown {
  if (path === "/api/v1/file/prepare.json") {
    return {
      success: true,
      data: [{
        fileId: nextId++,
        writeUrl: "https://storage.example.invalid/upload",
      }],
    };
  }
  return { success: true, insertId: nextId++, message: "ok" };
}

/**
 * `crud` reads back what it created, but a stub has no storage. Remembering
 * the last create per path is enough for the read-back to echo it.
 */
const lastCreate = new Map<string, URLSearchParams>();

export function stubFetch(): typeof globalThis.fetch {
  // deno-lint-ignore require-await
  return async (input, init) => {
    const href = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;
    const url = new URL(href);
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.hostname === "storage.example.invalid") {
      return new Response(null, { status: 200 });
    }

    if (method === "POST") {
      // The client sends URLSearchParams, or FormData when a Blob is in play.
      const body = init?.body;
      const form = body instanceof URLSearchParams
        ? body
        : new URLSearchParams(typeof body === "string" ? body : "");
      if (
        url.pathname.endsWith("/create.json") ||
        url.pathname === "/api/v1/setting/update.json"
      ) {
        lastCreate.set(url.pathname, form);
      }
      return json(writeResponse(url.pathname));
    }

    const created = lastCreate.get(
      url.pathname.replace("/read.json", "/create.json"),
    );
    const params = new URLSearchParams(url.search);
    if (created) {
      for (const [k, v] of created) if (!params.has(k)) params.set(k, v);
    }
    return json(readGet(url.pathname, params));
  };
}
