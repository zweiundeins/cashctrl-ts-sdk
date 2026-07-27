import {
  CashCtrlAuthError,
  CashCtrlHttpError,
  CashCtrlRateLimitError,
  CashCtrlValidationError,
  type FieldError,
} from "./errors.ts";

/** Languages the API accepts for error messages and generated documents. */
export type CashCtrlLang = "de" | "fr" | "it" | "en";

export interface CashCtrlOptions {
  /**
   * Your CashCtrl subdomain. For `https://myorg.cashctrl.com` this is `myorg`.
   * Ignored when `baseUrl` is set.
   */
  organisation?: string;
  /** API key, created under Settings > Users & Roles > Add API user. */
  apiKey: string;
  /** Language for error messages and generated PDFs/CSVs. */
  lang?: CashCtrlLang;
  /** Full base URL override, e.g. for a mock server. No trailing slash. */
  baseUrl?: string;
  /** Injectable fetch, for tests or custom agents. */
  fetch?: typeof globalThis.fetch;
  /** Retries on 429 and 5xx. Set `attempts: 0` to disable. */
  retry?: { attempts?: number; baseDelayMs?: number };
  /** Forwarded to each request, e.g. for timeouts via AbortSignal. */
  signal?: AbortSignal;
}

/**
 * Values {@link serializeParam} knows how to encode. Documentation only: the
 * transport accepts any record, because the generated param types already
 * constrain each field and are richer than this union can express.
 */
export type ParamValue =
  | string
  | number
  | boolean
  | Date
  | null
  | undefined
  | Blob
  | readonly (string | number)[]
  | Record<string, unknown>
  | readonly Record<string, unknown>[];

export type Params = Record<string, unknown>;

/** The `{ data, total }` envelope returned by list/read endpoints. */
export interface ListEnvelope<T> {
  data: T[];
  total?: number;
}

/** The envelope returned by create/update/delete endpoints. */
export interface WriteEnvelope {
  success: boolean;
  message?: string;
  insertId?: number;
  errors?: FieldError[];
}

/** `YYYY-MM-DD`, the format every DATE parameter expects. */
export function formatDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Serializes one parameter to the string form CashCtrl expects.
 *
 * The API is form-encoded even though it returns JSON, so structured values
 * have to be flattened: JSON params become JSON *strings*, CSV params become
 * comma-joined strings, booleans become `"true"`/`"false"`.
 *
 * Returns `undefined` for values that should be omitted entirely.
 */
export function serializeParam(value: unknown): string | Blob | undefined {
  if (value === undefined) return undefined;
  // Update endpoints treat omitted params as empty, so an explicit null is
  // the caller saying "clear this field" and must be sent as an empty string.
  if (value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) return formatDate(value);
  if (typeof Blob !== "undefined" && value instanceof Blob) return value;
  if (Array.isArray(value)) {
    // A CSV param is a list of scalars; a JSON param is a list of objects.
    return value.every((v) => typeof v === "string" || typeof v === "number")
      ? value.join(",")
      : JSON.stringify(value);
  }
  return JSON.stringify(value);
}

function encodeBasicAuth(apiKey: string): string {
  const raw = `${apiKey}:`;
  if (typeof btoa === "function") {
    // btoa is latin1-only; API keys are ASCII but encode defensively.
    return btoa(String.fromCharCode(...new TextEncoder().encode(raw)));
  }
  // deno-lint-ignore no-explicit-any
  return (globalThis as any).Buffer.from(raw, "utf-8").toString("base64");
}

function isRetryable(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Low-level HTTP transport for the CashCtrl API.
 *
 * Handles auth, form encoding, the `success: false` envelope, and retries.
 * The generated resource classes sit on top of this; you can also use it
 * directly for endpoints the generator does not cover.
 */
export class CashCtrlHttp {
  readonly baseUrl: string;
  readonly lang?: CashCtrlLang;
  #auth: string;
  #fetch: typeof globalThis.fetch;
  #attempts: number;
  #baseDelayMs: number;
  #signal?: AbortSignal;

  constructor(options: CashCtrlOptions) {
    if (!options.apiKey) {
      throw new TypeError("CashCtrl: `apiKey` is required");
    }
    if (!options.baseUrl && !options.organisation) {
      throw new TypeError(
        "CashCtrl: either `organisation` or `baseUrl` is required",
      );
    }
    this.baseUrl = (options.baseUrl ??
      `https://${options.organisation}.cashctrl.com`).replace(/\/+$/, "");
    this.lang = options.lang;
    this.#auth = `Basic ${encodeBasicAuth(options.apiKey)}`;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#attempts = options.retry?.attempts ?? 3;
    this.#baseDelayMs = options.retry?.baseDelayMs ?? 500;
    this.#signal = options.signal;
  }

  /** Issues a request and returns the raw `Response` (for PDF/CSV downloads). */
  async raw(
    method: "GET" | "POST",
    path: string,
    params: Params = {},
    signal?: AbortSignal,
  ): Promise<Response> {
    const url = new URL(
      path.startsWith("/") ? path : `/api/v1/${path}`,
      this.baseUrl,
    );
    const init: RequestInit = {
      method,
      headers: { Authorization: this.#auth, Accept: "application/json" },
      signal: signal ?? this.#signal,
    };

    const entries: [string, string | Blob][] = [];
    for (const [key, value] of Object.entries(params)) {
      const serialized = serializeParam(value);
      if (serialized !== undefined) entries.push([key, serialized]);
    }
    if (this.lang && !("lang" in params)) entries.push(["lang", this.lang]);

    if (method === "GET") {
      for (const [k, v] of entries) {
        if (typeof v === "string") url.searchParams.append(k, v);
      }
    } else if (entries.length) {
      // Multipart only when a file is present; urlencoded is cheaper otherwise.
      if (entries.some(([, v]) => typeof v !== "string")) {
        const form = new FormData();
        for (const [k, v] of entries) form.append(k, v as string | Blob);
        init.body = form;
      } else {
        const form = new URLSearchParams();
        for (const [k, v] of entries) form.append(k, v as string);
        init.body = form;
      }
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.#attempts; attempt++) {
      let response: Response;
      try {
        response = await this.#fetch(url, init);
      } catch (err) {
        // Network failure: retry unless the caller aborted.
        if ((err as Error)?.name === "AbortError") throw err;
        lastError = err;
        if (attempt === this.#attempts) throw err;
        await sleep(this.#baseDelayMs * 2 ** attempt);
        continue;
      }

      if (response.ok) return response;

      if (isRetryable(response.status) && attempt < this.#attempts) {
        const retryAfter = Number(response.headers.get("Retry-After"));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : this.#baseDelayMs * 2 ** attempt;
        await response.body?.cancel();
        await sleep(delay);
        continue;
      }

      const body = await response.text();
      const relative = url.pathname;
      if (response.status === 401 || response.status === 403) {
        throw new CashCtrlAuthError(response.status, relative, body);
      }
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("Retry-After"));
        throw new CashCtrlRateLimitError(
          429,
          relative,
          body,
          Number.isFinite(retryAfter) ? retryAfter : undefined,
        );
      }
      throw new CashCtrlHttpError(response.status, relative, body);
    }
    throw lastError;
  }

  /**
   * Issues a request and parses the JSON body, promoting `success: false`
   * into a thrown {@link CashCtrlValidationError}.
   */
  async request<T>(
    method: "GET" | "POST",
    path: string,
    params: Params = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.raw(method, path, params, signal);
    const text = await response.text();
    if (!text) return undefined as T;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new CashCtrlHttpError(response.status, path, text);
    }

    if (parsed && typeof parsed === "object" && "success" in parsed) {
      const envelope = parsed as WriteEnvelope;
      if (envelope.success === false) {
        throw new CashCtrlValidationError(
          path,
          normalizeErrors(envelope.errors),
          envelope.message,
        );
      }
    }
    return parsed as T;
  }

  get<T>(path: string, params?: Params, signal?: AbortSignal): Promise<T> {
    return this.request<T>("GET", path, params, signal);
  }

  post<T>(path: string, params?: Params, signal?: AbortSignal): Promise<T> {
    return this.request<T>("POST", path, params, signal);
  }

  /** GET a list endpoint and unwrap the `data` array. */
  async list<T>(
    path: string,
    params?: Params,
    signal?: AbortSignal,
  ): Promise<T[]> {
    const body = await this.get<ListEnvelope<T> | T[]>(path, params, signal);
    if (Array.isArray(body)) return body;
    return body?.data ?? [];
  }

  /** GET a list endpoint and keep the `total` alongside the rows. */
  async listWithTotal<T>(
    path: string,
    params?: Params,
    signal?: AbortSignal,
  ): Promise<{ data: T[]; total: number }> {
    const body = await this.get<ListEnvelope<T> | T[]>(path, params, signal);
    const data = Array.isArray(body) ? body : body?.data ?? [];
    const total = Array.isArray(body)
      ? body.length
      : body?.total ?? data.length;
    return { data, total };
  }
}

/**
 * CashCtrl documents `errors` as `[{field, message}]`, but some endpoints
 * return a `{field: [messages]}` map instead. Normalize both.
 */
function normalizeErrors(errors: WriteEnvelope["errors"]): FieldError[] {
  if (!errors) return [];
  if (Array.isArray(errors)) return errors;
  return Object.entries(errors as Record<string, string[] | string>)
    .flatMap(([field, messages]) =>
      (Array.isArray(messages) ? messages : [messages])
        .map((message) => ({ field, message }))
    );
}
