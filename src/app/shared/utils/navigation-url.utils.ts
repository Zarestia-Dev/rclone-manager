import { APP_TABS, AppTab } from '@app/types';
import type {
  MainNavigation,
  NautilusNavigation,
} from '../../services/ui/navigation-history.service';
import { buildNautilusPath, parseNautilusPath } from './nautilus-url.utils';

export function navigationPath(main: MainNavigation, nautilus: NautilusNavigation | null): string {
  if (main.view === 'nautilus')
    return buildNautilusPath(nautilus?.remote ?? null, nautilus?.path ?? '');
  if (main.view === 'flow') {
    const root = main.flowMode === 'builder' ? '/workflows' : '/quickrun';
    const id = main.flowMode === 'builder' ? main.workflow : main.quickRun;
    return id ? `${root}/${encodeURIComponent(id)}` : root;
  }
  const root = main.remote ? `/main/${encodeURIComponent(main.remote)}` : '/main';
  if (main.tab === 'general') return root;
  return main.remote ? `${root}/${main.tab}` : `${root}?tab=${main.tab}`;
}

export function parseNavigationUrl(
  url: URL,
  defaults: MainNavigation
): {
  main: MainNavigation;
  nautilus: NautilusNavigation | null;
} | null {
  const pathname = url.hash.startsWith('#/') ? url.hash.slice(1) : url.pathname;
  const nautilus = parseNautilusPath(pathname);
  if (nautilus)
    return { main: { ...defaults, view: 'nautilus' }, nautilus: { ...nautilus, tab: 0, pane: 0 } };
  try {
    const [root, id, tab, ...extra] = pathname.slice(1).split('/');
    if (extra.length) return null;
    if (root === 'main') {
      const selectedTab = tab ?? url.searchParams.get('tab') ?? 'general';
      if (!APP_TABS.includes(selectedTab as AppTab)) return null;
      return {
        main: {
          ...defaults,
          view: 'main_menu',
          remote: id ? decodeURIComponent(id) : null,
          tab: selectedTab as AppTab,
        },
        nautilus: null,
      };
    }
    if ((root === 'quickrun' || root === 'workflows') && tab === undefined) {
      return {
        main: {
          ...defaults,
          view: 'flow',
          flowMode: root === 'workflows' ? 'builder' : 'quick_run',
          ...(root === 'workflows'
            ? { workflow: id ? decodeURIComponent(id) : null }
            : { quickRun: id ? decodeURIComponent(id) : null }),
        },
        nautilus: null,
      };
    }
  } catch {
    return null;
  }
  return null;
}
