/**
 * CashCtrl's update endpoints are full replacements, not patches. The docs are
 * explicit about it:
 *
 *   "Note that all parameters must be submitted, omitted parameters are
 *    treated as empty values."
 *
 * So `order.update({ id, associateId, categoryId, date, items })` does not just
 * change the items: it silently wipes the description, notes, due days and
 * everything else you did not resend. That is a data-loss footgun, and the
 * only safe pattern is read-modify-write.
 *
 * {@link mergeUpdate} implements that pattern. Each generated resource with an
 * `update` method also exposes `updatePreserving`, which wires it up for you.
 */

/**
 * Builds update parameters that preserve the entity's current values.
 *
 * Fields are taken from `existing` (restricted to `writable`, so read-only
 * fields like `created` are never sent back), then overridden by `changes`.
 * An explicit `null` in `changes` still clears the field, since the transport
 * distinguishes `null` from `undefined`.
 *
 * Prefer the generated `updatePreserving` on each resource, which supplies the
 * writable field list and the type parameter for you. Calling this directly
 * needs an explicit `T`, because inference would otherwise narrow it to the
 * shape of `changes`:
 *
 * ```ts
 * const order = await cc.order.read({ id: 42 });
 * await cc.order.updatePreserving(order, { id: 42, items: newItems });
 *
 * // equivalent, done by hand:
 * await cc.order.update(
 *   mergeUpdate<OrderUpdateParams>(order, { id: 42, items: newItems },
 *     ORDER_UPDATE_FIELDS),
 * );
 * ```
 */
export function mergeUpdate<T extends object>(
  existing: Readonly<Record<string, unknown>>,
  changes: Partial<T>,
  writable: readonly string[],
): T {
  const merged: Record<string, unknown> = {};

  for (const field of writable) {
    const value = existing[field];
    // `undefined` means the read simply did not include the field; sending it
    // would clear the value, so leave it out and let CashCtrl keep its own.
    if (value !== undefined) merged[field] = value;
  }

  for (const [field, value] of Object.entries(changes)) {
    // An explicit `undefined` in `changes` means "leave as-is", not "clear".
    if (value !== undefined) merged[field] = value;
  }

  return merged as T;
}
