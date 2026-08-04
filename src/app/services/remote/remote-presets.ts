import { Injectable, inject } from '@angular/core';
import { BackendService } from '../infrastructure/system/backend.service';

export type StorageFamily = 's3' | 'webdav' | 'generic';

export interface PresetValues {
  vfs?: Record<string, unknown>; // VFS option overrides
  mount?: Record<string, unknown>; // Mount option overrides
  backend?: Record<string, unknown>; // global backend flag overrides (e.g. BufferSize, DisableHTTP2)
  remote?: Record<string, unknown>; // remote-specific config overrides (e.g. disable_checksum)
}

// Remote type → storage family mapping
const REMOTE_FAMILY_MAP: Record<string, StorageFamily> = {
  s3: 's3',
  b2: 's3',
  gcs: 's3',
  googlecloudstorage: 's3',
  webdav: 'webdav',
};

// Base presets (applied to ALL remotes regardless of type)
const BASE_PRESET: PresetValues = {
  vfs: {
    CacheMode: 'full',
    CacheMaxSize: '250G',
    CacheMinFreeSpace: '10G',
    CacheMaxAge: '48h',
    WriteBack: '15s',
    ChunkSize: '16M',
    ChunkStreams: 8,
    ReadAhead: '128M',
    Refresh: true,
  },
  mount: {
    AttrTimeout: '10s',
  },
  backend: {
    BufferSize: '32M',
    MaxBufferMemory: '2G',
    LogLevel: 'INFO',
    Transfers: 8,
  },
};

// Family-specific overrides (merged on top of BASE)
const FAMILY_PRESETS: Record<StorageFamily, PresetValues> = {
  s3: {
    backend: {
      DisableHTTP2: true,
      UseServerModTime: true,
    },
    vfs: {
      FastFingerprint: true,
    },
  },
  webdav: {
    vfs: {
      WriteBack: '20s',
    },
  },
  generic: {},
};

// Provider-specific remote configuration overrides
const PROVIDER_REMOTE_PRESETS: Record<string, PresetValues> = {
  s3: {
    remote: {
      disable_checksum: true,
      upload_concurrency: 8,
      chunk_size: '32M',
    },
  },
  b2: {
    remote: {
      disable_checksum: true,
      upload_concurrency: 8,
      chunk_size: '32M',
    },
  },
};

// Vendor-specific remote presets (provider -> vendor mapping)
const VENDOR_PRESETS: Record<string, Record<string, PresetValues>> = {
  webdav: {
    nextcloud: {
      remote: {
        nextcloud_chunk_size: '64M',
      },
    },
    owncloud: {
      remote: {
        nextcloud_chunk_size: '64M',
      },
    },
  },
};

// OS-specific configuration overrides
const OS_PRESETS: Record<'windows' | 'macos' | 'linux' | 'android', PresetValues> = {
  windows: {
    mount: { NetworkMode: true },
  },
  macos: {
    mount: {
      NoAppleXattr: true,
      NoAppleDouble: true,
    },
  },
  linux: {},
  android: {
    vfs: {
      CacheMode: 'full',
      CacheMaxSize: '50G',
      CacheMinFreeSpace: '2G',
      CacheMaxAge: '24h',
      WriteBack: '10s',
    },
    mount: {
      mountType: 'saf',
    },
  },
};

// OS matching rules (ordered by priority to avoid 'darwin' matching 'win')
const OS_PRESET_RULES: { matches: (os: string) => boolean; preset: PresetValues }[] = [
  {
    matches: (os: string) => os.includes('android'),
    preset: OS_PRESETS.android,
  },
  {
    matches: (os: string) => os.includes('darwin') || os.includes('mac') || os.includes('ios'),
    preset: OS_PRESETS.macos,
  },
  {
    matches: (os: string) => os.startsWith('win') || os.includes('windows'),
    preset: OS_PRESETS.windows,
  },
  {
    matches: () => true, // Fallback default (linux)
    preset: OS_PRESETS.linux,
  },
];

// Helper to perform deep merge of preset objects
function mergePresets(target: PresetValues, source: PresetValues): PresetValues {
  return {
    vfs: { ...target.vfs, ...source.vfs },
    mount: { ...target.mount, ...source.mount },
    backend: { ...target.backend, ...source.backend },
    remote: { ...target.remote, ...source.remote },
  };
}

@Injectable({
  providedIn: 'root',
})
export class RemotePresetsService {
  private readonly backendService = inject(BackendService);

  /**
   * Returns the storage family classification for a given remote type.
   */
  getStorageFamily(remoteType: string): StorageFamily {
    if (!remoteType) return 'generic';
    return REMOTE_FAMILY_MAP[remoteType.toLowerCase().replace(/\s+/g, '')] || 'generic';
  }

  getTargetPlatform(): string {
    return (
      this.backendService.backends().find(b => b.name === this.backendService.activeBackend())
        ?.os || 'linux'
    ).toLowerCase();
  }

  /**
   * Resolves the merged presets based on the remote type and target OS/platform.
   */
  resolvePresets(remoteType: string, vendor?: string): PresetValues {
    let merged = { ...BASE_PRESET };

    const family = this.getStorageFamily(remoteType);
    if (FAMILY_PRESETS[family]) merged = mergePresets(merged, FAMILY_PRESETS[family]);

    const typeLower = remoteType.toLowerCase().replace(/\s+/g, '');
    if (PROVIDER_REMOTE_PRESETS[typeLower]) {
      merged = mergePresets(merged, PROVIDER_REMOTE_PRESETS[typeLower]);
    }

    if (vendor) {
      const vendorLower = vendor.toLowerCase().replace(/\s+/g, '');
      const vendorPreset = VENDOR_PRESETS[typeLower]?.[vendorLower];
      if (vendorPreset) merged = mergePresets(merged, vendorPreset);
    }

    const osPlatform = this.getTargetPlatform();
    const matchedRule = OS_PRESET_RULES.find(rule => rule.matches(osPlatform));
    if (matchedRule) merged = mergePresets(merged, matchedRule.preset);

    return merged;
  }
}
