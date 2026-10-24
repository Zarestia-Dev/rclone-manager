import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MENU_TRIGGER } from '@angular/cdk/menu';
import { CdkOverlayAutoposDirective } from './cdk-overlay-autopos.directive';

@Component({
  imports: [CdkOverlayAutoposDirective],
  template: `<div appCdkOverlayAutopos>Menu Content</div>`,
})
class TestHostComponent {}

describe('CdkOverlayAutoposDirective', () => {
  let fixture: ComponentFixture<TestHostComponent>;
  let mockOverlayRef: { updatePosition: ReturnType<typeof vi.fn> };
  let mockTrigger: { overlayRef: typeof mockOverlayRef };
  let resizeObserverCallback: ResizeObserverCallback | null = null;
  let disconnectSpy: ReturnType<typeof vi.fn>;
  let observeSpy: ReturnType<typeof vi.fn>;

  class MockResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      resizeObserverCallback = callback;
    }
    observe = observeSpy;
    unobserve = vi.fn();
    disconnect = disconnectSpy;
  }

  beforeEach(() => {
    mockOverlayRef = { updatePosition: vi.fn() };
    mockTrigger = { overlayRef: mockOverlayRef };
    disconnectSpy = vi.fn();
    observeSpy = vi.fn();
    resizeObserverCallback = null;

    vi.stubGlobal('ResizeObserver', MockResizeObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should observe element and update overlay position on resize when trigger exists', () => {
    TestBed.configureTestingModule({
      imports: [TestHostComponent],
      providers: [{ provide: MENU_TRIGGER, useValue: mockTrigger }],
    });

    fixture = TestBed.createComponent(TestHostComponent);
    fixture.detectChanges();

    expect(observeSpy).toHaveBeenCalledWith(fixture.nativeElement.querySelector('div'));

    // Trigger resize observer callback
    if (resizeObserverCallback) {
      resizeObserverCallback([], {} as ResizeObserver);
    }

    expect(mockOverlayRef.updatePosition).toHaveBeenCalled();
  });

  it('should disconnect ResizeObserver on destroy', () => {
    TestBed.configureTestingModule({
      imports: [TestHostComponent],
      providers: [{ provide: MENU_TRIGGER, useValue: mockTrigger }],
    });

    fixture = TestBed.createComponent(TestHostComponent);
    fixture.detectChanges();
    fixture.destroy();

    expect(disconnectSpy).toHaveBeenCalled();
  });

  it('should handle missing trigger gracefully without errors', () => {
    TestBed.configureTestingModule({
      imports: [TestHostComponent],
      providers: [{ provide: MENU_TRIGGER, useValue: null }],
    });

    fixture = TestBed.createComponent(TestHostComponent);
    expect(() => fixture.detectChanges()).not.toThrow();

    const cb = resizeObserverCallback;
    if (cb) {
      expect(() => cb([], {} as ResizeObserver)).not.toThrow();
    }
  });
});
