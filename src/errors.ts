/**
 * Error types for the CashCtrl SDK.
 *
 * Note that these deliberately avoid TypeScript parameter properties
 * (`constructor(readonly x: number)`). Parameter properties emit code rather
 * than only erasing types, so they break runtimes that strip types without
 * transpiling, such as `node --experimental-strip-types`. Fields are declared
 * and assigned explicitly to keep the source erasable-only.
 */

/** Field-level validation error as returned by CashCtrl write endpoints. */
export interface FieldError {
  field: string | null;
  message: string;
}

/** Base class for every error thrown by this SDK. */
export class CashCtrlError extends Error {
  override readonly name: string = "CashCtrlError";
}

/**
 * A non-2xx HTTP response.
 *
 * Note that CashCtrl returns 200 for *validation* failures, so this is
 * reserved for transport/auth/routing problems (401, 403, 404, 429, 5xx).
 */
export class CashCtrlHttpError extends CashCtrlError {
  override readonly name: string = "CashCtrlHttpError";
  readonly status: number;
  readonly path: string;
  readonly body: string;

  constructor(status: number, path: string, body: string) {
    super(`CashCtrl ${status} on ${path}: ${body.slice(0, 500)}`);
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

/**
 * A 200 response carrying `success: false`.
 *
 * CashCtrl reports form validation failures this way rather than with a 4xx,
 * so the SDK promotes them to a thrown error.
 */
export class CashCtrlValidationError extends CashCtrlError {
  override readonly name: string = "CashCtrlValidationError";
  readonly path: string;
  readonly errors: FieldError[];
  /** The top-level `message`, when CashCtrl sends one. */
  readonly detail?: string;

  constructor(path: string, errors: FieldError[], detail?: string) {
    const summary = errors.length
      ? errors.map((e) => `${e.field ?? "_"}: ${e.message}`).join("; ")
      : detail ?? "request was not successful";
    super(`CashCtrl validation failed on ${path}: ${summary}`);
    this.path = path;
    this.errors = errors;
    this.detail = detail;
  }

  /** Errors grouped by field name, for form binding. */
  byField(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const e of this.errors) {
      const key = e.field ?? "_";
      (out[key] ??= []).push(e.message);
    }
    return out;
  }
}

/** The API key was rejected or lacks permission for the endpoint. */
export class CashCtrlAuthError extends CashCtrlHttpError {
  override readonly name = "CashCtrlAuthError";
}

/** HTTP 429. `retryAfter` is in seconds when the server sent the header. */
export class CashCtrlRateLimitError extends CashCtrlHttpError {
  override readonly name = "CashCtrlRateLimitError";
  readonly retryAfter?: number;

  constructor(
    status: number,
    path: string,
    body: string,
    retryAfter?: number,
  ) {
    super(status, path, body);
    this.retryAfter = retryAfter;
  }
}
