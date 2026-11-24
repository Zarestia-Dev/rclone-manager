import { describe, expect, it, vi } from 'vitest';
import { AppComponent } from './app.component';

// Exercise the root's real startup flow without booting its unrelated UI services.
class StartupContext {
  appInitializing = false;
  appInitialized = false;
  initializationRevision = 0;
  initializing = { set: vi.fn() };
  initializationFailed = { set: vi.fn() };
  vaultService = {
    checkVaultStatus: vi.fn().mockResolvedValue(undefined),
    isStatusKnown: vi.fn().mockReturnValue(true),
    isVaultLocked: vi.fn().mockReturnValue(false),
    isAccessible: vi.fn().mockReturnValue(true),
  };
  appSettingsService = {
    loadSettings: vi.fn().mockResolvedValue(undefined),
    applySavedLanguage: vi.fn().mockResolvedValue(undefined),
  };
  appUpdaterService = { initialize: vi.fn() };
  rcloneUpdateService = { initialize: vi.fn() };
  nautilusService = { initializeFromUrl: vi.fn(), isStandaloneWindow: (): boolean => false };
  modalService = { isDialogStandalone: (): boolean => false };
  flowOverlayService = { isStandaloneWindow: (): boolean => false };
  mainUiOverlayService = { isStandaloneWindow: (): boolean => false };
  backendService = {
    loadBackends: vi.fn().mockResolvedValue(undefined),
    refreshStatuses: vi.fn().mockResolvedValue(undefined),
  };
  applyDefaultView = vi.fn().mockResolvedValue(undefined);
  navigation = { initialize: vi.fn() };
}

function startup(): { context: StartupContext; initialize: () => Promise<void> } {
  const context = new StartupContext();
  const initialize = (): Promise<void> =>
    (AppComponent.prototype as unknown as { initializeApp(): Promise<void> }).initializeApp.call(
      context
    );
  return { context, initialize };
}

describe('Application startup', () => {
  it('waits for settings before starting navigation', async () => {
    const { context, initialize } = startup();
    let finish!: () => void;
    context.appSettingsService.loadSettings.mockReturnValue(
      new Promise<void>(resolve => (finish = resolve))
    );
    const pending = initialize();
    await Promise.resolve();
    expect(context.navigation.initialize).not.toHaveBeenCalled();
    finish();
    await pending;
    expect(context.appInitialized).toBe(true);
    expect(context.navigation.initialize).toHaveBeenCalled();
  });

  it('does not load settings for an unknown vault state', async () => {
    const { context, initialize } = startup();
    context.vaultService.isStatusKnown.mockReturnValue(false);
    await initialize();
    expect(context.appSettingsService.loadSettings).not.toHaveBeenCalled();
    expect(context.appInitialized).toBe(false);
  });

  it('shows the locked-vault screen without loading protected settings', async () => {
    const { context, initialize } = startup();
    context.vaultService.isVaultLocked.mockReturnValue(true);
    await initialize();
    expect(context.appSettingsService.loadSettings).not.toHaveBeenCalled();
    expect(context.appInitialized).toBe(false);
  });

  it('reports failed initialization and allows a successful retry', async () => {
    const { context, initialize } = startup();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      context.appSettingsService.loadSettings.mockRejectedValueOnce(new Error('settings failed'));
      await initialize();
      expect(context.appInitialized).toBe(false);
      expect(context.initializationFailed.set).toHaveBeenLastCalledWith(true);
      await initialize();
      expect(context.appInitialized).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  it('reports a failure when navigation cannot initialize', async () => {
    const { context, initialize } = startup();
    context.navigation.initialize.mockImplementation(() => {
      throw new Error('navigation failed');
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await initialize();
      expect(context.initializationFailed.set).toHaveBeenLastCalledWith(true);
      expect(context.appInitializing).toBe(false);
      expect(context.appInitialized).toBe(false);
    } finally {
      log.mockRestore();
    }
  });

  it('stops a pending startup after the vault locks', async () => {
    const { context, initialize } = startup();
    let finish!: () => void;
    context.appSettingsService.loadSettings.mockReturnValue(
      new Promise<void>(resolve => (finish = resolve))
    );
    const pending = initialize();
    await Promise.resolve();
    context.vaultService.isAccessible.mockReturnValue(false);
    context.initializationRevision++;
    finish();
    await pending;
    expect(context.appSettingsService.applySavedLanguage).not.toHaveBeenCalled();
    expect(context.appInitialized).toBe(false);
    expect(context.navigation.initialize).not.toHaveBeenCalled();
  });

  it('reloads protected settings on reentry without restarting navigation or updaters', async () => {
    const { context, initialize } = startup();
    context.appInitialized = true;
    await initialize();
    expect(context.appSettingsService.loadSettings).toHaveBeenCalledOnce();
    expect(context.appSettingsService.applySavedLanguage).toHaveBeenCalledOnce();
    expect(context.navigation.initialize).not.toHaveBeenCalled();
    expect(context.appUpdaterService.initialize).not.toHaveBeenCalled();
  });
});
