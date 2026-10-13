import { DestroyRef, inject, WritableSignal } from '@angular/core';
import { MatDrawerMode } from '@angular/material/sidenav';

/**
 * Synchronizes MatDrawerMode ('side' | 'over') and optional sidebar visibility
 * with a min-width media query breakpoint.
 *
 * @param minWidthPx Minimum viewport width in pixels to treat as desktop ('side' mode).
 * @param sidebarMode The writable signal controlling the MatDrawerMode.
 * @param isSidebarOpen Optional writable signal controlling the sidebar open state.
 * @param destroyRef Optional DestroyRef (defaults to inject(DestroyRef) if called in an injection context).
 */
export function syncResponsiveSidebar(
  minWidthPx: number,
  sidebarMode: WritableSignal<MatDrawerMode>,
  isSidebarOpen?: WritableSignal<boolean>,
  destroyRef: DestroyRef = inject(DestroyRef)
): void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;

  const mql = window.matchMedia(`(min-width: ${minWidthPx}px)`);
  const update = (matches: boolean): void => {
    sidebarMode.set(matches ? 'side' : 'over');
    if (!matches && isSidebarOpen) {
      isSidebarOpen.set(false);
    }
  };
  const handler = (e: MediaQueryListEvent): void => update(e.matches);

  update(mql.matches);
  mql.addEventListener('change', handler);
  destroyRef.onDestroy(() => mql.removeEventListener('change', handler));
}
