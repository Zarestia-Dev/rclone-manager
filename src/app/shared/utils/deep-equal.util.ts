/**
 * Order-independent deep equality for plain JSON values.
 *
 * Used as a custom `equal` fn for Angular signals whose value is a fresh
 * object/array on every emit (e.g. from rclone RC responses). Without it,
 * signals fire change notifications even when the underlying data is
 * identical to the previous emit.
 *
 * Scope: handles plain objects, arrays, and primitives. Deliberately does
 * NOT support Maps, Sets, Dates, circular refs, or symbols — rclone RC
 * responses never contain those, and supporting them would add complexity
 * for no callers. If those needs ever arise, replace this with a
 * battle-tested lib like `fast-deep-equal` rather than extending it.
 */
export function deepEqual<T>(a: T, b: T): boolean {
  if (a === b) return true;

  // `null === null` is caught above; if either side is null/undefined and
  // the other isn't, they're not equal. Treat `undefined` and `null` as
  // distinct here (JSON.stringify conflates them, which is a bug we're fixing).
  if (a === null || b === null || a === undefined || b === undefined) return false;

  if (typeof a !== typeof b) return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (typeof a === 'object') {
    const aKeys = Object.keys(a as object);
    const bKeys = Object.keys(b as object);
    if (aKeys.length !== bKeys.length) return false;
    // Key-order-independent: every key in `a` must exist in `b` with the
    // same value. (JSON.stringify would falsely differ if key order differed.)
    for (const key of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
      if (!deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
        return false;
      }
    }
    return true;
  }

  // Primitives already handled by `a === b` above.
  return false;
}
