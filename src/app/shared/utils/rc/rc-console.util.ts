import { RcCommandInfo } from '@app/types';
import { RcParamInfo } from './rc-help.util';
import { maskSecrets } from './rc-output.util';

export interface RcCommandLine {
  command: string;
  params: Record<string, unknown>;
}

/** A translation key with its parameters, so the caller decides how to show the error. */
export interface RcParseError {
  key: string;
  params?: Record<string, string>;
}

export type RcParseResult = { ok: true; value: RcCommandLine } | { ok: false; error: RcParseError };

const ERR = 'modals.rcConsole.errors.';

/** A call name as rclone knows it: no surrounding spaces or slashes. */
export function normalizeCommand(command: string): string {
  return command.trim().replace(/^\/+|\/+$/g, '');
}

/** The call named at the start of a line, whether or not the rest has been typed. */
export function commandName(line: string): string {
  return normalizeCommand(/^\s*(\S*)/.exec(line)?.[1] ?? '');
}

/**
 * Calls that delete or overwrite data, change global state, stop rclone itself, or run other calls
 * (`job/batch`, `backend/command`, `core/command`), which would get round both lists.
 */
const DANGEROUS_COMMANDS = new Set([
  'backend/command',
  'config/create',
  'config/delete',
  'config/password',
  'config/setpath',
  'config/unlock',
  'config/unset',
  'config/update',
  'core/command',
  'core/quit',
  'job/batch',
  'mount/unmountall',
  'operations/cleanup',
  'operations/delete',
  'operations/deletefile',
  'operations/movefile',
  'operations/purge',
  'operations/rmdir',
  'operations/rmdirs',
  'options/set',
  'pluginsctl/addPlugin',
  'pluginsctl/removePlugin',
  'pluginsctl/removeTestPlugin',
  'rc/fatal',
  'rc/panic',
  'sync/bisync',
  'sync/move',
  'sync/sync',
]);

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_COMMANDS.has(normalizeCommand(command));
}

/**
 * Calls that only read. Read-only mode lets just these through, so a call that is new in a
 * later rclone is blocked until it is added here. `core/bwlimit` is left out: it reads without
 * a `rate` and writes with one.
 */
const READ_ONLY_COMMANDS = new Set([
  'config/dump',
  'config/get',
  'config/listremotes',
  'config/oauthstatus',
  'config/paths',
  'config/providers',
  'core/disks',
  'core/du',
  'core/group-list',
  'core/memstats',
  'core/obscure',
  'core/pid',
  'core/stats',
  'core/transferred',
  'core/version',
  'fscache/entries',
  'job/list',
  'job/status',
  'mount/listmounts',
  'mount/types',
  'operations/about',
  'operations/check',
  'operations/fsinfo',
  'operations/hashsum',
  'operations/getfile',
  'operations/hashsumfile',
  'operations/list',
  'operations/size',
  'operations/stat',
  'options/blocks',
  'options/get',
  'options/info',
  'options/local',
  'pluginsctl/getPluginsForType',
  'pluginsctl/listPlugins',
  'pluginsctl/listTestPlugins',
  'rc/error',
  'rc/list',
  'rc/noop',
  'rc/noopauth',
  'serve/list',
  'serve/types',
  'vfs/list',
  'vfs/queue',
  'vfs/stats',
]);

export function isReadOnlyCommand(command: string): boolean {
  return READ_ONLY_COMMANDS.has(normalizeCommand(command));
}

/**
 * Splits a line like a shell would, for the part rclone's `rc` accepts: whitespace separates
 * tokens and quotes group. Backslashes are plain characters, so Windows paths such as `C:\Users`
 * and `\\server\share` stay as typed. The one exception is the rule Windows itself uses: backslashes
 * directly before a `"` escape it, an odd number of them leaving a literal quote and an even number
 * (halved) leaving the quote as a quote. So `"{\"a\":1}"` is `{"a":1}`, and a quoted path that ends in
 * a backslash needs it doubled: `"C:\My Files\\"` is `C:\My Files\`. Single quotes take everything
 * literally. Returns `null` on an unclosed quote.
 */
export function tokenizeRcLine(input: string): string[] | null {
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (char === '\\' && quote !== "'") {
      let run = 1;
      while (input[i + run] === '\\') run++;
      const beforeQuote = input[i + run] === '"';
      current += '\\'.repeat(beforeQuote ? run >> 1 : run);
      started = true;
      if (beforeQuote && run % 2 === 1) {
        current += '"';
        i += run; // the escaped quote is consumed too
      } else {
        i += run - 1;
      }
    } else if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
    } else {
      current += char;
      started = true;
    }
  }

  if (quote) return null;
  if (started) tokens.push(current);
  return tokens;
}

export type JsonObjectResult =
  { ok: true; value: Record<string, unknown> } | { ok: false; error: RcParseError };

/** Parses `text` as a JSON object; anything else is an error a caller can show. */
export function parseJsonObject(text: string): JsonObjectResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: { key: `${ERR}badJson`, params: { error: (e as Error).message } } };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: { key: `${ERR}jsonNotObject` } };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/**
 * Parses a line in the syntax of `rclone rc`:
 *
 *   `operations/list fs=drive: opt.recurse=true`
 *   `operations/list --json '{"fs":"drive:"}'`
 *   `operations/list {"fs":"drive:"}`
 *   `core/command -a ls -a drive: -o max-depth=1`
 *
 * `key=value` pairs are sent as strings, like the real CLI does; rclone converts them. They can be
 * mixed with `--json`.
 * `-o name=value` fills the `opt` object and `-a value` the `arg` array.
 */
export function parseRcCommandLine(line: string): RcParseResult {
  const match = /^\s*(\S+)\s*([\s\S]*)$/.exec(line);
  if (!match) return { ok: false, error: { key: `${ERR}empty` } };

  const command = normalizeCommand(match[1]);
  const rest = match[2].trim();
  if (!command) return { ok: false, error: { key: `${ERR}empty` } };

  if (rest.startsWith('{')) {
    const json = parseJsonObject(rest);
    return json.ok ? { ok: true, value: { command, params: json.value } } : json;
  }

  const tokens = tokenizeRcLine(rest);
  if (tokens === null) return { ok: false, error: { key: `${ERR}unclosedQuote` } };

  const pairs: [string, string][] = [];
  const opt: Record<string, string> = {};
  const args: string[] = [];
  let jsonText: string | undefined;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const flag = /^(--json|--opt|--arg|-o|-a)(?:=([\s\S]*))?$/.exec(token);

    if (flag) {
      const value = flag[2] ?? tokens[++i];
      if (value === undefined) {
        return { ok: false, error: { key: `${ERR}missingValue`, params: { flag: flag[1] } } };
      }
      if (flag[1] === '--json') {
        jsonText = value;
      } else if (flag[1] === '--opt' || flag[1] === '-o') {
        const eq = value.indexOf('=');
        if (eq < 0) opt[value] = '';
        else opt[value.slice(0, eq)] = value.slice(eq + 1);
      } else {
        args.push(value);
      }
      continue;
    }

    const eq = token.indexOf('=');
    if (eq <= 0) return { ok: false, error: { key: `${ERR}missingEquals`, params: { token } } };
    pairs.push([token.slice(0, eq), token.slice(eq + 1)]);
  }

  // `--json` and `key=value` may be mixed, which the `rclone rc` command refuses but the daemon
  // does not mind: the pairs are added to the JSON, and win over a key it already has.
  let params: Record<string, unknown> = {};
  if (jsonText !== undefined) {
    const json = parseJsonObject(jsonText);
    if (!json.ok) return json;
    params = { ...json.value };
  }
  for (const [key, value] of pairs) params[key] = value;

  if (Object.keys(opt).length > 0) params['opt'] = opt;
  if (args.length > 0) params['arg'] = args;

  return { ok: true, value: { command, params } };
}

/** Commands matching what was typed so far: prefix matches first, then the rest, each alphabetical. */
export function suggestCommands(
  commands: readonly RcCommandInfo[],
  query: string,
  limit = 8
): RcCommandInfo[] {
  const needle = query.trim().replace(/^\/+/, '').toLowerCase();
  if (!needle) return [];

  const starts: RcCommandInfo[] = [];
  const contains: RcCommandInfo[] = [];
  for (const command of commands) {
    const path = command.Path.toLowerCase();
    if (path.startsWith(needle)) starts.push(command);
    else if (path.includes(needle)) contains.push(command);
  }
  return [...starts, ...contains].slice(0, limit);
}

/** The first token of the line when the user is still typing the command name. */
export function commandPrefix(line: string): string | null {
  return /^\s*\S*$/.test(line) ? line.trim() : null;
}

export interface RcSuggestion {
  kind: 'command' | 'param' | 'remote';
  label: string;
  detail: string;
  /** The whole input line once this suggestion is accepted. */
  line: string;
}

const REMOTE_KEY = /fs$/i;

/** The `key=` names already on a line. Matched literally, so a key with a dot is not a pattern. */
export function usedParamKeys(line: string): ReadonlySet<string> {
  return new Set([...line.matchAll(/(?:^|\s)([^\s=]+)=/g)].map(m => m[1]));
}

/**
 * What to offer for the word under the cursor (the end of the line): a command name while the
 * command is being typed, then parameter names, and remote names after `fs=`-style keys.
 */
export function computeSuggestions(opts: {
  line: string;
  commands: readonly RcCommandInfo[];
  remotes: readonly string[];
  params: readonly RcParamInfo[];
}): RcSuggestion[] {
  const { line, commands, remotes, params } = opts;

  const prefix = commandPrefix(line);
  if (prefix !== null) {
    const found = suggestCommands(commands, prefix);
    if (found.length === 1 && found[0].Path === prefix.replace(/^\/+/, '')) return [];
    return found.map(c => ({
      kind: 'command',
      label: c.Path,
      detail: c.Title,
      line: `${c.Path} `,
    }));
  }

  const token = /(\S*)$/.exec(line)?.[1] ?? '';
  if (!token || /["'{]/.test(token) || token.startsWith('-')) return [];
  const head = line.slice(0, line.length - token.length);

  const eq = token.indexOf('=');
  if (eq < 0) {
    const needle = token.toLowerCase();
    const used = usedParamKeys(line);
    return params
      .filter(p => p.name.toLowerCase().startsWith(needle) && !used.has(p.name))
      .slice(0, 8)
      .map(p => ({
        kind: 'param',
        label: p.name,
        detail: p.description,
        line: `${head}${p.name}=`,
      }));
  }

  const key = token.slice(0, eq);
  const value = token.slice(eq + 1);
  if (!REMOTE_KEY.test(key) || value.includes(':')) return [];
  const needle = value.toLowerCase();
  return remotes
    .filter(name => name.toLowerCase().startsWith(needle))
    .slice(0, 8)
    .map(name => ({
      kind: 'remote',
      label: `${name}:`,
      detail: '',
      line: `${head}${key}=${name}:`,
    }));
}

/**
 * Quotes a token for `rclone rc` only when it needs it, so `C:\Users\me` stays as it is. Inside the
 * quotes a backslash is doubled where it comes before a quote or the closing quote, which is what
 * `tokenizeRcLine` reads back.
 */
export function quoteToken(value: string): string {
  if (value !== '' && !/[\s"']/.test(value)) return value;
  const body = value.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/, '$&$&');
  return `"${body}"`;
}

/**
 * `command key=value …` for parameters. An `opt` object becomes `-o name=value` pairs, an `arg`
 * array `-a value`, and any other object or array its JSON.
 */
export function formatCommandLine(command: string, params: Record<string, unknown>): string {
  const text = (value: unknown): string =>
    typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  const parts = [command];
  for (const [key, value] of Object.entries(params)) {
    if (key === 'opt' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [name, v] of Object.entries(value)) {
        parts.push('-o', quoteToken(`${name}=${text(v)}`));
      }
    } else if (key === 'arg' && Array.isArray(value)) {
      for (const v of value) parts.push('-a', quoteToken(text(v)));
    } else {
      parts.push(`${key}=${quoteToken(text(value))}`);
    }
  }
  return parts.join(' ');
}

/**
 * The line with secret values masked. A line without any is returned as typed. Otherwise it is
 * written again from the masked parameters, because secrets can sit in quotes, escapes or JSON that
 * no pattern on the typed text would reliably find.
 */
export function maskCommandLine(raw: string, { command, params }: RcCommandLine): string {
  const masked = maskSecrets(params, true) as Record<string, unknown>;
  return JSON.stringify(masked) === JSON.stringify(params)
    ? raw
    : formatCommandLine(command, masked);
}

/** Adds `line` as the newest entry, dropping an older copy and the oldest entries past `max`. */
export function pushUnique(list: readonly string[], line: string, max: number): string[] {
  const trimmed = line.trim();
  if (!trimmed) return [...list];
  return [...list.filter(l => l !== trimmed), trimmed].slice(-max);
}
