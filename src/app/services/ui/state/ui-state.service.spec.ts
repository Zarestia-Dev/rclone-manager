import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { AppSettingsService } from '../../settings/app-settings.service';
import { NavigationHistoryService } from '../navigation-history.service';
import { WindowService } from '../window.service';
import { LocalStorageService } from './local-storage.service';
import { UiStateService } from './ui-state.service';

describe('UiStateService layout editing', () => {
  let service: UiStateService;
  let addListener: MockInstance<typeof window.addEventListener>;
  let originalRadius: string;

  beforeEach(() => {
    originalRadius = document.documentElement.style.getPropertyValue('--app-border-radius');
    addListener = vi.spyOn(window, 'addEventListener');
    vi.stubGlobal('__TAURI_INTERNALS__', undefined);
    TestBed.configureTestingModule({
      providers: [
        { provide: NavigationHistoryService, useValue: { openLayer: vi.fn(() => vi.fn()) } },
        { provide: WindowService, useValue: { isMaximized: signal(false) } },
        {
          provide: LocalStorageService,
          useValue: { get: vi.fn((_key: string, fallback: unknown) => fallback), set: vi.fn() },
        },
        {
          provide: AppSettingsService,
          useValue: { options: signal({}), isTrayAvailable: signal(false) },
        },
      ],
    });
    service = TestBed.inject(UiStateService);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    for (const [type, listener, options] of addListener.mock.calls) {
      if (type === 'keydown') window.removeEventListener(type, listener, options);
    }
    document.documentElement.style.setProperty('--app-border-radius', originalRadius);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('toggles one overview and resets only while it is being edited', () => {
    const onReset = vi.fn();
    service.toggleLayoutEdit({ overviewId: 'general', onReset });
    expect(service.isEditingLayout()).toBe(true);
    expect(service.isEditingOverview('general')).toBe(true);
    service.resetLayout();
    expect(onReset).toHaveBeenCalledOnce();

    service.toggleLayoutEdit({ overviewId: 'general', onReset });
    expect(service.activeEditContext()).toBeNull();
    service.resetLayout();
    expect(onReset).toHaveBeenCalledOnce();
  });

  it('replaces the reset callback when editing a different overview', () => {
    const first = vi.fn();
    const second = vi.fn();
    service.toggleLayoutEdit({ overviewId: 'general', onReset: first });
    service.toggleLayoutEdit({ overviewId: 'quick_run', onReset: second });
    expect(service.isEditingOverview('general')).toBe(false);
    expect(service.isEditingOverview('quick_run')).toBe(true);
    service.resetLayout();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it.each([
    { name: 'view', navigate: (state: UiStateService): void => state.setMainView('flow') },
    { name: 'tab', navigate: (state: UiStateService): void => state.setTab('operations') },
    {
      name: 'default view',
      navigate: (state: UiStateService): void => state.setDefaultView('flow'),
    },
  ])('ends layout editing when changing the $name', ({ navigate }) => {
    service.toggleLayoutEdit({ overviewId: 'general' });
    navigate(service);
    expect(service.isEditingLayout()).toBe(false);
    expect(service.activeEditContext()).toBeNull();
  });

  it('ends editing on Escape and ignores other keys', () => {
    service.toggleLayoutEdit({ overviewId: 'general' });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(service.isEditingLayout()).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(service.isEditingLayout()).toBe(false);
  });
});
