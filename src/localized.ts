import type { CashCtrlLang } from "./http.ts";

/**
 * CashCtrl stores translatable text as an XML blob rather than a JSON object:
 *
 *     <values><de>Kasse</de><en>Cash</en><fr>Caisse</fr></values>
 *
 * Fields like `name` and `description` come back in this form whenever the
 * user entered more than one language, and as a plain string otherwise. These
 * helpers convert in both directions.
 */
export type LocalizedText = Partial<Record<CashCtrlLang, string>>;

const VALUES_RE = /^\s*<values>([\s\S]*)<\/values>\s*$/;
const ENTRY_RE = /<(de|fr|it|en)>([\s\S]*?)<\/\1>/g;

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** True when `value` uses the `<values>` wrapper. */
export function isLocalized(value: string | null | undefined): boolean {
  return typeof value === "string" && VALUES_RE.test(value);
}

/**
 * Parses a possibly-localized field into a per-language map.
 * A plain string yields `{}` with the text available via {@link localize}.
 */
export function parseLocalized(
  value: string | null | undefined,
): LocalizedText {
  if (typeof value !== "string") return {};
  const inner = VALUES_RE.exec(value)?.[1];
  if (inner === undefined) return {};
  const out: LocalizedText = {};
  for (const match of inner.matchAll(ENTRY_RE)) {
    out[match[1] as CashCtrlLang] = unescapeXml(match[2]);
  }
  return out;
}

/**
 * Resolves a possibly-localized field to a single string.
 *
 * Falls back through `lang` -> `fallbacks` -> the first available language, so
 * you always get something displayable.
 *
 * ```ts
 * localize(account.name, "en");           // "Cash"
 * localize("Plain text", "en");           // "Plain text"
 * ```
 */
export function localize(
  value: string | null | undefined,
  lang: CashCtrlLang,
  fallbacks: readonly CashCtrlLang[] = ["en", "de", "fr", "it"],
): string {
  if (typeof value !== "string") return "";
  if (!isLocalized(value)) return value;
  const parsed = parseLocalized(value);
  for (const candidate of [lang, ...fallbacks]) {
    const text = parsed[candidate];
    if (text) return text;
  }
  return Object.values(parsed)[0] ?? "";
}

/**
 * Builds the `<values>` XML CashCtrl expects for a multilingual field.
 *
 * ```ts
 * await cc.account.create({
 *   name: toLocalized({ de: "Kasse", en: "Cash" }),
 *   categoryId: 1,
 *   number: 1000,
 * });
 * ```
 */
export function toLocalized(text: LocalizedText): string {
  const entries = (Object.entries(text) as [CashCtrlLang, string][])
    .filter(([, v]) => typeof v === "string")
    .map(([lang, v]) => `<${lang}>${escapeXml(v)}</${lang}>`);
  return `<values>${entries.join("")}</values>`;
}
