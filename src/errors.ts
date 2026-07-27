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
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    super(`CashCtrl ${status} on ${path}: ${body.slice(0, 500)}`);
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
  constructor(
    readonly path: string,
    readonly errors: FieldError[],
    /** The top-level `message`, when CashCtrl sends one. */
    readonly detail?: string,
  ) {
    const summary = errors.length
      ? errors.map((e) => `${e.field ?? "_"}: ${e.message}`).join("; ")
      : detail ?? "request was not successful";
    super(`CashCtrl validation failed on ${path}: ${summary}`);
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
  constructor(
    status: number,
    path: string,
    body: string,
    readonly retryAfter?: number,
  ) {
    super(status, path, body);
  }
}
