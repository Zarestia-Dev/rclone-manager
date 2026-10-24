import { Injectable, inject } from '@angular/core';
import { RcConfigOption, SharedProfileType } from '@app/types';
import { FlagConfigService } from './flag-config.service';
import { RemoteManagementService } from './remote-management.service';
import { RcloneValueMapperService } from './rclone-value-mapper.service';

import * as cliParser from '../../shared/utils/cli-parser.util';
import { ParsedCLI, SHORT_FLAG_ALIASES } from '../../shared/utils/cli-parser.util';

export type FlagStatus = 'mapped' | 'unknown';

export interface ClassifiedFlag {
  flag: cliParser.ParsedCLIFlag;
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

export interface LookupEntry {
  option: RcConfigOption;
  flagType: SharedProfileType;
  supportedFlagTypes: Set<SharedProfileType>;
}

@Injectable({ providedIn: 'root' })
export class CliFlagMapperService {
  private flagConfigService = inject(FlagConfigService);
  private remoteManagementService = inject(RemoteManagementService);
  private valueMapper = inject(RcloneValueMapperService);

  private booleanFlagsCache: Set<string> | null = null;
  private readonly lookupTablesCache = new Map<string, Record<string, LookupEntry>>();

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
        const coercedValue = isNegated
          ? false
          : this.valueMapper.humanToMachine(flag.value, match.option.Type);
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
    return this.classify(cliParser.parseCLI(cliString, boolFlags), lookupTable, preferredType);
  }
}
