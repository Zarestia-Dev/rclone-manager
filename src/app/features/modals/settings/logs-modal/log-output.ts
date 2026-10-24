export interface CommandOutput {
  text: string;
  failed: boolean;
}

/** Read command output from RC job status and serialized response envelopes. */
export function extractCommandOutput(
  value: unknown,
  inheritedFailure = false,
  depth = 0
): CommandOutput | null {
  // Logs are normally JSON, but bound traversal for malformed or cyclic input too.
  if (depth > 8) return null;
  if (typeof value === 'string') {
    try {
      return extractCommandOutput(JSON.parse(value), inheritedFailure, depth + 1);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const error = record['error'];
  const failed =
    inheritedFailure ||
    error === true ||
    (typeof error === 'string' && error.trim().length > 0) ||
    record['success'] === false;

  for (const key of ['status', 'response', 'output']) {
    const nested = record[key];
    if (key === 'output' && typeof nested === 'string' && nested.trim()) {
      return { text: nested, failed };
    }
    const output = extractCommandOutput(nested, failed, depth + 1);
    if (output) return output;
  }
  if (typeof record['result'] === 'string' && record['result'].trim()) {
    return { text: record['result'], failed };
  }
  if (typeof error === 'string' && error.trim()) {
    return { text: error, failed: true };
  }
  return null;
}
