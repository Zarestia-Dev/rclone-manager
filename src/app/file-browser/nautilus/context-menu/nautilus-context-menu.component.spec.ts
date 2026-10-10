import { describe, expect, it, vi } from 'vitest';
import { ExplorerRoot, FileBrowserItem } from '@app/types';
import { NautilusContextMenuComponent } from './nautilus-context-menu.component';

describe('Nautilus context menu paths', () => {
  it.each(['/', '/mnt/data', 'C:\\', 'drive'])(
    'formats the item root %s instead of the panel root',
    remote => {
      const item: FileBrowserItem = {
        entry: {
          ID: '',
          Name: 'file.txt',
          Path: 'folder/file.txt',
          IsDir: false,
          Size: 1,
          ModTime: '',
          MimeType: '',
        },
        meta: { remote, isLocal: remote !== 'drive', remoteType: 'test' },
      };
      const format = vi.fn((_root: ExplorerRoot, _path: string): string => 'full path');
      const context = { pathService: { getFullDisplayPath: format } };
      expect(
        NautilusContextMenuComponent.prototype['getFormattedPath'].call(
          context as unknown as NautilusContextMenuComponent,
          item
        )
      ).toBe('full path');
      expect(format).toHaveBeenCalledExactlyOnceWith(
        { name: remote, isLocal: item.meta.isLocal, label: remote, type: 'test' },
        item.entry.Path
      );
    }
  );
  it('copies the current location when no item is selected', () => {
    const context = { fullPathInput: (): string => '/home/test' };
    expect(
      NautilusContextMenuComponent.prototype['getFormattedPath'].call(
        context as unknown as NautilusContextMenuComponent,
        null
      )
    ).toBe('/home/test');
  });
});
