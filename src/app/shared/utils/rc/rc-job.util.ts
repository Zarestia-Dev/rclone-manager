export interface RcJobView {
  finished: boolean;
  success: boolean;
  error: string;
  /** Seconds the job has run for. */
  duration: number;
  output: unknown;
  group: string;
}

export interface RcJobProgress {
  bytes: number;
  totalBytes: number;
  speed: number;
  /** Seconds left, when rclone can tell. */
  eta: number | null;
  transfers: number;
  totalTransfers: number;
  checks: number;
  errors: number;
  /** 0 to 100, or `null` while the total is not known. */
  percent: number | null;
}

const num = (value: unknown): number => (typeof value === 'number' && isFinite(value) ? value : 0);

/** The reply of `job/status`. */
export function toJobView(body: unknown): RcJobView {
  const b = (body ?? {}) as Record<string, unknown>;
  return {
    finished: b['finished'] === true,
    success: b['success'] === true,
    error: typeof b['error'] === 'string' ? b['error'] : '',
    duration: num(b['duration']),
    output: b['output'],
    group: typeof b['group'] === 'string' ? b['group'] : '',
  };
}

/** The reply of `core/stats` for the job's group, or `null` when there is nothing to show yet. */
export function toJobProgress(body: unknown): RcJobProgress | null {
  if (body === null || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const totalBytes = num(b['totalBytes']);
  const totalTransfers = num(b['totalTransfers']);
  const checks = num(b['checks']);
  if (totalBytes === 0 && totalTransfers === 0 && checks === 0) return null;

  const bytes = num(b['bytes']);
  return {
    bytes,
    totalBytes,
    speed: num(b['speed']),
    eta: typeof b['eta'] === 'number' ? b['eta'] : null,
    transfers: num(b['transfers']),
    totalTransfers,
    checks,
    errors: num(b['errors']),
    percent: totalBytes > 0 ? Math.min(100, Math.round((bytes / totalBytes) * 100)) : null,
  };
}
