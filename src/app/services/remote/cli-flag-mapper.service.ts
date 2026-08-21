import { Injectable, inject } from '@angular/core';
import { RcConfigOption, SharedProfileType } from '@app/types';
import { FlagConfigService } from './flag-config.service';
import { RemoteManagementService } from './remote-management.service';
import { RcloneValueMapperService } from './rclone-value-mapper.service';

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
const FLAG_PATTERN = /^-{1,2}[a-zA-Z]/;

const SHORT_FLAG_ALIASES: Record<string, string> = {
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

const VERB_MAP: Record<string, { verb: string; mountSubtype?: string }> = {
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

const WRAPPER_TOKENS = new Set([
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

export interface LookupEntry {
  option: RcConfigOption;
  flagType: SharedProfileType;
  supportedFlagTypes: Set<SharedProfileType>;
}

function isFlagToken(token: string): boolean {
  if (!token.startsWith('-')) return false;
  if (token.startsWith('--')) {
    return token.length > 2;
  }
  if (token.length === 2 && /[a-zA-Z0-9]/.test(token[1])) return true;
  if (token === '-vv' || token === '-vvv') return true;
  return false;
}

@Injectable({ providedIn: 'root' })
export class CliFlagMapperService {
  private flagConfigService = inject(FlagConfigService);
  private remoteManagementService = inject(RemoteManagementService);
  private valueMapper = inject(RcloneValueMapperService);

  private booleanFlagsCache: Set<string> | null = null;
  private readonly lookupTablesCache = new Map<string, Record<string, LookupEntry>>();

  tokenize(input: string): string[] {
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
          tokens.push(this.stripQuotes(current));
          current = '';
        }
      } else {
        current += char;
      }
    }
    if (current) tokens.push(this.stripQuotes(current));
    return tokens;
  }

  private stripQuotes(token: string): string {
    const len = token.length;
    if (
      len >= 2 &&
      ((token[0] === '"' && token[len - 1] === '"') || (token[0] === "'" && token[len - 1] === "'"))
    ) {
      return token.slice(1, -1);
    }
    return token;
  }

  private isRcloneBinary(token: string): boolean {
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

  hasMacro(val: string): boolean {
    return /(\$\([\s\S]+?\))|(`[\s\S]+?`)/.test(val);
  }

  parse(cliString: string, existingBools: Set<string>): ParsedCLI {
    const rawTokens = this.tokenize(cliString);
    const flags: ParsedCLIFlag[] = [];
    let verb: string | undefined;
    let serveSubtype: string | undefined;
    let mountSubtype: string | undefined;
    const positionalArgs: string[] = [];

    // Filter out leading wrappers and rclone binary invocations
    let startIndex = 0;
    while (startIndex < rawTokens.length) {
      const t = rawTokens[startIndex];
      if (this.isRcloneBinary(t)) {
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
          const rawValStr = this.stripQuotes(token.substring(eqIdx + 1));
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
          hasMacro: typeof rawValue === 'string' && this.hasMacro(rawValue),
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

  buildLookupTable(
    flagFields: Record<SharedProfileType, RcConfigOption[]>,
    remoteType?: string
  ): Record<string, LookupEntry> {
    const table: Record<string, LookupEntry> = {};
    const prefix = remoteType ? `${remoteType.toLowerCase().trim()}-` : '';

    for (const [type, fields] of Object.entries(flagFields)) {
      const flagType = type as SharedProfileType;
      const isRuntimeRemote = flagType === 'runtimeRemote';

      for (const field of fields) {
        // Index by Name, FieldName, hyphenated, underscored and stripped forms
        const names = [field.Name, field.FieldName].filter((n): n is string => !!n);

        for (const rawName of names) {
          const key = rawName.toLowerCase().replace(/_/g, '-');
          if (!key) continue;

          const registerKey = (k: string): void => {
            const existing = table[k];
            if (existing) {
              existing.supportedFlagTypes.add(flagType);
            } else {
              table[k] = {
                option: field,
                flagType,
                supportedFlagTypes: new Set([flagType]),
              };
            }
          };

          registerKey(key);
          registerKey(key.replace(/-/g, ''));
          registerKey(rawName.toLowerCase());

          if (isRuntimeRemote && prefix) {
            registerKey(prefix + key);
            registerKey((prefix + key).replace(/-/g, ''));
          }
        }
      }
    }
    return table;
  }

  classify(
    parsed: ParsedCLI,
    lookupTable: Record<string, LookupEntry>,
    preferredType?: string
  ): ImportResult {
    const targetPref = (preferredType || parsed.verb) as SharedProfileType | undefined;

    const classified: ClassifiedFlag[] = parsed.flags.map(flag => {
      let keyLower = flag.key.toLowerCase();

      // Check short flag aliases (e.g. -P -> progress, -v -> verbose)
      if (SHORT_FLAG_ALIASES[flag.key] || SHORT_FLAG_ALIASES[keyLower]) {
        keyLower = SHORT_FLAG_ALIASES[flag.key] || SHORT_FLAG_ALIASES[keyLower];
      }

      // 1. Direct match
      let match = lookupTable[keyLower] || lookupTable[keyLower.replace(/[-_]/g, '')];

      // 2. Negated boolean flag match (e.g. --no-traverse -> traverse = false)
      let isNegated = false;
      if (!match && keyLower.startsWith('no-')) {
        const unnegatedKey = keyLower.substring(3);
        const candidate =
          lookupTable[unnegatedKey] || lookupTable[unnegatedKey.replace(/[-_]/g, '')];
        if (
          candidate &&
          (candidate.option.Type === 'bool' || candidate.option.Type === 'Tristate')
        ) {
          match = candidate;
          isNegated = true;
        }
      }

      if (match) {
        const coercedValue = isNegated ? false : this.coerceValue(flag.value, match.option.Type);
        const resolvedFlagType =
          targetPref && match.supportedFlagTypes.has(targetPref) ? targetPref : match.flagType;

        return {
          flag,
          status: 'mapped',
          flagType: resolvedFlagType,
          fieldName: match.option.Name || match.option.FieldName,
          coercedValue,
        };
      }
      return { flag, status: 'unknown' };
    });

    return { ...parsed, classified };
  }

  private coerceValue(val: string | boolean, type: string): unknown {
    if (typeof val === 'boolean') return val;
    if (typeof val === 'string') {
      const lower = val.toLowerCase().trim();
      if (lower === 'false' && (type === 'bool' || type === 'Tristate')) return false;
      if (lower === 'true' && (type === 'bool' || type === 'Tristate')) return true;
    }
    if (type === 'Tristate') return this.valueMapper.parseTristate(val);
    return this.valueMapper.humanToMachine(val, type);
  }

  async getGlobalLookupTable(remoteType?: string): Promise<Record<string, LookupEntry>> {
    const cacheKey = remoteType || '__none__';
    const cached = this.lookupTablesCache.get(cacheKey);
    if (cached) return cached;

    const flagFields = await this.flagConfigService.loadAllFlagFields();
    let runtimeRemoteFields: RcConfigOption[] = [];

    if (remoteType) {
      try {
        runtimeRemoteFields = await this.remoteManagementService.getRemoteConfigFields(remoteType);
      } catch (error) {
        console.error('Failed to load remote config fields:', error);
      }
    }

    const table = this.buildLookupTable(
      { ...flagFields, runtimeRemote: runtimeRemoteFields },
      remoteType
    );
    this.lookupTablesCache.set(cacheKey, table);
    return table;
  }

  async getBooleanFlags(): Promise<Set<string>> {
    if (this.booleanFlagsCache) return this.booleanFlagsCache;
    const flagFields = await this.flagConfigService.loadAllFlagFields();
    const bools = new Set<string>();

    for (const fields of Object.values(flagFields)) {
      for (const f of fields) {
        if (f.Type !== 'bool' && f.Type !== 'Tristate') continue;
        const name = (f.Name || f.FieldName || '').toLowerCase();
        if (!name) continue;
        bools.add(name);
        bools.add(name.replace(/_/g, '-'));
      }
    }
    this.booleanFlagsCache = bools;
    return bools;
  }

  async importCliCommand(
    cliString: string,
    remoteType?: string,
    preferredType?: string
  ): Promise<ImportResult> {
    const [boolFlags, lookupTable] = await Promise.all([
      this.getBooleanFlags(),
      this.getGlobalLookupTable(remoteType),
    ]);
    return this.classify(this.parse(cliString, boolFlags), lookupTable, preferredType);
  }
}
