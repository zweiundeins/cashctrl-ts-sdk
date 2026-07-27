/**
 * A typed TypeScript client for the CashCtrl accounting API.
 *
 * Runs on Deno, Node 18+, Bun and workers: it uses only `fetch`, `FormData`
 * and `URLSearchParams`, with no dependencies.
 *
 * @module
 */

export { CashCtrl } from "./client.ts";
export {
  CashCtrlHttp,
  type CashCtrlLang,
  type CashCtrlOptions,
  formatDate,
  type ListEnvelope,
  type Params,
  type ParamValue,
  serializeParam,
  type WriteEnvelope,
} from "./http.ts";
export {
  isLocalized,
  localize,
  type LocalizedText,
  parseLocalized,
  toLocalized,
} from "./localized.ts";
export {
  CashCtrlAuthError,
  CashCtrlError,
  CashCtrlHttpError,
  CashCtrlRateLimitError,
  CashCtrlValidationError,
  type FieldError,
} from "./errors.ts";
export * from "./generated/resources.ts";
export type * from "./generated/models.ts";
