import { inject, Injectable } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { MatIconRegistry } from '@angular/material/icon';
import { ADWAITA_ICONS } from './adwaita-icons';
import { BASE_ICONS } from './icon-registry';
import { MIME_EXTENSION_MAP } from './mime-extension-map';
import { getIconForMimeType, getGenericIconForMimeType } from './mime-icon-map';
import { Entry } from '@app/types';

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
    // Start with base icons, then add Adwaita icons
    this.allIcons = { ...BASE_ICONS };

    for (const [name, path] of Object.entries(ADWAITA_ICONS)) {
      const lower = name.toLowerCase();
      // Prefer base icons if key conflicts
      if (!this.allIcons[lower]) {
        this.allIcons[lower] = path;
      }
    }

    // Register all icons with MatIconRegistry
    for (const [name, path] of Object.entries(this.allIcons)) {
      this.iconRegistry.addSvgIcon(
        name.toLowerCase(),
        this.sanitizer.bypassSecurityTrustResourceUrl(path)
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

  getIconForEntry(entry: Entry): string {
    if (entry.IsDir) {
      const lowerName = entry.Name.toLowerCase();

      // Special folder cases
      const folderKey = `folder-${lowerName}`;
      const resolved = this.resolveIcon(folderKey);
      if (resolved) return resolved;

      // Common folder aliases
      const aliases: Record<string, string> = {
        movies: 'folder-videos',
        node_modules: 'folder-code',
        downloads: 'folder-download',
        home: 'go-home',
      };
      if (aliases[lowerName]) return aliases[lowerName];

      return 'folder-adw';
    }

    const rawMime = entry.MimeType ? entry.MimeType.split(';')[0].trim().toLowerCase() : '';
    const parts = entry.Name.split('.');
    const extension = parts.length > 1 ? parts.pop()?.toLowerCase() : undefined;

    // 1) Extension mapping
    if (extension && MIME_EXTENSION_MAP[extension]) {
      const extIcon = MIME_EXTENSION_MAP[extension];
      const resolved = this.resolveIcon(extIcon);
      if (resolved) return resolved;
    }

    // 2) MIME mapping
    if (rawMime) {
      const mimeIcon = getIconForMimeType(rawMime);
      if (mimeIcon) {
        const resolved = this.resolveIcon(mimeIcon);
        if (resolved) return resolved;
      }

      // 3) Normalized MIME (application/json -> application-json)
      const resolvedMime = this.resolveIcon(rawMime);
      if (resolvedMime) return resolvedMime;

      // 4) Generic category fallback
      const genericIcon = getGenericIconForMimeType(rawMime);
      const resolvedGeneric = this.resolveIcon(genericIcon);
      if (resolvedGeneric) return resolvedGeneric;
    }

    return 'text-x-generic';
  }

  public getFileTypeCategory(item: Entry): string {
    if (item.IsDir) return 'directory';
    const mimeType = item.MimeType;
    if (mimeType?.startsWith('image/')) return 'image';
    if (mimeType?.startsWith('video/')) return 'video';
    if (mimeType?.startsWith('audio/')) return 'audio';
    if (mimeType === 'application/pdf') return 'pdf';
    return 'file';
  }

  getIconName(name: string | undefined | null): string {
    if (!name) return this.fallbackIcon;
    return this.resolveIcon(name) || this.fallbackIcon;
  }

  getIconForFileType(fileType: string): string {
    const mapping: Record<string, string> = {
      image: 'image-x-generic',
      video: 'video-x-generic',
      audio: 'audio-x-generic',
      pdf: 'application-pdf',
      text: 'text-x-generic',
      binary: 'package-x-generic',
    };
    return mapping[fileType] || 'text-x-generic';
  }
}
