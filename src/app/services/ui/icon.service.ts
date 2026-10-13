import { inject, Injectable } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { MatIconRegistry } from '@angular/material/icon';
import { ADWAITA_ICONS } from './constants/adwaita-icons';
import { BASE_ICONS } from './constants/icon-registry';
import { MIME_EXTENSION_MAP } from './constants/mime-extension-map';
import { getIconForMimeType, getGenericIconForMimeType } from './constants/mime-icon-map';
import { Entry } from '@app/types';

export type FileCategory =
  'image' | 'video' | 'audio' | 'pdf' | 'directory' | 'binary' | 'text' | 'archive';

const ARCHIVE_EXTENSIONS: ReadonlySet<string> = new Set([
  'zip',
  'rar',
  '7z',
  'tar',
  'gz',
  'bz2',
  'xz',
  'tgz',
  'rcman',
]);

const KNOWN_BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  'exe',
  'dll',
  'so',
  'dylib',
  'bin',
  'app',
  'zip',
  'rar',
  '7z',
  'tar',
  'gz',
  'bz2',
  'xz',
  'tgz',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'odt',
  'ods',
  'db',
  'sqlite',
  'mdb',
  'psd',
  'ai',
  'indd',
  'raw',
  'cr2',
  'nef',
  'o',
  'a',
  'lib',
  'class',
  'pyc',
  'jar',
  'img',
  'iso',
  'dmg',
  'qcow',
  'qcow2',
  'vdi',
  'vmdk',
  'vpc',
  'vhdx',
]);

const FILE_TYPE_MAPPINGS: Record<string, string> = {
  image: 'image-x-generic',
  video: 'video-x-generic',
  audio: 'audio-x-generic',
  pdf: 'application-pdf',
  text: 'text-x-generic',
  binary: 'package-x-generic',
  archive: 'package-x-generic',
  directory: 'folder-adw',
};

const FOLDER_ALIASES: Record<string, string> = {
  movies: 'folder-videos',
  node_modules: 'folder-code',
  downloads: 'folder-download',
  home: 'go-home',
};

@Injectable({
  providedIn: 'root',
})
export class IconService {
  private iconRegistry = inject(MatIconRegistry);
  private sanitizer = inject(DomSanitizer);
  private allIcons: Record<string, string> = {};
  private fallbackIcon = 'hard-drive';
  private availableIcons = new Set<string>();
  private normalizedLookup: Record<string, string> = {};

  constructor() {
    this.registerIcons();
    this.buildIconLookup();
  }

  private registerIcons(): void {
    this.allIcons = { ...BASE_ICONS };

    for (const [name, path] of Object.entries(ADWAITA_ICONS)) {
      const lower = name.toLowerCase();
      if (!this.allIcons[lower]) {
        this.allIcons[lower] = path;
      }
    }

    for (const [name, path] of Object.entries(this.allIcons)) {
      const normalizedPath = path.startsWith('/') ? path : `/${path}`;
      this.iconRegistry.addSvgIcon(
        name.toLowerCase(),
        this.sanitizer.bypassSecurityTrustResourceUrl(normalizedPath)
      );
    }
  }

  private buildIconLookup(): void {
    this.availableIcons = new Set(Object.keys(this.allIcons).map(k => k.toLowerCase()));
    this.normalizedLookup = {};

    for (const key of this.availableIcons) {
      const normalized = this.normalizeKey(key);
      if (!this.normalizedLookup[normalized]) {
        this.normalizedLookup[normalized] = key;
      }
    }
  }

  private normalizeKey(key: string): string {
    return key.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  }

  private resolveIcon(name: string): string | null {
    const lower = name.toLowerCase();
    if (this.availableIcons.has(lower)) return lower;

    const normalized = this.normalizeKey(lower);
    return this.normalizedLookup[normalized] || null;
  }

  getIconForEntry(entry?: Entry | null): string {
    if (!entry) return 'folder-adw';
    if (entry.IsDir) {
      const lowerName = entry.Name.toLowerCase();

      const folderKey = `folder-${lowerName}`;
      const resolved = this.resolveIcon(folderKey);
      if (resolved) return resolved;

      if (FOLDER_ALIASES[lowerName]) return FOLDER_ALIASES[lowerName];

      return 'folder-adw';
    }

    const rawMime = entry.MimeType ? entry.MimeType.split(';')[0].trim().toLowerCase() : '';
    const parts = entry.Name.split('.');
    const extension = parts.length > 1 ? parts.pop()?.toLowerCase() : undefined;

    if (extension && MIME_EXTENSION_MAP[extension]) {
      const extIcon = MIME_EXTENSION_MAP[extension];
      const resolved = this.resolveIcon(extIcon);
      if (resolved) return resolved;
    }

    if (rawMime) {
      const mimeIcon = getIconForMimeType(rawMime);
      if (mimeIcon) {
        const resolved = this.resolveIcon(mimeIcon);
        if (resolved) return resolved;
      }

      const resolvedMime = this.resolveIcon(rawMime);
      if (resolvedMime) return resolvedMime;

      const genericIcon = getGenericIconForMimeType(rawMime);
      const resolvedGeneric = this.resolveIcon(genericIcon);
      if (resolvedGeneric) return resolvedGeneric;
    }

    return 'text-x-generic';
  }

  public getFileTypeCategory(item: Entry): FileCategory {
    if (item.IsDir) {
      return 'directory';
    }

    const mimeType = item.MimeType;
    const extension = item.Name.split('.').pop()?.toLowerCase() || '';

    if (mimeType?.startsWith('image/')) return 'image';
    if (mimeType?.startsWith('video/')) return 'video';
    if (mimeType?.startsWith('audio/')) return 'audio';
    if (mimeType === 'application/pdf') return 'pdf';
    if (mimeType?.startsWith('text/')) return 'text';

    if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico'].includes(extension))
      return 'image';
    if (['mp4', 'webm', 'ogg', 'mov', 'avi', 'mkv'].includes(extension)) return 'video';
    if (['mp3', 'wav', 'flac', 'aac', 'm4a'].includes(extension)) return 'audio';
    if (extension === 'pdf') return 'pdf';

    if (ARCHIVE_EXTENSIONS.has(extension)) return 'archive';

    if (KNOWN_BINARY_EXTENSIONS.has(extension)) {
      return 'binary';
    }

    return 'text';
  }

  getIconName(name: string | undefined | null): string {
    if (!name) return this.fallbackIcon;
    return this.resolveIcon(name) || this.fallbackIcon;
  }

  getIconForFileType(fileType: string): string {
    return FILE_TYPE_MAPPINGS[fileType] || 'text-x-generic';
  }
}
