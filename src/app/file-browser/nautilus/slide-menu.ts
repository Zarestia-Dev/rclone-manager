import { effect, signal } from '@angular/core';

/**
 * Shared logic for the sliding context menu used in Nautilus-style components.
 * Handles view state, height calculation, and menu resets.
 */
export class SlideMenuController {
  readonly currentMenuView = signal<'main' | 'open'>('main');
  readonly contextMenuHeight = signal<number | null>(null);
  private readonly _menuOpenedTrigger = signal(0);

  constructor(private containerSelector: string) {
    // Track context menu page height for the sliding animation.
    effect(() => {
      this.currentMenuView();
      this._menuOpenedTrigger();

      // setTimeout defers the DOM read until after the next render cycle.
      setTimeout(() => {
        const activePage = document.querySelector(
          `${this.containerSelector} .menu-page.active-page`
        );
        if (activePage) {
          this.contextMenuHeight.set((activePage as HTMLElement).offsetHeight);
        }
      }, 0);
    });
  }

  /** Resets the menu to the main page and triggers a height recalculation. */
  reset(): void {
    this.currentMenuView.set('main');
    this._menuOpenedTrigger.update(v => v + 1);
  }

  /** Switches to the submenu. */
  openSubmenu(): void {
    this.currentMenuView.set('open');
  }

  /** Switches back to the main menu. */
  goBack(): void {
    this.currentMenuView.set('main');
  }
}
