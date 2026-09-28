import { describe, expect, it } from 'vitest';
import { MainNavigation } from '../../services/ui/navigation-history.service';
import { navigationPath, parseNavigationUrl } from './navigation-url.utils';

const main: MainNavigation = {
  view: 'main_menu',
  tab: 'general',
  remote: null,
  quickRun: null,
  workflow: null,
  flowMode: 'quick_run',
};

describe('workspace URLs', () => {
  it.each([
    ['/main', main],
    ['/main/Google%20Drive', { ...main, remote: 'Google Drive' }],
    [
      '/main/Google%20Drive/operations',
      { ...main, remote: 'Google Drive', tab: 'operations' as const },
    ],
    ['/main?tab=operations', { ...main, tab: 'operations' as const }],
    ['/quickrun', { ...main, view: 'flow' as const }],
    ['/quickrun/a%26b', { ...main, view: 'flow' as const, quickRun: 'a&b' }],
    ['/workflows', { ...main, view: 'flow' as const, flowMode: 'builder' as const }],
    [
      '/workflows/wf-1',
      { ...main, view: 'flow' as const, flowMode: 'builder' as const, workflow: 'wf-1' },
    ],
  ])('builds and parses %s', (path, state) => {
    expect(navigationPath(state, null)).toBe(path);
    expect(parseNavigationUrl(new URL(path, 'http://localhost'), main)?.main).toEqual(state);
  });

  it('does not expose selections from inactive workspaces', () => {
    const state = { ...main, remote: 'Drive', quickRun: 'qr-1', workflow: 'wf-1' };
    expect(navigationPath(state, null)).toBe('/main/Drive');
    expect(navigationPath({ ...state, view: 'flow' }, null)).toBe('/quickrun/qr-1');
    expect(
      navigationPath(
        { ...state, view: 'nautilus' },
        { tab: 1, pane: 0, remote: 'Drive', path: 'a/#?/文件' }
      )
    ).toBe('/nautilus/Drive/a/%23%3F/%E6%96%87%E4%BB%B6');
  });

  it('parses Nautilus paths and the active tray hash transport without inferring window mode', () => {
    for (const path of ['/nautilus/Drive/a%5Cb', '/index.html#/nautilus/Drive/a%5Cb']) {
      expect(parseNavigationUrl(new URL(path, 'http://localhost'), main)).toEqual({
        main: { ...main, view: 'nautilus' },
        nautilus: { tab: 0, pane: 0, remote: 'Drive', path: 'a\\b' },
      });
    }
  });

  it.each([
    '/other',
    '/main/drive/invalid',
    '/main/a/general/extra',
    '/quickrun/id/extra',
    '/main/%ZZ',
    '/workflows/%ZZ',
  ])('rejects invalid route %s', path => {
    expect(parseNavigationUrl(new URL(path, 'http://localhost'), main)).toBeNull();
  });
});
