/**
 * Exercises EVERY generated endpoint against a mock transport.
 *
 * Live probing can only cover read endpoints on one organisation, which left
 * roughly 75% of the surface with no runtime evidence at all. This closes the
 * gap for the half of the problem that does not need a server: given a call
 * like `client.account.category.list(...)`, does the SDK actually issue the
 * documented request?
 *
 * For all 376 endpoints it asserts:
 *   - the method exists at the resource path implied by the URL
 *   - the HTTP verb matches the docs
 *   - the URL path matches exactly
 *   - every documented parameter is transmitted
 *   - GET params land in the query string, POST params in the body
 *   - values are encoded the way CashCtrl expects
 *
 * What this cannot tell you: whether CashCtrl accepts the request. That needs
 * a real organisation, and for writes, a disposable one. See README "Testing".
 */

import { assertEquals } from "@std/assert";
import { CashCtrl } from "../src/client.ts";
import type { Endpoint, Param, Spec } from "../scripts/ir.ts";
import { methodName, propertyName, splitPath } from "../scripts/naming.ts";

const spec: Spec = JSON.parse(
  await Deno.readTextFile(new URL("../spec/api.json", import.meta.url)),
);

/**
 * A value satisfying `param`, chosen to exercise the interesting serialization
 * path rather than the trivial one.
 *
 * DATE uses a real `Date` and CSV a real array on purpose: passing a
 * pre-formatted string would take the passthrough branch and leave the actual
 * date-formatting and comma-joining logic untested.
 */
function sampleValue(param: Param): unknown {
  if (param.enum?.length && param.type !== "BOOLEAN") return param.enum[0];
  switch (param.type) {
    case "NUMBER":
      return 1;
    case "BOOLEAN":
      return true;
    case "DATE":
      return new Date(2026, 0, 15);
    case "CSV":
      return [1, 2, 3];
    case "JSON": {
      if (!param.fields?.length) return {};
      const object: Record<string, unknown> = {};
      for (const field of param.fields.filter((f) => f.required)) {
        object[field.name] = sampleValue(field);
      }
      return param.isArray ? [object] : object;
    }
    default:
      return "x";
  }
}

/**
 * The string CashCtrl should receive for `value`.
 *
 * Deliberately written independently of `serializeParam`, spelling out the
 * expected wire format by hand. Reusing the SDK's own serializer here would
 * make the assertion tautological: any encoding bug would be mirrored in the
 * expectation and the test would stay green.
 */
function expectedEncoding(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  // The fixed sample date, in CashCtrl's YYYY-MM-DD format.
  if (value instanceof Date) return "2026-01-15";
  // CSV params are comma-joined scalars; JSON params are serialized objects.
  if (Array.isArray(value) && value.every((v) => typeof v === "number")) {
    return value.join(",");
  }
  return JSON.stringify(value);
}

/**
 * Every documented param, not just the mandatory ones.
 *
 * Restricting this to mandatory params would leave whole encoding paths
 * untested: no endpoint has a mandatory BOOLEAN, HTML or XML param, so a
 * regression in boolean encoding (410 optional params) would go unnoticed.
 */
function buildParams(endpoint: Endpoint): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const param of endpoint.params) {
    params[param.name] = sampleValue(param);
  }
  return params;
}

/** Walks `client.a.b.c` and returns the bound method for an endpoint. */
function resolveMethod(
  client: CashCtrl,
  endpoint: Endpoint,
): { fn: (...args: unknown[]) => Promise<unknown>; label: string } | null {
  const { resource, verb } = splitPath(endpoint.path);
  // deno-lint-ignore no-explicit-any
  let node: any = client;
  const trail: string[] = [];
  for (const segment of resource) {
    const prop = propertyName(segment);
    trail.push(prop);
    node = node?.[prop];
    if (!node) return null;
  }
  const name = methodName(verb);
  const fn = node?.[name];
  if (typeof fn !== "function") return null;
  return { fn: fn.bind(node), label: `${trail.join(".")}.${name}` };
}

Deno.test("standard CRUD verbs get their idiomatic method names", () => {
  // Deliberately hardcoded, NOT derived from methodName(). The endpoint-walk
  // test below resolves methods with that same function, so it happily passed
  // while every delete endpoint was generated as `delete_` -- a bug only found
  // when a live round-trip called `.delete()` and silently deleted nothing.
  // Asserting the expected names by hand is what makes this independent.
  const expected: Record<string, string> = {
    "/api/v1/tax/list.json": "list",
    "/api/v1/tax/read.json": "read",
    "/api/v1/tax/create.json": "create",
    "/api/v1/tax/update.json": "update",
    "/api/v1/tax/delete.json": "delete",
    "/api/v1/account/category/tree.json": "tree",
    "/api/v1/account/list.csv": "listCsv",
    "/api/v1/account/update_attachments.json": "updateAttachments",
  };

  const client = new CashCtrl({ organisation: "o", apiKey: "k" });
  for (const [path, name] of Object.entries(expected)) {
    const { resource } = splitPath(path);
    // deno-lint-ignore no-explicit-any
    let node: any = client;
    for (const segment of resource) node = node?.[propertyName(segment)];
    assertEquals(
      typeof node?.[name],
      "function",
      `${path} should be callable as .${name}()`,
    );
  }
});

Deno.test("every documented endpoint is reachable and issues the right request", async (t) => {
  const failures: string[] = [];
  let checked = 0;

  for (const endpoint of spec.endpoints) {
    let captured: { url: URL; init: RequestInit } | null = null;

    const client = new CashCtrl({
      organisation: "testorg",
      apiKey: "secret",
      retry: { attempts: 0 },
      fetch: (input, init = {}) => {
        const url = input instanceof URL ? input : new URL(String(input));
        captured = { url, init: init as RequestInit };
        // Shape-agnostic success: the assertions are about the request.
        return Promise.resolve(
          new Response(JSON.stringify({ success: true, data: [] }), {
            headers: { "content-type": "application/json" },
          }),
        );
      },
    });

    const resolved = resolveMethod(client, endpoint);
    if (!resolved) {
      failures.push(`${endpoint.path}: no generated method`);
      continue;
    }

    const params = buildParams(endpoint);
    try {
      await resolved.fn(params);
    } catch (err) {
      failures.push(`${resolved.label}: threw ${(err as Error).message}`);
      continue;
    }

    if (!captured) {
      failures.push(`${resolved.label}: issued no request`);
      continue;
    }
    const { url, init } = captured as { url: URL; init: RequestInit };

    if (init.method !== endpoint.method) {
      failures.push(
        `${resolved.label}: method ${init.method}, expected ${endpoint.method}`,
      );
    }
    if (url.pathname !== endpoint.path) {
      failures.push(
        `${resolved.label}: path ${url.pathname}, expected ${endpoint.path}`,
      );
    }

    // Every mandatory param must actually reach the wire, correctly encoded.
    const body = init.body;
    const sent = new Map<string, string>();
    if (endpoint.method === "GET") {
      for (const [k, v] of url.searchParams) sent.set(k, v);
    } else if (body instanceof URLSearchParams) {
      for (const [k, v] of body) sent.set(k, v);
    } else if (body instanceof FormData) {
      for (const [k, v] of body) if (typeof v === "string") sent.set(k, v);
    }

    for (const [name, value] of Object.entries(params)) {
      if (!sent.has(name)) {
        failures.push(`${resolved.label}: param '${name}' not sent`);
        continue;
      }
      const expected = expectedEncoding(value);
      if (sent.get(name) !== expected) {
        failures.push(
          `${resolved.label}: '${name}' encoded as ${sent.get(name)}, ` +
            `expected ${expected}`,
        );
      }
    }
    checked++;
  }

  await t.step(`${checked}/${spec.endpoints.length} endpoints verified`, () => {
    assertEquals(
      failures,
      [],
      `${failures.length} endpoint contract failures:\n` +
        failures.slice(0, 40).join("\n"),
    );
  });
});
