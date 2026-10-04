import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { SlideMenuController } from './slide-menu.util';

describe('SlideMenuController', () => {
  let controller: SlideMenuController;

  beforeEach(() => {
    TestBed.runInInjectionContext(() => {
      controller = new SlideMenuController('.test-sliding-container');
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('initializes on main view with null height', () => {
    expect(controller.currentMenuView()).toBe('main');
    expect(controller.contextMenuHeight()).toBeNull();
  });

  it('switches to submenu on openSubmenu()', () => {
    controller.openSubmenu();
    expect(controller.currentMenuView()).toBe('submenu');
  });

  it('switches back to main view on goBack()', () => {
    controller.openSubmenu();
    expect(controller.currentMenuView()).toBe('submenu');

    controller.goBack();
    expect(controller.currentMenuView()).toBe('main');
  });

  it('resets to main view on reset()', () => {
    controller.openSubmenu();
    expect(controller.currentMenuView()).toBe('submenu');

    controller.reset();
    expect(controller.currentMenuView()).toBe('main');
  });

  it('measures active page height when element is in DOM', async () => {
    const container = document.createElement('div');
    container.className = 'test-sliding-container';

    const activePage = document.createElement('div');
    activePage.className = 'menu-page active-page';
    Object.defineProperty(activePage, 'offsetHeight', { value: 340, configurable: true });

    container.appendChild(activePage);
    document.body.appendChild(container);

    controller.reset();

    // Allow requestAnimationFrame callback to run
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

    expect(controller.contextMenuHeight()).toBe(340);

    document.body.removeChild(container);
  });
});
