import { TestBed } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDefaultRemoteFeatures,
  createDefaultRemoteStatus,
  DEFAULT_PROFILE_NAME,
  Remote,
  ServeListItem,
} from '@app/types';
import { RemoteStatusService } from './remote-status.service';

describe('RemoteStatusService', () => {
  let service: RemoteStatusService;
  let remote: Remote;
  let instant: ReturnType<typeof vi.fn>;

  function serve(profile?: string, type = 'http'): ServeListItem {
    return {
      id: `${type}-1`,
      addr: '127.0.0.1:8080',
      profile,
      params: { fs: 'drive:', type },
    };
  }

  beforeEach(() => {
    instant = vi.fn((key: string, params?: Record<string, unknown>): string =>
      key === 'serve.profileInfo' ? `${params?.['profile']}:${params?.['type']}` : key
    );
    TestBed.configureTestingModule({
      providers: [{ provide: TranslateService, useValue: { instant } }],
    });
    service = TestBed.inject(RemoteStatusService);
    remote = {
      name: 'drive',
      type: 'drive',
      config: { name: 'drive', type: 'drive' },
      status: createDefaultRemoteStatus(),
      features: createDefaultRemoteFeatures(),
      primaryActions: [],
      syncActions: [],
    };
  });

  it('distinguishes an inactive serve from an active serve without instance metadata', () => {
    expect(service.getServeTooltip(remote)).toBe('serve.noActive');
    remote.status.serve.active = true;
    expect(service.getServeTooltip(remote)).toBe('serve.serving');
  });

  it.each([
    { stored: undefined, expected: DEFAULT_PROFILE_NAME },
    { stored: '', expected: DEFAULT_PROFILE_NAME },
    { stored: 'default', expected: 'default' },
    { stored: 'Default', expected: 'Default' },
    { stored: 'Arşiv & 旅行', expected: 'Arşiv & 旅行' },
  ])('uses the correct profile label for $stored', ({ stored, expected }) => {
    remote.status.serve = { active: true, count: 1, serves: [serve(stored)] };
    service.getServeTooltip(remote);
    expect(instant).toHaveBeenCalledWith('serve.servingWithProfile', {
      profile: expected,
      type: 'HTTP',
      addr: '127.0.0.1:8080',
    });
  });

  it('uses the shared fallback alongside explicitly stored names in multiple serves', () => {
    remote.status.serve = {
      active: true,
      count: 2,
      serves: [serve(undefined), serve('default', 'webdav')],
    };
    service.getServeTooltip(remote);
    expect(instant).toHaveBeenCalledWith('serve.servingMultiple', {
      count: 2,
      profiles: `${DEFAULT_PROFILE_NAME}:HTTP, default:WEBDAV`,
    });
  });

  it('detects active sync and serve operations independently', () => {
    expect(service.hasActiveOperations(remote)).toBe(false);
    remote.status.copy.active = true;
    expect(service.hasActiveOperations(remote)).toBe(true);
    expect(service.getActiveSyncOperationType(remote)).toBe('copy');

    remote.status.copy.active = false;
    remote.status.serve.active = true;
    expect(service.hasActiveOperations(remote)).toBe(true);
    expect(service.getActiveSyncOperationType(remote)).toBeNull();
  });
});
