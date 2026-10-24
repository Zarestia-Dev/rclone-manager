import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatIconRegistry } from '@angular/material/icon';
import { provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { NautilusTabItem } from '@app/types';
import { NautilusService } from 'src/app/services/ui/nautilus.service';
import { NautilusTabsComponent } from './nautilus-tabs.component';

function pointer(type: string, x: number, y = 20, pointerId = 1): MouseEvent {
  return Object.assign(
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 0,
    }),
    { pointerId }
  );
}

describe('Nautilus tab gestures', () => {
  let fixture: ComponentFixture<NautilusTabsComponent>;
  let component: NautilusTabsComponent;
  let tabs: NautilusTabItem[];
  let frames: Map<number, FrameRequestCallback>;
  let elements: HTMLElement[];
  const newWindow = vi.fn();

  beforeEach(async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn();
        disconnect = vi.fn();
      }
    );
    newWindow.mockReset().mockResolvedValue(true);
    frames = new Map();
    let frameId = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      const index = this.getAttribute('data-tab-index');
      return index === null
        ? new DOMRect(0, 0, 300, 40)
        : new DOMRect(Number(index) * 100, 0, 100, 40);
    });
    await TestBed.configureTestingModule({
      imports: [NautilusTabsComponent],
      providers: [
        provideTranslateService(),
        { provide: NautilusService, useValue: { openStandaloneWindow: newWindow } },
        {
          provide: MatIconRegistry,
          useValue: {
            getNamedSvgIcon: vi.fn(() =>
              of(document.createElementNS('http://www.w3.org/2000/svg', 'svg'))
            ),
            getDefaultFontSetClass: (): string[] => ['material-icons'],
          },
        },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(NautilusTabsComponent);
    component = fixture.componentInstance;
    tabs = Array.from({ length: 3 }, (_, id) => ({
      id,
      title: `Tab ${id}`,
      path: `folder/${id}`,
      remote: null,
    }));
    fixture.componentRef.setInput('tabs', tabs);
    fixture.componentRef.setInput('activeTabIndex', 0);
    fixture.detectChanges();
    elements = Array.from(fixture.nativeElement.querySelectorAll('[data-tab-index]'));
  });

  afterEach(() => {
    fixture.destroy();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('preserves clicks below the movement threshold', () => {
    const switched = vi.fn();
    const moved = vi.fn();
    component.switchTab.subscribe(switched);
    component.moveTab.subscribe(moved);
    elements[0].dispatchEvent(pointer('pointerdown', 50));
    window.dispatchEvent(pointer('pointermove', 54));
    window.dispatchEvent(pointer('pointerup', 54));
    elements[0].click();
    expect(switched).toHaveBeenCalledExactlyOnceWith(0);
    expect(moved).not.toHaveBeenCalled();
    expect(component['_dragGhost']).toBeNull();
  });

  it('reorders once and suppresses the click following a drag', () => {
    const moved = vi.fn();
    const switched = vi.fn();
    component.moveTab.subscribe(moved);
    component.switchTab.subscribe(switched);
    elements[0].dispatchEvent(pointer('pointerdown', 50));
    window.dispatchEvent(pointer('pointermove', 260));
    expect(component['_dragGhost']?.isConnected).toBe(true);
    window.dispatchEvent(pointer('pointerup', 260));
    elements[0].click();
    expect(moved).toHaveBeenCalledExactlyOnceWith({ previousIndex: 0, currentIndex: 2 });
    expect(switched).not.toHaveBeenCalled();
    expect(component['_dragGhost']).toBeNull();
    expect(component['_scrollFrame']).toBeNull();
  });

  it('ignores another pointer releasing or cancelling the gesture', () => {
    const moved = vi.fn();
    component.moveTab.subscribe(moved);
    elements[0].dispatchEvent(pointer('pointerdown', 50));
    window.dispatchEvent(pointer('pointermove', 260));
    window.dispatchEvent(pointer('pointercancel', 260, 20, 2));
    window.dispatchEvent(pointer('pointerup', 260, 20, 2));
    expect(moved).not.toHaveBeenCalled();
    expect(component['_dragGhost']).not.toBeNull();
    window.dispatchEvent(pointer('pointerup', 260));
    expect(moved).toHaveBeenCalledOnce();
  });

  it.each(['pointercancel', 'blur', 'destroy'])('cleans up without moving tabs on %s', action => {
    const moved = vi.fn();
    component.moveTab.subscribe(moved);
    elements[0].dispatchEvent(pointer('pointerdown', 50));
    window.dispatchEvent(pointer('pointermove', 295));
    const ghost = component['_dragGhost'];
    if (action === 'destroy') fixture.destroy();
    else window.dispatchEvent(action === 'blur' ? new Event('blur') : pointer(action, 295));
    window.dispatchEvent(pointer('pointerup', 295));
    expect(moved).not.toHaveBeenCalled();
    expect(ghost?.isConnected).toBe(false);
    expect(component['_scrollFrame']).toBeNull();
  });

  it('cancels when a tab disappears during a gesture', () => {
    const moved = vi.fn();
    component.moveTab.subscribe(moved);
    elements[0].dispatchEvent(pointer('pointerdown', 50));
    window.dispatchEvent(pointer('pointermove', 260));
    fixture.componentRef.setInput('tabs', tabs.slice(1));
    fixture.detectChanges();
    window.dispatchEvent(pointer('pointerup', 260));
    expect(moved).not.toHaveBeenCalled();
    expect(component['_dragGhost']).toBeNull();
  });

  it('does not start dragging from the close button', () => {
    const button = elements[0].querySelector('button');
    if (!button) throw new Error('Missing close button');
    button.dispatchEvent(pointer('pointerdown', 50));
    window.dispatchEvent(pointer('pointermove', 260));
    expect(component['_dragGhost']).toBeNull();
  });

  it('scrolls overflowing tabs while the pointer stays at the edge', () => {
    const container = fixture.nativeElement.querySelector('.tabs-scroll-container') as HTMLElement;
    elements[0].dispatchEvent(pointer('pointerdown', 50));
    window.dispatchEvent(pointer('pointermove', 295));
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach(callback => callback(0));
    expect(container.scrollLeft).toBe(12);
  });

  it('detaches a tab after a deliberate vertical drag', async () => {
    const closed = vi.fn();
    component.closeTab.subscribe(closed);
    elements[1].dispatchEvent(pointer('pointerdown', 150));
    window.dispatchEvent(pointer('pointermove', 150, 120));
    window.dispatchEvent(pointer('pointerup', 150, 120));
    await Promise.resolve();
    expect(newWindow).toHaveBeenCalledExactlyOnceWith(null, 'folder/1');
    expect(closed).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('closes the detached tab by identity after asynchronous tab reordering', async () => {
    let resolveWindow: (opened: boolean) => void = () => undefined;
    newWindow.mockReturnValue(
      new Promise<boolean>(resolve => {
        resolveWindow = resolve;
      })
    );
    const closed = vi.fn();
    component.closeTab.subscribe(closed);
    const pending = component['detachTabAction'](0);
    await component['detachTabAction'](0);
    fixture.componentRef.setInput('tabs', [tabs[1], tabs[2], tabs[0]]);
    fixture.detectChanges();
    resolveWindow(true);
    await pending;
    expect(newWindow).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledExactlyOnceWith(2);
  });

  it('keeps the tab when opening a new window fails', async () => {
    newWindow.mockRejectedValue(new Error('Window failed'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const closed = vi.fn();
    component.closeTab.subscribe(closed);
    await component['detachTabAction'](0);
    expect(closed).not.toHaveBeenCalled();
  });

  it('keeps the tab when the backend reports that no window was created', async () => {
    newWindow.mockResolvedValue(false);
    const closed = vi.fn();
    component.closeTab.subscribe(closed);
    await component['detachTabAction'](0);
    expect(closed).not.toHaveBeenCalled();
  });

  it('detaches when dragged beyond the horizontal edge', async () => {
    elements[1].dispatchEvent(pointer('pointerdown', 150));
    window.dispatchEvent(pointer('pointermove', 350));
    window.dispatchEvent(pointer('pointerup', 350));
    await Promise.resolve();
    expect(newWindow).toHaveBeenCalledExactlyOnceWith(null, 'folder/1');
  });

  it('captures the pointer and shows a top-layer preview at the grab offset', () => {
    const capture = vi.fn();
    const release = vi.fn();
    elements[0].setPointerCapture = capture;
    elements[0].hasPointerCapture = vi.fn(() => true);
    elements[0].releasePointerCapture = release;
    const showPopover = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'showPopover', {
      configurable: true,
      value: showPopover,
    });
    try {
      elements[0].dispatchEvent(pointer('pointerdown', 50));
      window.dispatchEvent(pointer('pointermove', 120, 30));
      expect(capture).toHaveBeenCalledWith(1);
      expect(showPopover).toHaveBeenCalledOnce();
      expect(component['_dragGhost']?.style.transform).toBe('translate(70px, 10px)');
      expect(component['_dragGhost']?.popover).toBe('manual');
      window.dispatchEvent(pointer('pointerup', 120, 30));
      expect(release).toHaveBeenCalledWith(1);
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, 'showPopover');
    }
  });
});
