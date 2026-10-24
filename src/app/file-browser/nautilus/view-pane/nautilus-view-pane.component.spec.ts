import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { MatIconRegistry } from '@angular/material/icon';
import { NautilusViewPaneComponent } from './nautilus-view-pane.component';
import { FileBrowserItem } from '@app/types';
import { NautilusService } from 'src/app/services/ui/nautilus.service';
import { NautilusDragDropService } from 'src/app/services/ui/nautilus-drag-drop.service';
import { IconService } from 'src/app/services/ui/icon.service';

function createMockItem(name: string, path = name): FileBrowserItem {
  return {
    entry: {
      ID: name,
      Name: name,
      Path: path,
      IsDir: false,
      Size: 1024,
      ModTime: '2026-01-01T00:00:00Z',
      MimeType: 'text/plain',
    },
    meta: {
      remote: 'local',
      isLocal: true,
    },
  };
}

describe('NautilusViewPaneComponent (SRC-UX-003)', () => {
  let fixture: ComponentFixture<NautilusViewPaneComponent>;
  let component: NautilusViewPaneComponent;

  const mockNautilusService = {
    starredItems: signal<FileBrowserItem[]>([]),
    toggleItem: vi.fn(),
  };

  const mockDragDrop = {
    isDragging: signal(false),
    beginInternalPointerDrag: vi.fn(),
    updateInternalPointerDrag: vi.fn(),
    commitInternalPointerDrag: vi.fn().mockResolvedValue(undefined),
    cancelInternalPointerDrag: vi.fn(),
    hoveredFolder: signal<FileBrowserItem | null>(null),
    hoveredFolderPaneIndex: signal<number | null>(null),
  };

  const mockIconService = {
    getIconForEntry: vi.fn((): string => 'file'),
  };

  const generateItems = (count: number): FileBrowserItem[] =>
    Array.from({ length: count }, (_, i) => createMockItem(`file-${i}.txt`, `path/file-${i}.txt`));

  beforeEach(async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn();
        disconnect = vi.fn();
      }
    );
    vi.clearAllMocks();
    await TestBed.configureTestingModule({
      imports: [NautilusViewPaneComponent],
      providers: [
        provideTranslateService(),
        { provide: NautilusService, useValue: mockNautilusService },
        { provide: NautilusDragDropService, useValue: mockDragDrop },
        { provide: IconService, useValue: mockIconService },
        {
          provide: MatIconRegistry,
          useValue: {
            getNamedSvgIcon: vi.fn(() =>
              of(document.createElementNS('http://www.w3.org/2000/svg', 'svg'))
            ),
            getDefaultFontSetClass: vi.fn(() => 'material-icons'),
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(NautilusViewPaneComponent);
    component = fixture.componentInstance;

    // Set required inputs
    fixture.componentRef.setInput('files', generateItems(250));
    fixture.componentRef.setInput('selection', new Set<string>());
    fixture.componentRef.setInput('paneIndex', 0);
    fixture.componentRef.setInput('isSplitEnabled', false);
    fixture.componentRef.setInput('loading', false);
    fixture.componentRef.setInput('layout', 'grid');
    fixture.componentRef.setInput('iconSize', 48);
    fixture.componentRef.setInput('listRowHeight', 32);
    fixture.componentRef.setInput('isDragging', false);
    fixture.componentRef.setInput('cutItemPaths', new Set<string>());
    fixture.componentRef.setInput('starredMode', false);
    fixture.componentRef.setInput('sortKey', 'name');
    fixture.componentRef.setInput('sortDirection', 'asc');
    fixture.componentRef.setInput('activePaneIndex', 0);
    fixture.componentRef.setInput('isItemSelectable', () => true);
    fixture.componentRef.setInput('directoryKey', 'local:docs');

    fixture.detectChanges();
  });

  afterEach(() => {
    window.dispatchEvent(new MouseEvent('mouseup'));
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(['grid', 'list'] as const)(
    'keeps selecting newly rendered batches during one %s lasso gesture',
    layout => {
      fixture.componentRef.setInput('layout', layout);
      fixture.componentRef.setInput('files', generateItems(650));
      fixture.detectChanges();

      const container = (layout === 'grid' ? component.gridContainer() : component.listContainer())
        ?.nativeElement;
      if (!container) throw new Error('Missing pane container');
      const selector = layout === 'grid' ? '.grid-item' : 'tr.mat-mdc-row';
      const frames = new Map<number, FrameRequestCallback>();
      let frameId = 0;
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        frames.set(++frameId, callback);
        return frameId;
      });
      vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
      const flushFrames = (): void => {
        const pending = [...frames.values()];
        frames.clear();
        pending.forEach(callback => callback(0));
      };
      Object.defineProperties(container, {
        clientWidth: { configurable: true, value: 100 },
        clientHeight: { configurable: true, value: 300 },
        scrollWidth: { configurable: true, value: 100 },
        scrollHeight: {
          configurable: true,
          get: () => container.querySelectorAll(selector).length * 10,
        },
      });
      Object.defineProperty(container, 'scrollBy', { configurable: true, value: vi.fn() });
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: HTMLElement
      ) {
        if (this === container) return new DOMRect(0, 0, 100, 300);
        const index = Array.from(container.querySelectorAll(selector)).indexOf(this);
        return new DOMRect(10, index * 10 - container.scrollTop, 80, 10);
      });
      let selected = new Set<string>();
      component.updateSelection.subscribe(value => {
        selected = value;
        fixture.componentRef.setInput('selection', value);
      });

      container.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 0, clientY: 0 }));
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 95, clientY: 7000 }));
      flushFrames();
      fixture.detectChanges();
      flushFrames();
      expect(selected.size).toBe(200);

      // Keep the mouse held and stationary as scrolling reveals each next batch.
      for (const count of [400, 600, 650]) {
        container.scrollTop = container.scrollHeight - container.clientHeight;
        container.dispatchEvent(new Event('scroll'));
        fixture.detectChanges();
        flushFrames();
        expect(selected.size).toBe(count);
      }

      // Shrinking the rectangle still removes items selected from later batches.
      container.scrollTop = 0;
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 95, clientY: 95 }));
      flushFrames();
      expect(selected.size).toBe(10);
      window.dispatchEvent(new MouseEvent('mouseup'));
      expect(component['_lassoRafId']).toBeNull();
      expect(component['_autoScrollRafId']).toBeNull();
    }
  );

  function startLasso(): {
    container: HTMLElement;
    frames: Map<number, FrameRequestCallback>;
    flush: () => void;
  } {
    const container = component.gridContainer()?.nativeElement;
    if (!container) throw new Error('Missing grid');
    const frames = new Map<number, FrameRequestCallback>();
    let id = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++id, callback);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (frame: number) => frames.delete(frame));
    Object.defineProperties(container, {
      clientWidth: { configurable: true, value: 300 },
      clientHeight: { configurable: true, value: 300 },
      scrollWidth: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 300 },
      scrollBy: { configurable: true, value: vi.fn() },
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      return this === container ? new DOMRect(0, 0, 300, 300) : new DOMRect(20, 20, 40, 40);
    });
    container.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 10, clientY: 10 }));
    return {
      container,
      frames,
      flush: (): void => {
        const callbacks = [...frames.values()];
        frames.clear();
        callbacks.forEach(callback => callback(0));
      },
    };
  }

  it('applies the final mouse movement when release precedes the next animation frame', () => {
    startLasso();
    const selected = vi.fn();
    component.updateSelection.subscribe(selected);
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100, clientY: 100 }));
    window.dispatchEvent(new MouseEvent('mouseup'));
    expect(selected).toHaveBeenCalledOnce();
    expect(selected.mock.calls[0][0].size).toBe(200);
  });

  it('does not change selection below the lasso movement threshold', () => {
    const { flush } = startLasso();
    fixture.componentRef.setInput('selection', new Set(['existing']));
    const selected = vi.fn();
    component.updateSelection.subscribe(selected);
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 12, clientY: 12 }));
    flush();
    expect(selected).not.toHaveBeenCalled();
  });

  it.each(['destroy', 'blur', 'directory', 'layout', 'sort'])(
    'cancels an unfinished lasso on %s and removes window listeners',
    action => {
      const { container, flush } = startLasso();
      const selected = vi.fn();
      component.updateSelection.subscribe(selected);
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100, clientY: 100 }));
      if (action === 'destroy') fixture.destroy();
      else if (action === 'blur') window.dispatchEvent(new Event('blur'));
      else {
        const inputs = {
          directory: ['directoryKey', 'local:other'],
          layout: ['layout', 'list'],
          sort: ['sortKey', 'size'],
        };
        const [key, value] = inputs[action as keyof typeof inputs];
        fixture.componentRef.setInput(key, value);
        fixture.detectChanges();
      }
      expect(component['_lassoRafId']).toBeNull();
      expect(component['_autoScrollRafId']).toBeNull();
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 200, clientY: 200 }));
      container.dispatchEvent(new Event('scroll'));
      expect(component['_lassoRafId']).toBeNull();
      expect(component['_autoScrollRafId']).toBeNull();
      flush();
      expect(selected).not.toHaveBeenCalled();
    }
  );

  it('recalculates item positions when the pane is resized mid-lasso', () => {
    let onResize: () => void = () => undefined;
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          onResize = callback;
        }
        observe = vi.fn();
        disconnect = disconnect;
      }
    );
    const { container, flush } = startLasso();
    component.updateSelection.subscribe(selection =>
      fixture.componentRef.setInput('selection', selection)
    );
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100, clientY: 100 }));
    flush();
    fixture.detectChanges();
    expect(component.selection().size).toBe(200);
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (
      this: HTMLElement
    ) {
      return this === container ? new DOMRect(0, 0, 300, 300) : new DOMRect(150, 150, 40, 40);
    });
    onResize();
    flush();
    fixture.detectChanges();
    expect(component.selection().size).toBe(0);
    window.dispatchEvent(new MouseEvent('mouseup'));
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('clears stale selection when every item disappears during a lasso', () => {
    const { flush } = startLasso();
    component.updateSelection.subscribe(selection =>
      fixture.componentRef.setInput('selection', selection)
    );
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100, clientY: 100 }));
    flush();
    fixture.detectChanges();
    expect(component.selection().size).toBe(200);
    fixture.componentRef.setInput('files', []);
    fixture.detectChanges();
    flush();
    fixture.detectChanges();
    expect(component.selection().size).toBe(0);
  });

  it('cancels an active file drag when the pane is destroyed', () => {
    const element = fixture.nativeElement.querySelector('.grid-item') as HTMLElement;
    Object.defineProperty(element, 'setPointerCapture', { value: vi.fn() });
    element.dispatchEvent(
      Object.assign(
        new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }),
        { pointerId: 1 }
      )
    );
    window.dispatchEvent(
      Object.assign(new MouseEvent('pointermove', { clientX: 40, clientY: 40 }), { pointerId: 1 })
    );
    expect(mockDragDrop.beginInternalPointerDrag).toHaveBeenCalledOnce();
    fixture.destroy();
    expect(mockDragDrop.cancelInternalPointerDrag).toHaveBeenCalledOnce();
  });

  it('limits initial progressive render batch to 200 items', () => {
    expect(component['files']().length).toBe(250);
    expect(component['renderedFiles']().length).toBe(200);
    expect(component['hasMore']()).toBe(true);
  });

  it('increments render batch when scrolled near bottom with hasMore', () => {
    const fakeScrollEvent = {
      target: {
        scrollTop: 800,
        clientHeight: 200,
        scrollHeight: 1000,
      },
    } as unknown as Event;

    component['onGridScroll'](fakeScrollEvent);
    fixture.detectChanges();

    expect(component['renderedFiles']().length).toBe(250);
    expect(component['hasMore']()).toBe(false);
  });

  it('retains render limit when files update in the same directory (no scroll snap)', () => {
    // 1. Expand render limit
    const fakeScrollEvent = {
      target: {
        scrollTop: 800,
        clientHeight: 200,
        scrollHeight: 1000,
      },
    } as unknown as Event;
    component['onGridScroll'](fakeScrollEvent);
    expect(component['renderedFiles']().length).toBe(250);

    // 2. Simulate file rename/deletion in the same directory (files array changes)
    const updatedFiles = generateItems(249);
    fixture.componentRef.setInput('files', updatedFiles);
    fixture.detectChanges();

    // Verify render limit was NOT reset back to 200
    expect(component['renderedFiles']().length).toBe(249);
  });

  it('resets render limit to 200 when directoryKey changes', () => {
    // 1. Expand render limit
    const fakeScrollEvent = {
      target: {
        scrollTop: 800,
        clientHeight: 200,
        scrollHeight: 1000,
      },
    } as unknown as Event;
    component['onGridScroll'](fakeScrollEvent);
    expect(component['renderedFiles']().length).toBe(250);

    // 2. Navigate to another directory
    fixture.componentRef.setInput('directoryKey', 'local:pictures');
    fixture.detectChanges();

    // Verify render limit is reset to 200
    expect(component['renderedFiles']().length).toBe(200);
    expect(component['hasMore']()).toBe(true);
  });

  it('resets render limit to 200 when sort changes', () => {
    // 1. Expand render limit
    const fakeScrollEvent = {
      target: {
        scrollTop: 800,
        clientHeight: 200,
        scrollHeight: 1000,
      },
    } as unknown as Event;
    component['onGridScroll'](fakeScrollEvent);
    expect(component['renderedFiles']().length).toBe(250);

    // 2. Sort column changes
    fixture.componentRef.setInput('sortKey', 'size');
    fixture.detectChanges();

    // Verify render limit is reset to 200
    expect(component['renderedFiles']().length).toBe(200);
  });

  it('emits switchPane on left click mouse down', () => {
    let switchedPane: number | null = null;
    component.switchPane.subscribe(pane => {
      switchedPane = pane;
    });

    const mouseEvent = {
      button: 0,
      target: document.createElement('div'),
      preventDefault: vi.fn(),
    } as unknown as MouseEvent;

    component['onMouseDown'](mouseEvent);
    expect(switchedPane).toBe(0);
  });

  it('emits clearSelection on container click when lasso is not active', () => {
    let clearedPane: number | null = null;
    component.clearSelection.subscribe(pane => {
      clearedPane = pane;
    });

    const clickEvent = new MouseEvent('click');
    component['onContainerClick'](clickEvent);

    expect(clearedPane).toBe(0);
  });
});
