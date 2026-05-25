import { Injectable } from '@angular/core';
import { RcConfigOption, SharedProfileType } from '@app/types';

export interface ParsedCLIFlag {
  raw: string; // e.g. "--max-delete"
  key: string; // e.g. "max-delete"
  value: string | boolean; // e.g. "50" or true (for flags without value)
  hasMacro: boolean; // true if it contains macro pattern like $(...) or `...`
}

export interface ParsedCLI {
  verb?: string; // "sync" | "copy" | "move" | "bisync" | "mount" | "serve"
  serveSubtype?: string; // e.g. "http", "ftp", etc. for serve command
  mountSubtype?: string; // e.g. "mount", "mount2", "cmount", "nfsmount"
  sourcePath?: string; // first positional arg
  destPath?: string; // second positional arg
  flags: ParsedCLIFlag[];
}

export type FlagStatus = 'mapped' | 'unknown';

export interface ClassifiedFlag {
  flag: ParsedCLIFlag;
  status: FlagStatus;
  flagType?: SharedProfileType;
  fieldName?: string;
  coercedValue?: unknown;
  guidance?: string;
}

export interface ImportResult {
  verb?: string;
  serveSubtype?: string;
  mountSubtype?: string;
  sourcePath?: string;
  destPath?: string;
  classified: ClassifiedFlag[];
}

@Injectable({
  providedIn: 'root',
})
export class CliFlagMapperService {
  /**
   * Tokenizes a raw shell command line into tokens, respecting quotes.
   */
  tokenize(cli: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let inDoubleQuote = false;
    let inSingleQuote = false;
    let inSubshell = 0;
    let inBacktick = false;

    // Replace backslash line continuations
    const cleanCli = cli.replace(/\\\r?\n/g, ' ');

    let i = 0;
    while (i < cleanCli.length) {
      const char = cleanCli[i];

      // Strip shell comments starting with #
      if (
        char === '#' &&
        !inDoubleQuote &&
        !inSingleQuote &&
        (i === 0 || /\s/.test(cleanCli[i - 1]))
      ) {
        while (i < cleanCli.length && cleanCli[i] !== '\n') {
          i++;
        }
        continue;
      }

      if (char === '"' && !inSingleQuote) {
        inDoubleQuote = !inDoubleQuote;
        current += char;
      } else if (char === "'" && !inDoubleQuote) {
        inSingleQuote = !inSingleQuote;
        current += char;
      } else if (char === '`' && !inDoubleQuote && !inSingleQuote) {
        inBacktick = !inBacktick;
        current += char;
      } else if (
        char === '$' &&
        i + 1 < cleanCli.length &&
        cleanCli[i + 1] === '(' &&
        !inDoubleQuote &&
        !inSingleQuote
      ) {
        inSubshell++;
        current += '$(';
        i++; // skip '('
      } else if (char === ')' && inSubshell > 0 && !inDoubleQuote && !inSingleQuote) {
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
          tokens.push(current);
          current = '';
        }
      } else {
        current += char;
      }
      i++;
    }
    if (current) {
      tokens.push(current);
    }
    return tokens.map(t => this.stripQuotes(t));
  }

  private stripQuotes(token: string): string {
    if (
      (token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith("'") && token.endsWith("'"))
    ) {
      return token.slice(1, -1);
    }
    return token;
  }

  /**
   * Checks if a string contains macros like $(...) or `...`
   */
  hasMacro(val: string): boolean {
    return /(\$\([\s\S]+?\))|(`[\s\S]+?`)/.test(val);
  }

  /**
   * Parse a list of tokens into parsed verb, paths, and flags.
   */
  parse(cliString: string, existingBools: Set<string>): ParsedCLI {
    const tokens = this.tokenize(cliString);
    const flags: ParsedCLIFlag[] = [];
    let verb: string | undefined;
    let serveSubtype: string | undefined;
    let mountSubtype: string | undefined;
    const positionalArgs: string[] = [];

    const verbs = new Set([
      'sync',
      'copy',
      'move',
      'bisync',
      'mount',
      'mount2',
      'cmount',
      'nfsmount',
      'serve',
    ]);

    let i = 0;
    while (i < tokens.length) {
      const token = tokens[i];

      // Handle rclone binary prefix
      if (
        i === 0 &&
        (token.toLowerCase() === 'rclone' ||
          token.toLowerCase() === 'rclone.exe' ||
          token.startsWith('./rclone') ||
          token.startsWith('.\\rclone'))
      ) {
        i++;
        continue;
      }

      if (token.startsWith('-') && /^-{1,2}[a-zA-Z0-9_]/.test(token)) {
        let rawKey: string;
        let rawValue: string | boolean = true;
        let originalToken = token;

        if (token.includes('=')) {
          const eqIdx = token.indexOf('=');
          rawKey = token.substring(0, eqIdx);
          rawValue = this.stripQuotes(token.substring(eqIdx + 1));
        } else {
          rawKey = token;
          const cleanKey = rawKey.replace(/^-+/, '').toLowerCase();
          const isKnownBool =
            existingBools.has(cleanKey) ||
            existingBools.has(cleanKey.replace(/-/g, '_')) ||
            existingBools.has(cleanKey.replace(/_/g, '-'));
          const isNextFlag = i + 1 < tokens.length && /^-{1,2}[a-zA-Z0-9_]/.test(tokens[i + 1]);

          if (i + 1 < tokens.length && !isNextFlag && !isKnownBool) {
            rawValue = tokens[i + 1];
            originalToken = `${rawKey} ${rawValue}`;
            i++;
          }
        }

        const cleanKey = rawKey.replace(/^-+/, '');
        flags.push({
          raw: originalToken,
          key: cleanKey,
          value: rawValue,
          hasMacro: typeof rawValue === 'string' && this.hasMacro(rawValue),
        });
      } else {
        if (!verb && verbs.has(token.toLowerCase())) {
          const lowerToken = token.toLowerCase();
          if (
            lowerToken === 'mount' ||
            lowerToken === 'mount2' ||
            lowerToken === 'cmount' ||
            lowerToken === 'nfsmount'
          ) {
            verb = 'mount';
            mountSubtype = lowerToken;
          } else {
            verb = lowerToken;
          }
        } else if (verb === 'serve' && !serveSubtype) {
          serveSubtype = token.toLowerCase();
        } else {
          positionalArgs.push(token);
        }
      }
      i++;
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

  /**
   * Builds lookup table mapping flag names to their definitions.
   */
  buildLookupTable(
    flagFields: Record<SharedProfileType, RcConfigOption[]>,
    remoteType?: string
  ): Record<string, { option: RcConfigOption; flagType: SharedProfileType }> {
    const table: Record<string, { option: RcConfigOption; flagType: SharedProfileType }> = {};

    Object.entries(flagFields).forEach(([type, fields]) => {
      const flagType = type as SharedProfileType;
      fields.forEach(field => {
        const nameRaw = (field.Name ?? '').toLowerCase();
        const nameHyphen = nameRaw.replace(/_/g, '-');
        const keyCamel = (field.FieldName ?? '').toLowerCase();

        const prefixes: string[] = [''];
        if (flagType === 'runtimeRemote' && remoteType) {
          prefixes.push(`${remoteType.toLowerCase().trim()}-`);
        }

        prefixes.forEach(p => {
          if (nameRaw) {
            table[p + nameRaw] = { option: field, flagType };
          }
          if (nameHyphen && nameHyphen !== nameRaw) {
            table[p + nameHyphen] = { option: field, flagType };
          }
          if (keyCamel && keyCamel !== nameRaw && keyCamel !== nameHyphen) {
            table[p + keyCamel] = { option: field, flagType };
          }
        });
      });
    });

    return table;
  }

  /**
   * Classify parsed CLI structure against lookup table.
   */
  classify(
    parsed: ParsedCLI,
    lookupTable: Record<string, { option: RcConfigOption; flagType: SharedProfileType }>
  ): ImportResult {
    const classified: ClassifiedFlag[] = parsed.flags.map(flag => {
      const match = lookupTable[flag.key.toLowerCase()];
      if (match) {
        return {
          flag,
          status: 'mapped' as FlagStatus,
          flagType: match.flagType,
          fieldName: match.option.FieldName || match.option.Name,
          coercedValue: this.coerceValue(flag.value, match.option.Type),
        };
      }
      return { flag, status: 'unknown' as FlagStatus };
    });

    return {
      verb: parsed.verb,
      serveSubtype: parsed.serveSubtype,
      mountSubtype: parsed.mountSubtype,
      sourcePath: parsed.sourcePath,
      destPath: parsed.destPath,
      classified,
    };
  }

  private coerceValue(val: string | boolean, type: string): unknown {
    if (typeof val === 'boolean') return val;
    if (type === 'bool' || type === 'Tristate') {
      const s = val.toLowerCase().trim();
      return s === 'true' || s === '1' || s === 'yes';
    }
    if (
      type === 'int' ||
      type === 'int64' ||
      type === 'int32' ||
      type === 'uint' ||
      type === 'uint32' ||
      type === 'uint64'
    ) {
      const num = parseInt(val, 10);
      return isNaN(num) ? val : num;
    }
    if (type === 'float' || type === 'float32' || type === 'float64') {
      const num = parseFloat(val);
      return isNaN(num) ? val : num;
    }
    return val;
  }
}
