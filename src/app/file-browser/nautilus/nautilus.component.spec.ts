import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
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

describe('Nautilus split divider gestures', () => {
  const context = {
    tabSvc: { splitDividerPos: signal(50) },
    settings: { saveSplitDividerPos: vi.fn() },
    _splitDragCleanup: undefined as (() => void) | undefined,
  };
  let container: HTMLElement;
  let divider: HTMLElement;
  let previousCursor: string;

  function pointer(type: string, x: number, pointerId = 1, button = 0): PointerEvent {
    return Object.assign(
      new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, button }),
      { pointerId }
    ) as PointerEvent;
  }

  function start(x = 300, pointerId = 1, button = 0): void {
    divider.dispatchEvent(pointer('pointerdown', x, pointerId, button));
  }

  beforeEach(() => {
    context.tabSvc.splitDividerPos.set(50);
    context.settings.saveSplitDividerPos.mockClear();
    previousCursor = document.body.style.cursor;
    document.body.style.cursor = 'crosshair';
    container = document.createElement('div');
    divider = document.createElement('div');
    container.appendChild(divider);
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 0, 400, 300));
    divider.addEventListener('pointerdown', event => {
      NautilusComponent.prototype.onSplitDividerDrag.call(
        context as unknown as NautilusComponent,
        event as PointerEvent
      );
    });
  });

  afterEach(() => {
    context._splitDragCleanup?.();
    document.body.style.cursor = previousCursor;
    vi.restoreAllMocks();
  });

  it('resizes relative to the container and saves the final release position once', () => {
    start();
    window.dispatchEvent(pointer('pointermove', 340));
    expect(context.tabSvc.splitDividerPos()).toBe(60);
    expect(context.settings.saveSplitDividerPos).not.toHaveBeenCalled();
    window.dispatchEvent(pointer('pointerup', 380));
    expect(context.tabSvc.splitDividerPos()).toBe(70);
    expect(context.settings.saveSplitDividerPos).toHaveBeenCalledExactlyOnceWith(70);
    expect(document.body.style.cursor).toBe('crosshair');
    window.dispatchEvent(pointer('pointermove', 200));
    window.dispatchEvent(pointer('pointerup', 200));
    expect(context.tabSvc.splitDividerPos()).toBe(70);
    expect(context.settings.saveSplitDividerPos).toHaveBeenCalledOnce();
  });

  it.each([
    [0, 20],
    [600, 80],
  ])('clamps a release at %s to %s percent', (x, expected) => {
    start();
    window.dispatchEvent(pointer('pointerup', x));
    expect(context.tabSvc.splitDividerPos()).toBe(expected);
    expect(context.settings.saveSplitDividerPos).toHaveBeenCalledExactlyOnceWith(expected);
  });

  it('does not resize or persist a click below the movement threshold', () => {
    start();
    window.dispatchEvent(pointer('pointermove', 307));
    window.dispatchEvent(pointer('pointerup', 303));
    expect(context.tabSvc.splitDividerPos()).toBe(50);
    expect(context.settings.saveSplitDividerPos).not.toHaveBeenCalled();
    expect(document.body.style.cursor).toBe('crosshair');
  });

  it.each([1, 2])('ignores mouse button %s', button => {
    start(300, 1, button);
    window.dispatchEvent(pointer('pointermove', 400));
    window.dispatchEvent(pointer('pointerup', 400));
    expect(context.tabSvc.splitDividerPos()).toBe(50);
    expect(context.settings.saveSplitDividerPos).not.toHaveBeenCalled();
    expect(document.body.style.cursor).toBe('crosshair');
  });

  it('ignores movement, release and cancellation from a different pointer', () => {
    start();
    window.dispatchEvent(pointer('pointermove', 400, 2));
    window.dispatchEvent(pointer('pointerup', 400, 2));
    window.dispatchEvent(pointer('pointercancel', 400, 2));
    expect(context.tabSvc.splitDividerPos()).toBe(50);
    expect(document.body.style.cursor).toBe('col-resize');
    window.dispatchEvent(pointer('pointerup', 340));
    expect(context.settings.saveSplitDividerPos).toHaveBeenCalledExactlyOnceWith(60);
  });

  it.each(['pointercancel', 'blur', 'cleanup'])(
    'removes listeners and restores the cursor on %s without saving',
    action => {
      start();
      window.dispatchEvent(pointer('pointermove', 340));
      if (action === 'cleanup') context._splitDragCleanup?.();
      else if (action === 'blur') window.dispatchEvent(new Event('blur'));
      else window.dispatchEvent(pointer('pointercancel', 340));
      window.dispatchEvent(pointer('pointermove', 400));
      window.dispatchEvent(pointer('pointerup', 400));
      expect(context.tabSvc.splitDividerPos()).toBe(60);
      expect(context.settings.saveSplitDividerPos).not.toHaveBeenCalled();
      expect(document.body.style.cursor).toBe('crosshair');
      expect(context._splitDragCleanup).toBeUndefined();
    }
  );

  it('replaces a previous gesture without leaving its listeners active', () => {
    start();
    start(300, 2);
    window.dispatchEvent(pointer('pointermove', 400, 1));
    window.dispatchEvent(pointer('pointerup', 400, 1));
    expect(context.tabSvc.splitDividerPos()).toBe(50);
    window.dispatchEvent(pointer('pointerup', 340, 2));
    expect(context.settings.saveSplitDividerPos).toHaveBeenCalledExactlyOnceWith(60);
    expect(document.body.style.cursor).toBe('crosshair');
  });

  it('ignores zero-width containers instead of storing an invalid ratio', () => {
    vi.mocked(container.getBoundingClientRect).mockReturnValue(new DOMRect(100, 0, 0, 300));
    start();
    window.dispatchEvent(pointer('pointermove', 400));
    window.dispatchEvent(pointer('pointerup', 400));
    expect(context.tabSvc.splitDividerPos()).toBe(50);
    expect(context.settings.saveSplitDividerPos).not.toHaveBeenCalled();
  });

  it('ignores a divider that has no parent container', () => {
    divider.remove();
    start();
    window.dispatchEvent(pointer('pointerup', 400));
    expect(context.settings.saveSplitDividerPos).not.toHaveBeenCalled();
    expect(context._splitDragCleanup).toBeUndefined();
    expect(document.body.style.cursor).toBe('crosshair');
  });
});
