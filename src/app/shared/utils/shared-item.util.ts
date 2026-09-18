import { Entry, FileBrowserItem } from '@app/types';

export type ShareKind =
  | 'gdrive-shortcut'
  | 'onedrive-remote'
  | 'rclonelink'
  | 'os-shortcut'
  | 'shared-root'
  | 'metadata-shared';

export interface ItemShareInfo {
  isShared: boolean;
  isShortcut: boolean;
  kind?: ShareKind;
  tooltipKey: string;
  targetId?: string;
}

const NOT_SHARED: ItemShareInfo = {
  isShared: false,
  isShortcut: false,
  tooltipKey: '',
};

/**
 * Splits a composite Google Drive ID formatted as `actualID\tshortcutID`.
 * In Rclone's drive backend, shortcuts resolved in `drive.go` are joined with `\t`.
 */
export function splitGoogleDriveId(compositeId?: string | null): {
  actualId: string;
  shortcutId: string;
} | null {
  if (!compositeId || typeof compositeId !== 'string') return null;
  const tabIndex = compositeId.indexOf('\t');
  if (tabIndex === -1) return null;
  return {
    actualId: compositeId.slice(0, tabIndex),
    shortcutId: compositeId.slice(tabIndex + 1),
  };
}

/**
 * Splits a normalized OneDrive remote item ID formatted as `DriveID#ItemID`.
 * In Rclone's onedrive backend, items shared from another drive/account are prefixed with `DriveID#`.
 */
export function splitOneDriveId(normalizedId?: string | null): {
  driveId: string;
  itemId: string;
} | null {
  if (!normalizedId || typeof normalizedId !== 'string') return null;
  const hashIndex = normalizedId.indexOf('#');
  if (hashIndex === -1) return null;
  return {
    driveId: normalizedId.slice(0, hashIndex),
    itemId: normalizedId.slice(hashIndex + 1),
  };
}

/**
 * Analyzes an entry and its remote context to determine if it is a shared item,
 * shortcut, remote drive item, or link.
 */
export function getShareInfo(
  itemOrEntry?: FileBrowserItem | Entry | null,
  remoteType?: string | null,
  remoteName?: string | null
): ItemShareInfo {
  if (!itemOrEntry) return NOT_SHARED;

  // Normalize input: extract entry and meta
  const entry: Entry = 'entry' in itemOrEntry ? itemOrEntry.entry : itemOrEntry;
  if (!entry) return NOT_SHARED;

  const meta = 'meta' in itemOrEntry ? itemOrEntry.meta : undefined;
  const actualRemoteType = (meta?.remoteType ?? remoteType ?? '').toLowerCase();
  const actualRemoteName = (meta?.remote ?? remoteName ?? '').toLowerCase();

  // 1. Google Drive Shortcuts (Composite ID containing \t or Google Shortcut MIME)
  if (entry.ID && entry.ID.includes('\t')) {
    const split = splitGoogleDriveId(entry.ID);
    return {
      isShared: true,
      isShortcut: true,
      kind: 'gdrive-shortcut',
      tooltipKey: 'nautilus.shared.shortcutTooltip',
      targetId: split?.actualId,
    };
  }

  if (
    entry.MimeType &&
    entry.MimeType.toLowerCase().startsWith('application/vnd.google-apps.shortcut')
  ) {
    return {
      isShared: true,
      isShortcut: true,
      kind: 'gdrive-shortcut',
      tooltipKey: 'nautilus.shared.shortcutTooltip',
      targetId: entry.ID,
    };
  }

  // 2. Microsoft OneDrive / SharePoint Remote Shared Items (DriveID#ItemID)
  if (actualRemoteType === 'onedrive' && entry.ID && entry.ID.includes('#')) {
    const split = splitOneDriveId(entry.ID);
    return {
      isShared: true,
      isShortcut: true,
      kind: 'onedrive-remote',
      tooltipKey: 'nautilus.shared.onedriveRemoteTooltip',
      targetId: split?.itemId,
    };
  }

  // 3. Rclone universal symlinks (.rclonelink) and OS shortcuts (.lnk, .desktop)
  const name = (entry.Name ?? '').toLowerCase();
  if (name.endsWith('.rclonelink')) {
    return {
      isShared: false,
      isShortcut: true,
      kind: 'rclonelink',
      tooltipKey: 'nautilus.shared.linkTooltip',
    };
  }

  if (name.endsWith('.lnk') || name.endsWith('.desktop')) {
    return {
      isShared: false,
      isShortcut: true,
      kind: 'os-shortcut',
      tooltipKey: 'nautilus.shared.shortcutTooltip',
    };
  }

  // 4. Remote operating under a shared virtual root (shared_with_me, shared_folders, shared_files)
  if (
    actualRemoteName.includes('shared_with_me') ||
    actualRemoteName.includes('shared_folders') ||
    actualRemoteName.includes('shared_files')
  ) {
    return {
      isShared: true,
      isShortcut: false,
      kind: 'shared-root',
      tooltipKey: 'nautilus.shared.sharedItemTooltip',
    };
  }

  // 5. Rclone Metadata (if available from get_stat or metadata option)
  const md = entry.Metadata;
  if (md) {
    const isMetadataShared =
      Boolean(md['shared-owner-id']) ||
      Boolean(md['shared-by-id']) ||
      md['shared'] === 'true' ||
      md['isshared'] === 'true' ||
      Boolean(md['sharing-user-name']) ||
      Boolean(md['drive-sharing-user-name']) ||
      Boolean(md['shared-with-me']) ||
      Boolean(md['drive-shared-with-me-time']);

    if (isMetadataShared) {
      return {
        isShared: true,
        isShortcut: false,
        kind: 'metadata-shared',
        tooltipKey: 'nautilus.shared.sharedItemTooltip',
      };
    }
  }

  return NOT_SHARED;
}

/**
 * Quick boolean check if an item is a shortcut or shared item.
 */
export function isSharedOrShortcut(
  itemOrEntry?: FileBrowserItem | Entry | null,
  remoteType?: string | null,
  remoteName?: string | null
): boolean {
  const info = getShareInfo(itemOrEntry, remoteType, remoteName);
  return info.isShared || info.isShortcut;
}
