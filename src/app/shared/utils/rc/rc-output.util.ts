export const MASK = '••••••';

/**
 * Keys whose values are masked. Matched on whole words so `bypass` is left alone, and without
 * a bare `auth` so `oauth` status fields stay readable.
 */
const SECRET_KEY =
  /pass(?:word|wd|phrase)|(?:^|[-_.])pass$|token|secret|credential|api[-_]?key|private[-_]?key|access[-_]?key|authorization|bearer|cookie|session[-_]?id/i;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

/**
 * Masks the value of every secret-looking key, at any depth. For call parameters, where
 * `key=value` carries JSON as text (`parameters={"token":…}`), set `jsonText` to mask inside a
 * string that holds JSON as well.
 */
export function maskSecrets(value: unknown, jsonText = false): unknown {
  if (Array.isArray(value)) return value.map(v => maskSecrets(v, jsonText));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [
        key,
        isSecretKey(key) && v !== null && v !== '' && v !== undefined
          ? MASK
          : maskSecrets(v, jsonText),
      ])
    );
  }
  if (jsonText && typeof value === 'string' && /^\s*[{[]/.test(value)) {
    try {
      const parsed: unknown = JSON.parse(value);
      const masked = maskSecrets(parsed, true);
      return JSON.stringify(masked) === JSON.stringify(parsed) ? value : JSON.stringify(masked);
    } catch {
      return value;
    }
  }
  return value;
}

const PAIR = /(^|[\s,{])["']?([\w.-]+)["']?\s*[=:]/g;

/**
 * Whether a typed line sets a secret-looking key, as `key=value` or in JSON. Only the key is
 * looked for, so quoting or escaping in the value cannot hide it.
 */
export function lineHasSecret(line: string): boolean {
  return [...line.matchAll(PAIR)].some(m => isSecretKey(m[2]));
}

export interface RcTable {
  columns: string[];
  rows: Record<string, unknown>[];
  /** Rows beyond the cap that are not in `rows`. */
  omitted: number;
}

const MAX_TABLE_ROWS = 1000;
const MAX_TABLE_COLUMNS = 40;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asRows(value: unknown): Record<string, unknown>[] | null {
  return Array.isArray(value) && value.length > 0 && value.every(isPlainObject) ? value : null;
}

/**
 * A table for a list of objects, either the whole body (`operations/list` wraps it as
 * `{ list: […] }`) or its only list-valued member.
 */
export function toTable(body: unknown): RcTable | null {
  let rows = asRows(body);
  if (!rows && isPlainObject(body)) {
    const lists = Object.values(body).filter(v => Array.isArray(v));
    if (lists.length === 1) rows = asRows(lists[0]);
  }
  if (!rows) return null;

  const columns: string[] = [];
  for (const row of rows.slice(0, 200)) {
    for (const key of Object.keys(row)) {
      if (!columns.includes(key) && columns.length < MAX_TABLE_COLUMNS) columns.push(key);
    }
  }
  return {
    columns,
    rows: rows.slice(0, MAX_TABLE_ROWS),
    omitted: Math.max(0, rows.length - MAX_TABLE_ROWS),
  };
}

const MAX_CELL_CHARS = 80;

export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return text.length > MAX_CELL_CHARS ? `${text.slice(0, MAX_CELL_CHARS)}…` : text;
}

export interface JsonSegment {
  text: string;
  kind: 'key' | 'string' | 'number' | 'bool' | 'null' | 'plain';
}

const JSON_TOKEN =
  /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false)\b|\b(null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

/** Splits pretty-printed JSON into runs to colour. */
export function highlightJson(text: string): JsonSegment[] {
  const segments: JsonSegment[] = [];
  let last = 0;

  for (const match of text.matchAll(JSON_TOKEN)) {
    const start = match.index;
    if (start > last) segments.push({ text: text.slice(last, start), kind: 'plain' });

    if (match[1] !== undefined) {
      if (match[2] !== undefined) {
        segments.push({ text: match[1], kind: 'key' }, { text: match[2], kind: 'plain' });
      } else {
        segments.push({ text: match[1], kind: 'string' });
      }
    } else if (match[3] !== undefined) {
      segments.push({ text: match[0], kind: 'bool' });
    } else if (match[4] !== undefined) {
      segments.push({ text: match[0], kind: 'null' });
    } else {
      segments.push({ text: match[0], kind: 'number' });
    }
    last = start + match[0].length;
  }

  if (last < text.length) segments.push({ text: text.slice(last), kind: 'plain' });
  return segments;
}

/** How many lines a text has, without splitting a possibly huge text into an array. */
export function countLines(text: string): number {
  let count = 1;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) count++;
  return count;
}

/** The first `limit` lines of a text, without splitting all of it. */
export function firstLines(text: string, limit: number): string {
  let end = -1;
  for (let line = 0; line < limit; line++) {
    end = text.indexOf('\n', end + 1);
    if (end === -1) return text;
  }
  return text.slice(0, end);
}
