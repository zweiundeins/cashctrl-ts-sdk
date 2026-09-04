/**
 * GET endpoints that change state.
 *
 * "It is a GET, so it is safe" does not hold for this API: these two mutate
 * the organisation. Anything that decides what to call automatically — a
 * probe, an agent, a generated client's read-only mode — has to deny them
 * explicitly.
 */
export const SIDE_EFFECTING_GETS: readonly string[] = [
  /** Reopens closed months of a fiscal period. */
  "/api/v1/fiscalperiod/reopen_months.json",
  /** Consumes the next number in a sequence; the number is not given back. */
  "/api/v1/sequencenumber/get",
];

/** True when `path` is a GET that mutates state. */
export function isSideEffectingGet(path: string): boolean {
  return SIDE_EFFECTING_GETS.includes(path);
}
