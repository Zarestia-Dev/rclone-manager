import { Injectable, inject } from '@angular/core';
import { RcConfigOption, SharedProfileType } from '@app/types';
import { FlagConfigService } from './flag-config.service';
import { RemoteManagementService } from './remote-management.service';
import { TranslateService } from '@ngx-translate/core';
import { getControlKey } from './utils/remote-config.utils';

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

@Injectable({ providedIn: 'root' })
export class CliFlagMapperService {
  private readonly flagConfigService = inject(FlagConfigService);
  private readonly remoteManagementService = inject(RemoteManagementService);
  private readonly translateService = inject(TranslateService);

  private booleanFlagsCache: Set<string> | null = null;
  private readonly lookupTablesCache = new Map<
    string,
    Record<string, { option: RcConfigOption; flagType: SharedProfileType }>
  >();

  tokenize(cli: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let inDoubleQuote = false;
    let inSingleQuote = false;
    let inSubshell = 0;
    let inBacktick = false;

    const cleanCli = cli.replace(/\\\r?\n/g, ' ');
    const len = cleanCli.length;

    for (let i = 0; i < len; i++) {
      const char = cleanCli[i];

      if (
        char === '#' &&
        !inDoubleQuote &&
        !inSingleQuote &&
        (i === 0 || /\s/.test(cleanCli[i - 1]))
      ) {
        while (i < len && cleanCli[i] !== '\n') i++;
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
        i + 1 < len &&
        cleanCli[i + 1] === '(' &&
        !inDoubleQuote &&
        !inSingleQuote
      ) {
        inSubshell++;
        current += '$(';
        i++;
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

  hasMacro(val: string): boolean {
    return /(\$\([\s\S]+?\))|(`[\s\S]+?`)/.test(val);
  }

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
    const len = tokens.length;

    for (let i = 0; i < len; i++) {
      const token = tokens[i];

      if (
        i === 0 &&
        (token === 'rclone' ||
          token === 'rclone.exe' ||
          token.startsWith('./rclone') ||
          token.startsWith('.\\rclone'))
      ) {
        continue;
      }

      if (token[0] === '-' && /^-{1,2}[a-zA-Z0-9_]/.test(token)) {
        let rawKey: string;
        let rawValue: string | boolean = true;
        let originalToken = token;

        const eqIdx = token.indexOf('=');
        if (eqIdx !== -1) {
          rawKey = token.substring(0, eqIdx);
          rawValue = this.stripQuotes(token.substring(eqIdx + 1));
        } else {
          rawKey = token;
          const cleanKey = rawKey.replace(/^-+/, '').toLowerCase();
          const isKnownBool =
            existingBools.has(cleanKey) ||
            existingBools.has(cleanKey.replace(/-/g, '_')) ||
            existingBools.has(cleanKey.replace(/_/g, '-'));

          if (i + 1 < len && !tokens[i + 1].startsWith('-') && !isKnownBool) {
            rawValue = tokens[++i];
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
        if (!verb && verbs.has(token.toLowerCase())) {
          const lowerToken = token.toLowerCase();
          if (lowerToken.includes('mount')) {
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
  ): Record<string, { option: RcConfigOption; flagType: SharedProfileType }> {
    const table: Record<string, { option: RcConfigOption; flagType: SharedProfileType }> = {};
    const prefix = remoteType ? `${remoteType.toLowerCase().trim()}-` : '';

    for (const [type, fields] of Object.entries(flagFields)) {
      const flagType = type as SharedProfileType;
      const isRuntimeRemote = flagType === 'runtimeRemote';

      for (const field of fields) {
        const nameRaw = (field.Name ?? '').toLowerCase();
        const nameHyphen = nameRaw.replace(/_/g, '-');
        const keyCamel = (field.FieldName ?? '').toLowerCase();

        const addEntry = (key: string) => {
          if (!key) return;
          const val = { option: field, flagType };
          table[key] = val;
          table[key.replace(/[-_]/g, '')] = val;

          if (isRuntimeRemote && prefix) {
            const prefixed = prefix + key;
            table[prefixed] = val;
            table[prefixed.replace(/[-_]/g, '')] = val;
          }
        };

        addEntry(nameRaw);
        addEntry(nameHyphen);
        addEntry(keyCamel);
      }
    }
    return table;
  }

  isImportCompatible(flagType: SharedProfileType, verb?: string): boolean {
    if (!verb) return true;
    const v = verb.toLowerCase();
    const ft = flagType.toLowerCase();

    if (ft === 'vfs') return v === 'mount' || v === 'serve';
    if (
      ft === 'mount' ||
      ft === 'serve' ||
      ft === 'sync' ||
      ft === 'copy' ||
      ft === 'move' ||
      ft === 'bisync'
    )
      return v === ft;
    return ft === 'filter' || ft === 'backend' || ft === 'runtimeremote';
  }

  classify(
    parsed: ParsedCLI,
    lookupTable: Record<string, { option: RcConfigOption; flagType: SharedProfileType }>
  ): ImportResult {
    const verb = parsed.verb || 'sync';
    const classified: ClassifiedFlag[] = parsed.flags.map(flag => {
      const keyLower = flag.key.toLowerCase();
      const match = lookupTable[keyLower] || lookupTable[keyLower.replace(/[-_]/g, '')];

      if (match) {
        if (this.isImportCompatible(match.flagType, verb)) {
          return {
            flag,
            status: 'mapped',
            flagType: match.flagType,
            fieldName: getControlKey(match.option, match.flagType),
            coercedValue: this.coerceValue(flag.value, match.option.Type),
          };
        }
        return {
          flag,
          status: 'unknown',
          guidance: this.translateService.instant('wizards.cliImport.wrongBlockGuidance', {
            block: match.flagType,
            verb,
          }),
        };
      }
      return { flag, status: 'unknown' };
    });

    return { ...parsed, classified };
  }

  private static readonly INT_TYPES = new Set([
    'int',
    'int64',
    'int32',
    'uint',
    'uint32',
    'uint64',
  ]);
  private static readonly FLOAT_TYPES = new Set(['float', 'float32', 'float64']);

  private coerceValue(val: string | boolean, type: string): unknown {
    if (typeof val === 'boolean') return val;
    if (type === 'bool' || type === 'Tristate') {
      const s = val.toLowerCase().trim();
      return s === 'true' || s === '1' || s === 'yes';
    }
    if (CliFlagMapperService.INT_TYPES.has(type)) {
      const num = parseInt(val, 10);
      return isNaN(num) ? val : num;
    }
    if (CliFlagMapperService.FLOAT_TYPES.has(type)) {
      const num = parseFloat(val);
      return isNaN(num) ? val : num;
    }
    return val;
  }

  async getGlobalLookupTable(
    remoteType?: string
  ): Promise<Record<string, { option: RcConfigOption; flagType: SharedProfileType }>> {
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
        if (f.Type === 'bool' || f.Type === 'Tristate') {
          if (f.Name) {
            bools.add(f.Name.toLowerCase());
            bools.add(f.Name.toLowerCase().replace(/_/g, '-'));
          }
          if (f.FieldName) {
            bools.add(f.FieldName.toLowerCase());
            bools.add(f.FieldName.toLowerCase().replace(/_/g, '-'));
          }
        }
      }
    }
    this.booleanFlagsCache = bools;
    return bools;
  }

  async importCliCommand(cliString: string, remoteType?: string): Promise<ImportResult> {
    const [boolFlags, lookupTable] = await Promise.all([
      this.getBooleanFlags(),
      this.getGlobalLookupTable(remoteType),
    ]);
    return this.classify(this.parse(cliString, boolFlags), lookupTable);
  }
}
