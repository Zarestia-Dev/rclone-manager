import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExplorerRoot, FileBrowserItem } from '@app/types';
import { NautilusComponent } from './nautilus.component';

describe('Nautilus folder navigation', () => {
  const roots: ExplorerRoot[] = [
    { name: 'C:\\', label: 'Windows', type: 'local', isLocal: true },
    { name: '/', label: 'Unix', type: 'local', isLocal: true },
    { name: '/mnt/data', label: 'Mounted volume', type: 'local', isLocal: true },
    { name: 'drive', label: 'Cloud', type: 'drive', isLocal: false },
  ];
  const pane = { remote: null as ExplorerRoot | null };
  const tabSvc = {
    activeTabIndex: (): number => 0,
    activePaneIndex: vi.fn(() => 0),
    tabs: (): { left: typeof pane; right: typeof pane }[] => [{ left: pane, right: pane }],
    createTab: vi.fn(),
  };
  const context = {
    tabSvc,
    nautilusService: { lookupRemoteByName: vi.fn() },
    navigate: vi.fn(),
    notificationService: { showError: vi.fn() },
    translate: { instant: vi.fn((key: string) => key) },
  };

  const folder = (root: ExplorerRoot, path: string): FileBrowserItem => ({
    entry: {
      ID: '',
      Name: 'Folder',
      Path: path,
      IsDir: true,
      Size: -1,
      ModTime: '',
      MimeType: 'inode/directory',
    },
    meta: { remote: root.name, isLocal: root.isLocal },
  });

  function open(item: FileBrowserItem, newTab = false): void {
    NautilusComponent.prototype['navigateTo'].call(
      context as unknown as NautilusComponent,
      item,
      newTab
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    pane.remote = null;
    tabSvc.activePaneIndex.mockReturnValue(0);
    context.nautilusService.lookupRemoteByName.mockImplementation(
      (name: string) => roots.find(root => root.name === name) ?? null
    );
  });

  for (const root of roots) {
    for (const path of ['', 'Users/Test/My files #1/ç']) {
      it.each([0, 1])(`opens starred ${root.name}:${path} in pane %s`, paneIndex => {
        tabSvc.activePaneIndex.mockReturnValue(paneIndex);
        open(folder(root, path));
        expect(context.navigate).toHaveBeenCalledExactlyOnceWith(root, path, true);
      });

      it(`opens starred ${root.name}:${path} in a new tab`, () => {
        open(folder(root, path), true);
        expect(tabSvc.createTab).toHaveBeenCalledExactlyOnceWith(root, path);
        expect(context.navigate).not.toHaveBeenCalled();
      });
    }
  }

  it('preserves the root when navigating an ordinary folder', () => {
    pane.remote = roots[0];
    open(folder(roots[0], 'Users/Test'));
    expect(context.navigate).toHaveBeenCalledExactlyOnceWith(roots[0], 'Users/Test', true);
  });

  it.each([false, true])('reports an unavailable starred root (new tab: %s)', newTab => {
    open(folder({ ...roots[3], name: 'removed' }, 'folder'), newTab);
    expect(context.notificationService.showError).toHaveBeenCalledOnce();
    expect(context.navigate).not.toHaveBeenCalled();
    expect(tabSvc.createTab).not.toHaveBeenCalled();
  });
});

describe('Nautilus paste destination', () => {
  const remote: ExplorerRoot = { name: '/', label: 'Unix', type: 'local', isLocal: true };
  const target: FileBrowserItem = {
    entry: {
      ID: '',
      Name: 'files',
      Path: 'home/test/files',
      IsDir: true,
      Size: -1,
      ModTime: '',
      MimeType: '',
    },
    meta: { remote: '/', isLocal: true },
  };
  const context = {
    actions: { contextMenuItem: vi.fn() },
    tabSvc: { activeRemote: vi.fn(), activePath: (): string => 'other', refreshPath: vi.fn() },
    nautilusService: { lookupRemoteByName: vi.fn() },
    fileOps: { pasteItems: vi.fn() },
    allRemotesLookup: (): ExplorerRoot[] => [remote],
  };
  beforeEach(() => {
    vi.clearAllMocks();
    context.actions.contextMenuItem.mockReturnValue(null);
    context.tabSvc.activeRemote.mockReturnValue(null);
    context.nautilusService.lookupRemoteByName.mockReturnValue(remote);
  });
  it.each([true, false])(
    'uses the complete starred target location (explicit target: %s)',
    async explicit => {
      if (!explicit) context.actions.contextMenuItem.mockReturnValue(target);
      await NautilusComponent.prototype['pasteItems'].call(
        context as unknown as NautilusComponent,
        explicit ? target : undefined
      );
      expect(context.fileOps.pasteItems).toHaveBeenCalledExactlyOnceWith(
        remote,
        target.entry.Path,
        [remote]
      );
      expect(context.tabSvc.refreshPath).toHaveBeenCalledWith('/', target.entry.Path);
    }
  );
  it('pastes into the current directory when no folder is targeted', async () => {
    context.tabSvc.activeRemote.mockReturnValue(remote);
    await NautilusComponent.prototype['pasteItems'].call(context as unknown as NautilusComponent);
    expect(context.fileOps.pasteItems).toHaveBeenCalledExactlyOnceWith(remote, 'other', [remote]);
  });
  it('does not paste into the virtual starred background', async () => {
    await NautilusComponent.prototype['pasteItems'].call(context as unknown as NautilusComponent);
    expect(context.fileOps.pasteItems).not.toHaveBeenCalled();
  });
  it('does not fall back to the current root when the target is unavailable', async () => {
    context.tabSvc.activeRemote.mockReturnValue(remote);
    context.nautilusService.lookupRemoteByName.mockReturnValue(null);
    await NautilusComponent.prototype['pasteItems'].call(
      context as unknown as NautilusComponent,
      target
    );
    expect(context.fileOps.pasteItems).not.toHaveBeenCalled();
  });
});
