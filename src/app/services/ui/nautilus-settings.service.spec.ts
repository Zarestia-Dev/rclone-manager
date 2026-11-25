import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingMetadata } from '@app/types';
import { NautilusSettingsService } from './nautilus-settings.service';
import { AppSettingsService } from '../settings/app-settings.service';

describe('NautilusSettingsService', () => {
  const options = signal<Record<string, SettingMetadata> | null>(null);
  const saveSetting = vi.fn();
  let service: NautilusSettingsService;

  const load = (values: Record<string, unknown>): void => {
    options.set(
      Object.fromEntries(
        Object.entries(values).map(([key, value]) => [key, { value } as SettingMetadata])
      )
    );
    TestBed.tick();
  };
  /** A change saved here or in another window, as the settings event delivers it. */
  const change = (key: string, value: unknown): void => {
    options.update(current => ({ ...current, [key]: { value } as SettingMetadata }));
    TestBed.tick();
  };

  beforeEach(() => {
    options.set(null);
    saveSetting.mockReset().mockResolvedValue(undefined);
    TestBed.configureTestingModule({
      providers: [
        NautilusSettingsService,
        { provide: AppSettingsService, useValue: { options, saveSetting } },
      ],
    });
    service = TestBed.inject(NautilusSettingsService);
  });

  afterEach(() => localStorage.clear());

  it('shows the defaults until the settings load, then the stored view', () => {
    TestBed.tick();
    expect(service.layout()).toBe('grid');
    expect(service.iconSize()).toBe(96);
    expect(service.sortKey()).toBe('name-asc');

    load({
      'nautilus.layout': 'list',
      'nautilus.sort': 'size-desc',
      'nautilus.show_hidden': true,
      'nautilus.grid_icon_size': 128,
      'nautilus.list_icon_size': 32,
      'nautilus.sidebar_drive_order': ['drive', 'local'],
      'nautilus.sidebar_hidden_drives': ['s3'],
    });
    expect(service.layout()).toBe('list');
    expect(service.iconSize()).toBe(32);
    expect(service.sortColumn()).toBe('size');
    expect(service.sortAscending()).toBe(false);
    expect(service.showHidden()).toBe(true);
    expect(service.sidebarDriveOrder()).toEqual(['drive', 'local']);
    expect([...service.sidebarHiddenDrives()]).toEqual(['s3']);
    expect(saveSetting).not.toHaveBeenCalled();
  });

  it('saves what the toolbar changes and keeps each layout its own icon size', () => {
    load({
      'nautilus.layout': 'grid',
      'nautilus.grid_icon_size': 96,
      'nautilus.list_icon_size': 24,
    });
    service.increaseIconSize();
    expect(service.iconSize()).toBe(128);
    service.setLayout('list');
    expect(service.iconSize()).toBe(24);
    service.toggleSort('size');
    service.toggleShowHidden(true);
    service.saveSidebarConfig(['b', 'a'], ['c']);
    expect(saveSetting.mock.calls).toEqual([
      ['nautilus', 'grid_icon_size', 128],
      ['nautilus', 'layout', 'list'],
      ['nautilus', 'sort', 'size-desc'],
      ['nautilus', 'show_hidden', true],
      ['nautilus', 'sidebar_drive_order', ['b', 'a']],
      ['nautilus', 'sidebar_hidden_drives', ['c']],
    ]);
  });

  it('follows a change made in the preferences or another window', () => {
    load({ 'nautilus.layout': 'grid', 'nautilus.list_icon_size': 48 });
    change('nautilus.layout', 'list');
    expect(service.layout()).toBe('list');
    expect(service.iconSize()).toBe(48);
    change('nautilus.sort', 'modified-asc');
    expect(service.sortKey()).toBe('modified-asc');
    change('nautilus.show_hidden', false);
    expect(service.showHidden()).toBe(false);
    expect(saveSetting).not.toHaveBeenCalled();
  });

  it("moves this browser's old view state into the settings once", () => {
    localStorage.setItem('rcman.nautilus.default_layout', JSON.stringify('list'));
    localStorage.setItem('rcman.nautilus.grid_icon_size', JSON.stringify(160));
    localStorage.setItem('rcman.nautilus.sidebar_hidden_drives', JSON.stringify(['x']));
    localStorage.setItem('rcman.nautilus.split_divider_pos', JSON.stringify(30));
    load({});
    expect(saveSetting.mock.calls).toEqual([
      ['nautilus', 'layout', 'list'],
      ['nautilus', 'grid_icon_size', 160],
      ['nautilus', 'sidebar_hidden_drives', ['x']],
    ]);
    expect(localStorage.getItem('rcman.nautilus.default_layout')).toBeNull();
    // The split divider suits this browser's screen and stays here.
    expect(localStorage.getItem('rcman.nautilus.split_divider_pos')).toBe('30');

    change('nautilus.sort', 'name-desc');
    expect(saveSetting).toHaveBeenCalledTimes(3);
  });

  it('keeps the view when a setting cannot be saved', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    saveSetting.mockRejectedValueOnce(new Error('locked'));
    service.toggleShowHidden(true);
    await Promise.resolve();
    expect(service.showHidden()).toBe(true);
    expect(console.warn).toHaveBeenCalledOnce();
  });
});
