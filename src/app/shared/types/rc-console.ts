/** One entry of rclone's `rc/list`. */
export interface RcCommandInfo {
  Path: string;
  Title: string;
  /** Markdown help text. */
  Help: string;
  NoAuth?: boolean;
  NeedsRequest?: boolean;
  NeedsResponse?: boolean;
}

/** What `rc_console_call` returns; a failed call is a response, not a rejection. */
export interface RcConsoleResponse {
  ok: boolean;
  /** HTTP status of a call rclone refused; absent for a success or when rclone was not reached. */
  status?: number | null;
  durationMs: number;
  body: unknown;
}

/** A message above the input, as a translation key. `allowWrites` adds the button that lifts read-only mode. */
export interface RcNotice {
  key: string;
  params?: Record<string, string>;
  allowWrites?: boolean;
}
