import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { Subject, take } from 'rxjs';
import { AppTab, APP_TABS, FlowSubMode, MainView } from '@app/types';
import { generatePrefixedId } from 'src/app/shared/utils';
import { navigationPath, parseNavigationUrl } from 'src/app/shared/utils/navigation-url.utils';

export interface MainNavigation {
  view: MainView;
  tab: AppTab;
  remote: string | null;
  quickRun: string | null;
  flowMode: FlowSubMode;
  workflow: string | null;
}

export interface NautilusNavigation {
  tab: number;
  pane: 0 | 1;
  remote: string | null;
  path: string;
}

interface NavigationEntry {
  session: string;
  index: number;
  main: MainNavigation;
  nautilus: NautilusNavigation | null;
}

/** The only writer of browser history. UI restoration must not create a new entry. */
@Injectable({ providedIn: 'root' })
export class NavigationHistoryService {
  private readonly window = inject(DOCUMENT).defaultView ?? globalThis.window;
  private readonly destroyRef = inject(DestroyRef);
  private session = generatePrefixedId('navigation');
  private readonly entry = signal<NavigationEntry | null>(null);
  private readonly storageKey = 'rclone.navigation.end';
  private readonly lastIndex = signal(0);
  private readonly layers = new Map<
    string,
    { close: () => void; index: number; parentIndex: number }
  >();
  private readonly restored = new Subject<NavigationEntry>();
  readonly restored$ = this.restored.asObservable();
  readonly current = this.entry.asReadonly();
  readonly canGoBack = computed(() => (this.entry()?.index ?? 0) > 0);
  readonly canGoForward = computed(() => (this.entry()?.index ?? 0) < this.lastIndex());
  private committed: NavigationEntry | null = null;
  private scheduled = false;
  private restoring = false;
  private closingLayer: number | null = null;

  constructor() {
    this.window.addEventListener('popstate', this.onPopState);
    this.destroyRef.onDestroy(() => {
      this.window.removeEventListener('popstate', this.onPopState);
      this.restored.complete();
    });
  }

  initialize(main: MainNavigation, standalone: MainView | null = null): void {
    if (this.entry()) return;
    const url = new URL(this.window.location.href);
    const parsed = parseNavigationUrl(url, main);
    const initial = parsed?.main ?? { ...main, view: standalone ?? main.view };
    const saved: unknown = this.window.history.state?.rcloneNavigation;
    const entry: NavigationEntry = isNavigationEntry(saved)
      ? {
          session: saved.session,
          index: saved.index,
          main: saved.main,
          nautilus: saved.nautilus,
        }
      : {
          session: this.session,
          index: 0,
          main: initial,
          nautilus: parsed?.nautilus ?? null,
        };
    this.session = entry.session;
    let endIndex = entry.index;
    try {
      const savedEnd = JSON.parse(
        this.window.sessionStorage.getItem(this.storageKey) ?? 'null'
      ) as { session?: unknown; index?: unknown } | null;
      if (
        savedEnd?.session === entry.session &&
        typeof savedEnd.index === 'number' &&
        Number.isSafeInteger(savedEnd.index) &&
        savedEnd.index >= 0
      ) {
        endIndex = Math.max(endIndex, savedEnd.index);
      }
    } catch {
      // Session storage can be disabled; browser history still works without its Forward button state.
    }
    this.lastIndex.set(endIndex);
    this.entry.set(entry);
    // Keep the initial Nautilus deep link until its remote data is loaded.
    const initialUrl = new URL(this.window.location.href);
    if (standalone)
      initialUrl.searchParams.set('standalone', standalone === 'main_menu' ? 'main' : standalone);
    this.write(entry, true, this.url(entry, initialUrl));
    this.restore(entry);
  }

  updateMain(main: MainNavigation): void {
    const current = this.entry();
    if (!current || this.restoring) return;
    this.update({ ...current, main });
  }

  updateNautilus(nautilus: NautilusNavigation, replace = false): void {
    const current = this.entry();
    if (!current || this.restoring) return;
    const next = { ...current, nautilus };
    if (replace && !current.nautilus) {
      this.replaceNautilus(nautilus);
    } else {
      this.update(next);
    }
  }

  replaceNautilus(nautilus: NautilusNavigation): void {
    this.flush();
    const current = this.entry();
    if (!current) return;
    const next = { ...current, nautilus };
    this.entry.set(next);
    this.write(next, true);
  }

  back(): void {
    this.flush();
    if (this.canGoBack()) this.window.history.back();
  }

  forward(): void {
    this.flush();
    if (this.canGoForward()) this.window.history.forward();
  }

  /** Registers a transient surface so Back closes it before leaving its parent view. */
  openLayer(close: () => void): () => void {
    if (this.closingLayer !== null) {
      // A replacement dialog belongs to the parent reached by the pending traversal.
      let release: (() => void) | undefined;
      const subscription = this.restored$.pipe(take(1)).subscribe(() => {
        release = this.openLayer(close);
      });
      return () => {
        subscription.unsubscribe();
        release?.();
      };
    }
    this.flush();
    const parent = this.entry();
    if (!parent)
      return () => {
        // No layer can be registered before history initialization.
      };
    const id = generatePrefixedId('layer');
    const entry = { ...parent, index: parent.index + 1 };
    this.layers.set(id, { close, index: entry.index, parentIndex: parent.index });
    this.entry.set(entry);
    this.lastIndex.set(entry.index);
    this.rememberEnd(entry);
    this.write(entry, false);

    return () => {
      const layer = this.layers.get(id);
      if (!layer) return;
      this.layers.delete(id);
      const child = [...this.layers.values()].find(child => child.index > layer.index);
      if (child) {
        // Closing a covered surface must not close the surface above it.
        child.parentIndex = layer.parentIndex;
        return;
      }
      const current = this.entry();
      if (!current || current.index < layer.index || this.restoring) return;
      if (this.closingLayer !== null) {
        this.closingLayer = Math.min(this.closingLayer, layer.parentIndex);
        return;
      }
      this.closingLayer = layer.parentIndex;
      this.window.history.go(layer.parentIndex - current.index);
    };
  }

  private update(next: NavigationEntry): void {
    if (JSON.stringify(next) === JSON.stringify(this.entry())) return;
    this.entry.set(next);
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      if (!this.destroyRef.destroyed) this.flush();
    });
  }

  private flush(): void {
    this.scheduled = false;
    const entry = this.entry();
    if (!entry || this.restoring || this.closingLayer !== null) return;
    if (JSON.stringify(entry) === JSON.stringify(this.committed)) return;
    if (
      this.committed &&
      navigationPath(entry.main, entry.nautilus) ===
        navigationPath(this.committed.main, this.committed.nautilus) &&
      (entry.main.view !== 'nautilus' ||
        JSON.stringify(entry.nautilus) === JSON.stringify(this.committed.nautilus))
    ) {
      this.write(entry, true);
      return;
    }
    const next = { ...entry, index: (this.committed?.index ?? 0) + 1 };
    this.entry.set(next);
    this.lastIndex.set(next.index);
    this.rememberEnd(next);
    this.write(next, false);
  }

  private readonly onPopState = (event: PopStateEvent): void => {
    const entry: unknown = event.state?.rcloneNavigation;
    if (!isNavigationEntry(entry) || entry.session !== this.session) return;
    if (this.closingLayer !== null && entry.index > this.closingLayer) {
      this.window.history.go(this.closingLayer - entry.index);
      return;
    }
    this.scheduled = false;
    const pending = this.entry();
    this.lastIndex.update(index => Math.max(index, entry.index));
    const keepPending =
      this.closingLayer !== null &&
      this.committed &&
      pending &&
      (JSON.stringify(pending.main) !== JSON.stringify(this.committed.main) ||
        JSON.stringify(pending.nautilus) !== JSON.stringify(this.committed.nautilus));
    const committed = this.committed;
    this.closingLayer = null;
    if (keepPending && pending) {
      this.write(entry, true, this.window.location.href);
      const next = {
        ...entry,
        index: entry.index + 1,
        main:
          JSON.stringify(pending.main) !== JSON.stringify(committed?.main)
            ? pending.main
            : entry.main,
        nautilus:
          JSON.stringify(pending.nautilus) !== JSON.stringify(committed?.nautilus)
            ? pending.nautilus
            : entry.nautilus,
      };
      this.entry.set(next);
      this.lastIndex.set(next.index);
      this.rememberEnd(next);
      this.write(next, false);
      this.restore(next);
      return;
    }
    this.restore(entry);
  };

  private restore(entry: NavigationEntry): void {
    this.restoring = true;
    try {
      for (const [id, layer] of [...this.layers].reverse()) {
        if (entry.index < layer.index) {
          this.layers.delete(id);
          layer.close();
        }
      }
      this.entry.set(entry);
      this.write(entry, true, this.window.location.href);
      this.restored.next(entry);
    } finally {
      this.restoring = false;
    }
  }

  private rememberEnd(entry: NavigationEntry): void {
    try {
      this.window.sessionStorage.setItem(
        this.storageKey,
        JSON.stringify({ session: entry.session, index: entry.index })
      );
    } catch {
      // The history entries themselves remain the source of truth.
    }
  }

  private write(entry: NavigationEntry, replace: boolean, url = this.url(entry)): void {
    const state = { ...this.window.history.state, rcloneNavigation: entry };
    if (replace) this.window.history.replaceState(state, '', url);
    else this.window.history.pushState(state, '', url);
    this.committed = entry;
  }

  private url(entry: NavigationEntry, source = new URL(this.window.location.href)): string {
    const target = new URL(navigationPath(entry.main, entry.nautilus), source.origin);
    for (const [key, value] of source.searchParams) {
      if (!['view', 'tab', 'mode', 'remote', 'quickRun'].includes(key)) {
        target.searchParams.append(key, value);
      }
    }
    return target.pathname + target.search;
  }
}

function isMainView(value: string | null): value is MainView {
  return value === 'main_menu' || value === 'flow' || value === 'nautilus';
}

function isNavigationEntry(value: unknown): value is NavigationEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<NavigationEntry>;
  const main = entry.main;
  const nullableString = (value: unknown): boolean => value === null || typeof value === 'string';
  const index = (value: unknown): boolean =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  const location = entry.nautilus;
  return (
    typeof entry.session === 'string' &&
    index(entry.index) &&
    !!main &&
    isMainView(main.view) &&
    APP_TABS.includes(main.tab) &&
    nullableString(main.remote) &&
    nullableString(main.quickRun) &&
    nullableString(main.workflow) &&
    (main.flowMode === 'builder' || main.flowMode === 'quick_run') &&
    (location === null ||
      (!!location &&
        index(location.tab) &&
        (location.pane === 0 || location.pane === 1) &&
        nullableString(location.remote) &&
        typeof location.path === 'string'))
  );
}
