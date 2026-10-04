import { effect, signal } from '@angular/core';

/**
 * Shared logic for sliding menus used across Nautilus and App Menu components.
 * Handles view state, height calculation, and menu resets.
 */
export class SlideMenuController<T extends string = 'main' | 'submenu'> {
  readonly currentMenuView = signal<T>('main' as T);
  readonly contextMenuHeight = signal<number | null>(null);
  private readonly _menuOpenedTrigger = signal(0);

  constructor(
    private containerSelector: string,
    private rootResolver?: () => HTMLElement | null | undefined
  ) {
    // Track menu page height for the sliding animation.
    effect(() => {
      this.currentMenuView();
      this._menuOpenedTrigger();

      requestAnimationFrame(() => {
        const root = this.rootResolver?.() ?? document;
        const activePage =
          root.querySelector(`${this.containerSelector} .menu-page.active-page`) ??
          document.querySelector(`${this.containerSelector} .menu-page.active-page`);
        if (activePage) {
          this.contextMenuHeight.set((activePage as HTMLElement).offsetHeight);
        }
      });
    });
  }

  /** Resets the menu to the main page and triggers a height recalculation. */
  reset(): void {
    this.currentMenuView.set('main' as T);
    this._menuOpenedTrigger.update(v => v + 1);
  }

  /** Switches to the submenu. */
  openSubmenu(view: T = 'submenu' as T): void {
    this.currentMenuView.set(view);
  }

  /** Switches back to the main menu. */
  goBack(): void {
    this.currentMenuView.set('main' as T);
  }
}
