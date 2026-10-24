import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingMetadata } from '@app/types';
import { AppSettingsService } from '../../settings/app-settings.service';
import { SystemHealthService } from '../../infrastructure/maintenance/system-health.service';
import { OnboardingStateService } from './onboarding-state.service';

describe('OnboardingStateService', () => {
  let settings: Subject<SettingMetadata | undefined>;
  let save: ReturnType<typeof vi.fn>;
  let setCompleted: ReturnType<typeof vi.fn>;
  let checkMountPlugin: ReturnType<typeof vi.fn>;
  let service: OnboardingStateService;

  beforeEach(() => {
    settings = new Subject();
    save = vi.fn().mockResolvedValue(undefined);
    setCompleted = vi.fn();
    checkMountPlugin = vi.fn().mockResolvedValue(undefined);
    TestBed.configureTestingModule({
      providers: [
        {
          provide: AppSettingsService,
          useValue: {
            selectSetting: (): Subject<SettingMetadata | undefined> => settings,
            saveSetting: save,
          },
        },
        {
          provide: SystemHealthService,
          useValue: {
            setOnboardingCompleted: setCompleted,
            checkMountPluginAndPromptRepair: checkMountPlugin,
          },
        },
      ],
    });
    service = TestBed.inject(OnboardingStateService);
  });

  afterEach(() => vi.restoreAllMocks());

  it.each([undefined, { default: false, value: null }, { default: false, value: 'true' }])(
    'treats missing and non-boolean settings as incomplete: %j',
    setting => {
      expect(service.isInitialized()).toBe(false);
      settings.next(setting);
      TestBed.tick();
      expect(service.isInitialized()).toBe(true);
      expect(service.isCompleted()).toBe(false);
      expect(setCompleted).toHaveBeenCalledWith(false);
      expect(checkMountPlugin).not.toHaveBeenCalled();
    }
  );

  it('synchronizes settings changes and runs post-onboarding checks on completion', () => {
    settings.next({ default: false, value: true });
    TestBed.tick();
    expect(service.isCompleted()).toBe(true);
    expect(setCompleted).toHaveBeenCalledWith(true);
    expect(checkMountPlugin).toHaveBeenCalledOnce();

    settings.next({ default: false, value: false });
    TestBed.tick();
    expect(service.isCompleted()).toBe(false);
    expect(setCompleted).toHaveBeenLastCalledWith(false);
    expect(checkMountPlugin).toHaveBeenCalledOnce();
  });

  it('updates completion only after the setting has been saved', async () => {
    let resolve!: () => void;
    save.mockReturnValue(new Promise<void>(done => (resolve = done)));
    const completing = service.completeOnboarding();
    expect(save).toHaveBeenCalledWith('core', 'completed_onboarding', true);
    expect(service.isCompleted()).toBe(false);
    resolve();
    await completing;
    expect(service.isCompleted()).toBe(true);
    expect(setCompleted).toHaveBeenCalledWith(true);
  });

  it('preserves incomplete state when saving fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const error = new Error('save failed');
    save.mockRejectedValue(error);
    await expect(service.completeOnboarding()).rejects.toBe(error);
    expect(service.isCompleted()).toBe(false);
    expect(setCompleted).not.toHaveBeenCalled();
  });

  it('finishes initialization in incomplete state when the settings stream fails', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    settings.error(new Error('settings unavailable'));
    expect(service.isInitialized()).toBe(true);
    expect(service.isCompleted()).toBe(false);
    expect(setCompleted).toHaveBeenCalledWith(false);
  });

  it('handles failed post-onboarding checks without undoing completion', async () => {
    const error = new Error('plugin unavailable');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    checkMountPlugin.mockRejectedValue(error);
    settings.next({ default: false, value: true });
    TestBed.tick();
    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith('Failed to run post-onboarding setup:', error)
    );
    expect(service.isCompleted()).toBe(true);
  });
});
