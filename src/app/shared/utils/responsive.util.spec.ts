import { DestroyRef, signal } from '@angular/core';
import { MatDrawerMode } from '@angular/material/sidenav';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { syncResponsiveSidebar } from './responsive.util';

describe('syncResponsiveSidebar', () => {
  let modeSignal: ReturnType<typeof signal<MatDrawerMode>>;
  let openSignal: ReturnType<typeof signal<boolean>>;
  let mockDestroyRef: DestroyRef;
  let destroyCallbacks: (() => void)[];
  let listeners: ((e: MediaQueryListEvent) => void)[];
  let currentMatches: boolean;

  beforeEach(() => {
    modeSignal = signal<MatDrawerMode>('side');
    openSignal = signal<boolean>(true);
    destroyCallbacks = [];
    listeners = [];
    currentMatches = true;

    mockDestroyRef = {
      destroyed: false,
      onDestroy: vi.fn((cb: () => void): (() => void) => {
        destroyCallbacks.push(cb);
        return (): void => {
          // no-op
        };
      }),
    };

    const mockMql = {
      get matches(): boolean {
        return currentMatches;
      },
      addEventListener: vi.fn((event: string, handler: (e: MediaQueryListEvent) => void) => {
        if (event === 'change') listeners.push(handler);
      }),
      removeEventListener: vi.fn((event: string, handler: (e: MediaQueryListEvent) => void) => {
        if (event === 'change') {
          listeners = listeners.filter(l => l !== handler);
        }
      }),
    };

    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(mockMql));
  });

  it('should initialize to side mode when media query matches desktop', () => {
    currentMatches = true;
    syncResponsiveSidebar(768, modeSignal, openSignal, mockDestroyRef);

    expect(modeSignal()).toBe('side');
    expect(openSignal()).toBe(true);
  });

  it('should initialize to over mode and close sidebar when media query matches mobile', () => {
    currentMatches = false;
    syncResponsiveSidebar(768, modeSignal, openSignal, mockDestroyRef);

    expect(modeSignal()).toBe('over');
    expect(openSignal()).toBe(false);
  });

  it('should react to media query change events', () => {
    currentMatches = true;
    syncResponsiveSidebar(768, modeSignal, openSignal, mockDestroyRef);
    expect(modeSignal()).toBe('side');

    // Simulate transition to mobile
    currentMatches = false;
    for (const listener of listeners) {
      listener({ matches: false } as MediaQueryListEvent);
    }
    expect(modeSignal()).toBe('over');
    expect(openSignal()).toBe(false);

    // Simulate transition back to desktop
    currentMatches = true;
    for (const listener of listeners) {
      listener({ matches: true } as MediaQueryListEvent);
    }
    expect(modeSignal()).toBe('side');
  });

  it('should clean up event listeners on destroy', () => {
    syncResponsiveSidebar(768, modeSignal, openSignal, mockDestroyRef);
    expect(listeners.length).toBe(1);

    for (const cb of destroyCallbacks) {
      cb();
    }
    expect(listeners.length).toBe(0);
  });
});
