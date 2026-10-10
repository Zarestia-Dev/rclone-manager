export interface ParsedCLIFlag {
  raw: string;
  key: string;
  value: string | boolean;
  hasMacro: boolean;
}

export interface ParsedCLI {
  verb?: string;
  serveSubtype?: string;
  mountSubtype?: string;
  sourcePath?: string;
  destPath?: string;
  flags: ParsedCLIFlag[];
}

export const FLAG_PATTERN = /^-{1,2}[a-zA-Z]/;

export const SHORT_FLAG_ALIASES: Record<string, string> = {
  P: 'progress',
  v: 'verbose',
  vv: 'verbose',
  q: 'quiet',
  n: 'dry-run',
  u: 'update',
  L: 'copy-links',
  I: 'ignore-times',
  c: 'checksum',
  R: 'raw-list',
  s: 'stats',
};

export const VERB_MAP: Record<string, { verb: string; mountSubtype?: string }> = {
  sync: { verb: 'sync' },
  copy: { verb: 'copy' },
  move: { verb: 'move' },
  bisync: { verb: 'bisync' },
  mount: { verb: 'mount', mountSubtype: 'mount' },
  mount2: { verb: 'mount', mountSubtype: 'mount2' },
  cmount: { verb: 'mount', mountSubtype: 'cmount' },
  nfsmount: { verb: 'mount', mountSubtype: 'nfsmount' },
  serve: { verb: 'serve' },
  check: { verb: 'check' },
  delete: { verb: 'delete' },
  copyurl: { verb: 'copyurl' },
  copyto: { verb: 'copy' },
  moveto: { verb: 'move' },
  cleanup: { verb: 'delete' },
  purge: { verb: 'delete' },
  rmdir: { verb: 'delete' },
  rmdirs: { verb: 'delete' },
};

export const WRAPPER_TOKENS = new Set([
  'sudo',
  'nohup',
  'nice',
  'time',
  'env',
  'wsl',
  'exec',
  'sh',
  'bash',
  '-c',
]);

export function stripQuotes(token: string): string {
  const len = token.length;
  if (
    len >= 2 &&
    ((token[0] === '"' && token[len - 1] === '"') || (token[0] === "'" && token[len - 1] === "'"))
  ) {
    return token.slice(1, -1);
  }
  return token;
}

export function isRcloneBinary(token: string): boolean {
  const lower = token.toLowerCase();
  return (
    lower === 'rclone' ||
    lower === 'rclone.exe' ||
    lower.startsWith('./rclone') ||
    lower.startsWith('.\\rclone') ||
    lower.endsWith('/rclone') ||
    lower.endsWith('\\rclone') ||
    lower.endsWith('/rclone.exe') ||
    lower.endsWith('\\rclone.exe')
  );
}

export function hasMacro(val: string): boolean {
  return /(\$\([\s\S]+?\))|(`[\s\S]+?`)/.test(val);
}

export function isFlagToken(token: string): boolean {
  if (!token.startsWith('-')) return false;
  if (token.startsWith('--')) {
    return token.length > 2;
  }
  if (token.length === 2 && /[a-zA-Z0-9]/.test(token[1])) return true;
  if (token === '-vv' || token === '-vvv') return true;
  return false;
}

export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inDoubleQuote = false;
  let inSingleQuote = false;
  let inSubshell = 0;
  let inBacktick = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    const nextChar = input[i + 1];

    if (char === '\\' && (nextChar === '\n' || nextChar === '\r')) {
      if (nextChar === '\r' && input[i + 2] === '\n') {
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    if (char === '\\' && inDoubleQuote && nextChar) {
      current += char + nextChar;
      i++;
      continue;
    }

    if (
      char === '#' &&
      !inDoubleQuote &&
      !inSingleQuote &&
      inSubshell === 0 &&
      !inBacktick &&
      (i === 0 || /\s/.test(input[i - 1]))
    ) {
      while (i < input.length && input[i] !== '\n') i++;
      continue;
    }

    if (char === '"' && !inSingleQuote && inSubshell === 0 && !inBacktick) {
      inDoubleQuote = !inDoubleQuote;
      current += char;
    } else if (char === "'" && !inDoubleQuote && inSubshell === 0 && !inBacktick) {
      inSingleQuote = !inSingleQuote;
      current += char;
    } else if (char === '`' && !inSingleQuote) {
      inBacktick = !inBacktick;
      current += char;
    } else if (char === '$' && nextChar === '(' && !inSingleQuote) {
      inSubshell++;
      current += '$(';
      i++;
    } else if (char === ')' && inSubshell > 0 && !inSingleQuote) {
      inSubshell--;
      current += ')';
    } else if (
      (char === ' ' || char === '\t' || char === '\r' || char === '\n') &&
      !inDoubleQuote &&
      !inSingleQuote &&
      inSubshell === 0 &&
      !inBacktick
    ) {
      if (current) {
        tokens.push(stripQuotes(current));
        current = '';
      }
    } else {
      current += char;
    }
  }
  if (current) tokens.push(stripQuotes(current));
  return tokens;
}

export function parseCLI(cliString: string, existingBools: Set<string>): ParsedCLI {
  const rawTokens = tokenize(cliString);
  const flags: ParsedCLIFlag[] = [];
  let verb: string | undefined;
  let serveSubtype: string | undefined;
  let mountSubtype: string | undefined;
  const positionalArgs: string[] = [];

  // Filter out leading wrappers and rclone binary invocations
  let startIndex = 0;
  while (startIndex < rawTokens.length) {
    const t = rawTokens[startIndex];
    if (isRcloneBinary(t)) {
      startIndex++;
      break;
    }
    if (WRAPPER_TOKENS.has(t.toLowerCase())) {
      startIndex++;
      continue;
    }
    break;
  }

  const tokens = rawTokens.slice(startIndex);
  const len = tokens.length;

  for (let i = 0; i < len; i++) {
    const token = tokens[i];

    if (token[0] === '-' && FLAG_PATTERN.test(token)) {
      let rawKey: string;
      let rawValue: string | boolean = true;
      let originalToken = token;

      const eqIdx = token.indexOf('=');
      if (eqIdx !== -1) {
        rawKey = token.substring(0, eqIdx);
        const rawValStr = stripQuotes(token.substring(eqIdx + 1));
        if (rawValStr.toLowerCase() === 'true') {
          rawValue = true;
        } else if (rawValStr.toLowerCase() === 'false') {
          rawValue = false;
        } else {
          rawValue = rawValStr;
        }
      } else {
        rawKey = token;
        const cleanKey = rawKey.replace(/^-+/, '');
        const lowerKey = cleanKey.toLowerCase();
        const isShortFlag = !rawKey.startsWith('--') && cleanKey.length === 1;
        const isKnownBool =
          isShortFlag ||
          existingBools.has(lowerKey) ||
          existingBools.has(lowerKey.replace(/-/g, '_')) ||
          existingBools.has(lowerKey.replace(/_/g, '-')) ||
          lowerKey.startsWith('no-');

        const nextToken = tokens[i + 1];
        if (nextToken && !isFlagToken(nextToken) && !isKnownBool) {
          rawValue = nextToken;
          i++;
          originalToken = `${rawKey} ${rawValue}`;
        }
      }

      flags.push({
        raw: originalToken,
        key: rawKey.replace(/^-+/, ''),
        value: rawValue,
        hasMacro: typeof rawValue === 'string' && hasMacro(rawValue),
      });
    } else {
      const lowerToken = token.toLowerCase();
      if (!verb && VERB_MAP[lowerToken]) {
        const mapping = VERB_MAP[lowerToken];
        verb = mapping.verb;
        if (mapping.mountSubtype) {
          mountSubtype = mapping.mountSubtype;
        }
      } else if (verb === 'serve' && !serveSubtype) {
        serveSubtype = lowerToken;
      } else {
        positionalArgs.push(token);
      }
    }
  }

  return {
    verb,
    serveSubtype,
    mountSubtype,
    sourcePath: positionalArgs[0],
    destPath: positionalArgs[1],
    flags,
  };
}
