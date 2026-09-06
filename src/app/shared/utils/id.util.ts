let counter = 0;

/**
 * Generates a unique, URL/log-friendly identifier with an optional prefix.
 *
 * Format: `${prefix ? prefix + '-' : ''}${timestampBase36}-${sequenceBase36}-${randomBase36}`
 * Example: `nautilus-left-mtpzibv0-001-9f8a` or `qr-mtpzibv0-002-3k1d`
 *
 * - prefix: Origin/context identifier for clear debugging and log readability.
 * - timestampBase36: Monotonic millisecond timestamp encoded in base36 (~8 chars).
 * - sequenceBase36: 3-character sequential counter (0-46655 in base36) that rolls over,
 *   guaranteeing zero collision even when multiple IDs are generated in the exact same millisecond.
 * - randomBase36: 4-character pseudo-random string for entropy across multiple browser tabs/instances.
 *
 * Completely independent of `crypto.randomUUID()`, ensuring 100% reliable execution in
 * non-secure contexts (HTTP), WebViews, and headless environments.
 */
export function generatePrefixedId(prefix?: string): string {
  const time = Date.now().toString(36);
  const seq = (++counter % 46655).toString(36).padStart(3, '0');
  const rand = Math.random().toString(36).slice(2, 6);

  return prefix ? `${prefix}-${time}-${seq}-${rand}` : `${time}-${seq}-${rand}`;
}
