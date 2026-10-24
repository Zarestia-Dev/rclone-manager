import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NautilusService } from './nautilus.service';

describe('Nautilus standalone windows', () => {
  const context = {
    isTauri: true,
    isStandaloneEnabled: false,
    vault: { isAccessible: vi.fn(() => true) },
    invokeCommand: vi.fn(),
    getNautilusUrl: vi.fn(() => 'http://localhost/nautilus/drive/folder%20%26%20photos'),
    closeBrowserOverlay: vi.fn(),
    openBrowserOverlay: vi.fn(),
    notificationService: { showError: vi.fn() },
    translate: { instant: (key: string): string => key },
    openStandaloneWindow: NautilusService.prototype.openStandaloneWindow,
  };
  const service = context as unknown as NautilusService;

  beforeEach(() => {
    vi.clearAllMocks();
    context.isTauri = true;
    context.vault.isAccessible.mockReturnValue(true);
    context.invokeCommand.mockResolvedValue(true);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it('opens distinct native windows for the same remote regardless of the overlay preference', async () => {
    expect(await service.openStandaloneWindow('drive', 'folder & photos')).toBe(true);
    expect(await service.openStandaloneWindow('drive', 'folder & photos')).toBe(true);
    const [first, second] = context.invokeCommand.mock.calls;
    expect(first[0]).toBe('new_window');
    expect(first[1].opts.url).toBe(
      'http://localhost/nautilus/drive/folder%20%26%20photos?standalone=nautilus'
    );
    expect(first[1].opts.label).toMatch(/^nautilus-/);
    expect(second[1].opts.label).not.toBe(first[1].opts.label);
    expect(context.openBrowserOverlay).not.toHaveBeenCalled();
    expect(context.closeBrowserOverlay).toHaveBeenCalledTimes(2);
  });

  it.each(['false', 'rejection'])(
    'keeps the source open when native creation returns %s',
    async failure => {
      if (failure === 'false') context.invokeCommand.mockResolvedValue(false);
      else context.invokeCommand.mockRejectedValue(new Error('IPC failed'));
      expect(await service.openStandaloneWindow(null, null)).toBe(false);
      expect(context.closeBrowserOverlay).not.toHaveBeenCalled();
      expect(context.openBrowserOverlay).not.toHaveBeenCalled();
      expect(context.notificationService.showError).toHaveBeenCalledWith(
        'nautilus.errors.windowOpenFailed'
      );
    }
  );

  it('preserves the overlay preference for ordinary browse requests', async () => {
    await NautilusService.prototype.newNautilusWindow.call(service, 'drive', 'folder');
    expect(context.openBrowserOverlay).toHaveBeenCalledExactlyOnceWith('drive', 'folder');
    expect(context.invokeCommand).not.toHaveBeenCalled();
  });

  it('does not open anything while the vault is locked', async () => {
    context.vault.isAccessible.mockReturnValue(false);
    expect(await service.openStandaloneWindow(null, null)).toBe(false);
    expect(context.invokeCommand).not.toHaveBeenCalled();
    expect(context.openBrowserOverlay).not.toHaveBeenCalled();
  });

  it('does not report a mobile overlay as a detached window', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Android');
    expect(await service.openStandaloneWindow('drive', '')).toBe(false);
    expect(context.openBrowserOverlay).toHaveBeenCalledExactlyOnceWith('drive', '');
    expect(context.invokeCommand).not.toHaveBeenCalled();
  });

  it.each([true, false])('checks browser popup creation: %s', async opened => {
    context.isTauri = false;
    vi.spyOn(window, 'open').mockReturnValue(opened ? window : null);
    expect(await service.openStandaloneWindow('drive', '')).toBe(opened);
    expect(context.closeBrowserOverlay).toHaveBeenCalledTimes(opened ? 1 : 0);
  });
});
