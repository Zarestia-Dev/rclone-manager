import { TestBed } from '@angular/core/testing';
import { OriginFilterService } from './origin-filter.service';

const STORAGE_KEY = 'rcman.overview.originFilters';

describe('OriginFilterService', () => {
  const create = (): OriginFilterService => {
    TestBed.resetTestingModule();
    return TestBed.inject(OriginFilterService);
  };

  beforeEach(() => localStorage.removeItem(STORAGE_KEY));
  afterEach(() => localStorage.removeItem(STORAGE_KEY));

  it('starts every panel on "all"', () => {
    const service = create();
    for (const panel of ['mounts', 'serves', 'jobs', 'automations'] as const) {
      expect(service.get(panel)).toBe('all');
    }
  });

  it("keeps a panel's choice apart from the others", () => {
    const service = create();
    service.set('mounts', 'quickrun');
    expect(service.get('mounts')).toBe('quickrun');
    expect(service.get('serves')).toBe('all');
  });

  it('remembers the choices after a restart', () => {
    create().set('jobs', 'workflow');
    expect(create().get('jobs')).toBe('workflow');
  });

  it('falls back to "all" when the stored value is unreadable', () => {
    localStorage.setItem(STORAGE_KEY, '{broken');
    expect(create().get('mounts')).toBe('all');
  });
});
