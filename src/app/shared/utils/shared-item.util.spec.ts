import { describe, it, expect } from 'vitest';
import {
  splitGoogleDriveId,
  splitOneDriveId,
  getShareInfo,
  isSharedOrShortcut,
} from './shared-item.util';
import { Entry, FileBrowserItem } from '@app/types';

describe('shared-item.util', () => {
  describe('splitGoogleDriveId', () => {
    it('should correctly split composite tab ID into actual and shortcut IDs', () => {
      const result = splitGoogleDriveId(
        '150Q5UizRpHWb0I90hQ5DCC2NVD-udeR1\t19R2fmFZTJNy5ItcTfrmIYLrY06kf_T8X'
      );
      expect(result).toEqual({
        actualId: '150Q5UizRpHWb0I90hQ5DCC2NVD-udeR1',
        shortcutId: '19R2fmFZTJNy5ItcTfrmIYLrY06kf_T8X',
      });
    });

    it('should return null for non-composite IDs', () => {
      expect(splitGoogleDriveId('1QtefyjbqV5_v3r57ciYwn_Sm8Ksnahdk')).toBeNull();
    });

    it('should return null for empty or invalid inputs', () => {
      expect(splitGoogleDriveId(null)).toBeNull();
      expect(splitGoogleDriveId(undefined)).toBeNull();
      expect(splitGoogleDriveId('')).toBeNull();
    });
  });

  describe('splitOneDriveId', () => {
    it('should correctly split normalized remote OneDrive ID with # separator', () => {
      const result = splitOneDriveId('b!abc123driveid#01ABCDEFITEMID');
      expect(result).toEqual({
        driveId: 'b!abc123driveid',
        itemId: '01ABCDEFITEMID',
      });
    });

    it('should return null for IDs without #', () => {
      expect(splitOneDriveId('01ABCDEFITEMID')).toBeNull();
    });

    it('should return null for empty or invalid inputs', () => {
      expect(splitOneDriveId(null)).toBeNull();
      expect(splitOneDriveId('')).toBeNull();
    });
  });

  describe('getShareInfo', () => {
    it('should detect Google Drive shortcuts via composite ID', () => {
      const entry: Entry = {
        ID: 'actual-id-123\tshortcut-id-456',
        IsDir: true,
        MimeType: 'inode/directory',
        ModTime: '2024-10-14T14:15:27.922Z',
        Name: 'SharedFolder',
        Path: 'SharedFolder',
        Size: 0,
      };

      const info = getShareInfo(entry, 'drive', 'Google Drive:');
      expect(info.isShared).toBe(true);
      expect(info.isShortcut).toBe(true);
      expect(info.kind).toBe('gdrive-shortcut');
      expect(info.targetId).toBe('actual-id-123');
    });

    it('should detect Google Drive shortcut via MimeType', () => {
      const entry: Entry = {
        ID: 'single-id-789',
        IsDir: false,
        MimeType: 'application/vnd.google-apps.shortcut',
        ModTime: '2024-10-14T14:15:27.922Z',
        Name: 'ShortcutToDoc',
        Path: 'ShortcutToDoc',
        Size: 0,
      };

      const info = getShareInfo(entry, 'drive');
      expect(info.isShared).toBe(true);
      expect(info.isShortcut).toBe(true);
      expect(info.kind).toBe('gdrive-shortcut');
    });

    it('should detect OneDrive remote shared item via # separator when remoteType is onedrive', () => {
      const item: FileBrowserItem = {
        entry: {
          ID: 'drive-999#item-888',
          IsDir: true,
          MimeType: 'inode/directory',
          ModTime: '2024-10-14T14:15:27.922Z',
          Name: 'ForeignSharedFolder',
          Path: 'ForeignSharedFolder',
          Size: 0,
        },
        meta: {
          remote: 'onedrive:',
          isLocal: false,
          remoteType: 'onedrive',
        },
      };

      const info = getShareInfo(item);
      expect(info.isShared).toBe(true);
      expect(info.isShortcut).toBe(true);
      expect(info.kind).toBe('onedrive-remote');
      expect(info.targetId).toBe('item-888');
    });

    it('should not mark # in ID as onedrive-remote if remoteType is not onedrive', () => {
      const item: FileBrowserItem = {
        entry: {
          ID: 'some#id',
          IsDir: true,
          MimeType: 'inode/directory',
          ModTime: '2024-10-14T14:15:27.922Z',
          Name: 'FolderWithHash',
          Path: 'FolderWithHash',
          Size: 0,
        },
        meta: {
          remote: 'sftp:',
          isLocal: false,
          remoteType: 'sftp',
        },
      };

      const info = getShareInfo(item);
      expect(info.isShared).toBe(false);
      expect(info.isShortcut).toBe(false);
    });

    it('should detect .rclonelink files as rclonelink shortcut', () => {
      const entry: Entry = {
        ID: '123',
        IsDir: false,
        MimeType: 'application/octet-stream',
        ModTime: '2024-10-14T14:15:27.922Z',
        Name: 'project-link.txt.rclonelink',
        Path: 'project-link.txt.rclonelink',
        Size: 45,
      };

      const info = getShareInfo(entry);
      expect(info.isShortcut).toBe(true);
      expect(info.kind).toBe('rclonelink');
    });

    it('should detect OS shortcuts (.lnk, .desktop) and ignore .url', () => {
      const lnkEntry: Entry = {
        ID: '123',
        IsDir: false,
        MimeType: 'application/x-ms-shortcut',
        ModTime: '2024-10-14T14:15:27.922Z',
        Name: 'AppShortcut.lnk',
        Path: 'AppShortcut.lnk',
        Size: 1024,
      };

      const info = getShareInfo(lnkEntry);
      expect(info.isShortcut).toBe(true);
      expect(info.kind).toBe('os-shortcut');

      const desktopEntry = { ...lnkEntry, Name: 'App.desktop', Path: 'App.desktop' };
      expect(getShareInfo(desktopEntry).isShortcut).toBe(true);

      const urlEntry = { ...lnkEntry, Name: 'Website.URL', Path: 'Website.URL' };
      expect(getShareInfo(urlEntry).isShortcut).toBe(false);
    });

    it('should detect items in shared virtual roots (shared_with_me, shared_folders, shared_files)', () => {
      const item: FileBrowserItem = {
        entry: {
          ID: 'regular-id-555',
          IsDir: true,
          MimeType: 'inode/directory',
          ModTime: '2024-10-14T14:15:27.922Z',
          Name: 'SharedFromFriend',
          Path: 'SharedFromFriend',
          Size: 0,
        },
        meta: {
          remote: 'Google Drive,shared_with_me:',
          isLocal: false,
          remoteType: 'drive',
        },
      };

      const info = getShareInfo(item);
      expect(info.isShared).toBe(true);
      expect(info.kind).toBe('shared-root');
    });

    it('should detect shared items via Rclone Metadata', () => {
      const entryWithOwner: Entry = {
        ID: 'file-123',
        IsDir: false,
        MimeType: 'application/pdf',
        ModTime: '2024-10-14T14:15:27.922Z',
        Name: 'Doc.pdf',
        Path: 'Doc.pdf',
        Size: 1024,
        Metadata: {
          'shared-owner-id': 'user-456',
          'shared-owner-name': 'Alice Smith',
          'shared-by-name': 'Bob Jones',
          'shared-with-me': '2024-10-14T14:15:27.922Z',
        },
      };

      const info = getShareInfo(entryWithOwner);
      expect(info.isShared).toBe(true);
      expect(info.kind).toBe('metadata-shared');

      const entryWithGoogleDriveSharing: Entry = {
        ID: 'drive-doc-123',
        IsDir: false,
        MimeType: 'application/pdf',
        ModTime: '2024-10-14T14:15:27.922Z',
        Name: 'DriveDoc.pdf',
        Path: 'DriveDoc.pdf',
        Size: 1024,
        Metadata: {
          'drive-owners': 'Charlie Brown',
          'drive-sharing-user-name': 'Diana Prince',
          'drive-shared-with-me-time': '2024-11-01T10:00:00Z',
        },
      };

      const gdriveInfo = getShareInfo(entryWithGoogleDriveSharing, 'drive');
      expect(gdriveInfo.isShared).toBe(true);
      expect(gdriveInfo.kind).toBe('metadata-shared');

      const entryWithSharedTrue: Entry = {
        ...entryWithOwner,
        Metadata: { shared: 'true' },
      };
      expect(getShareInfo(entryWithSharedTrue).isShared).toBe(true);
    });

    it('should return false for regular unshared items', () => {
      const regularEntry: Entry = {
        ID: '1QtefyjbqV5_v3r57ciYwn_Sm8Ksnahdk',
        IsDir: true,
        MimeType: 'inode/directory',
        ModTime: '2025-09-25T13:18:10.951Z',
        Name: 'App Keys',
        Path: 'App Keys',
        Size: 0,
      };

      const info = getShareInfo(regularEntry, 'drive', 'Google Drive:');
      expect(info.isShared).toBe(false);
      expect(info.isShortcut).toBe(false);
      expect(info.kind).toBeUndefined();
    });

    it('should gracefully handle null or undefined input', () => {
      expect(getShareInfo(null).isShared).toBe(false);
      expect(getShareInfo(undefined).isShared).toBe(false);
    });
  });

  describe('isSharedOrShortcut', () => {
    it('should return true for shared items or shortcuts, false for regular items', () => {
      expect(
        isSharedOrShortcut({
          ID: 'actual\tshortcut',
          IsDir: true,
          MimeType: 'inode/directory',
          ModTime: '',
          Name: 'SharedFolder',
          Path: 'SharedFolder',
          Size: 0,
        })
      ).toBe(true);

      expect(
        isSharedOrShortcut({
          ID: 'normal-id',
          IsDir: true,
          MimeType: 'inode/directory',
          ModTime: '',
          Name: 'NormalFolder',
          Path: 'NormalFolder',
          Size: 0,
        })
      ).toBe(false);
    });
  });
});
