import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LongPressDirective } from './long-press.directive';

@Component({
  template: `
    <button
      appLongPress
      [longPressDuration]="duration"
      [longPressDisabled]="isDisabled()"
      (longPress)="onLongPress()"
      (longPressProgress)="onProgress($event)"
      (longPressCancel)="onCancel()"
    >
      Test Button
    </button>
  `,
  imports: [LongPressDirective],
})
class TestHostComponent {
  duration = 500;
  readonly isDisabled = signal(false);
  pressTriggered = false;
  cancelled = false;
  lastProgress = 0;

  onLongPress(): void {
    this.pressTriggered = true;
  }

  onProgress(val: number): void {
    this.lastProgress = val;
  }

  onCancel(): void {
    this.cancelled = true;
  }
}

describe('LongPressDirective', () => {
  let fixture: ComponentFixture<TestHostComponent>;
  let component: TestHostComponent;
  let button: HTMLButtonElement;

  beforeEach(async () => {
    vi.useFakeTimers();

    await TestBed.configureTestingModule({
      imports: [TestHostComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(TestHostComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    button = fixture.nativeElement.querySelector('button');
  });

  afterEach(() => {
    button?.dispatchEvent(new PointerEvent('pointerup'));
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('should create an instance via host component', () => {
    expect(button).toBeTruthy();
  });

  it('should emit longPress and progress when held for duration', () => {
    const pointerDown = new PointerEvent('pointerdown', { button: 0 });
    button.dispatchEvent(pointerDown);

    vi.advanceTimersByTime(250);
    expect(component.pressTriggered).toBe(false);

    vi.advanceTimersByTime(300);
    expect(component.pressTriggered).toBe(true);
  });

  it('should cancel and emit longPressCancel if released before duration', () => {
    const pointerDown = new PointerEvent('pointerdown', { button: 0 });
    button.dispatchEvent(pointerDown);

    vi.advanceTimersByTime(200);
    expect(component.pressTriggered).toBe(false);

    const pointerUp = new PointerEvent('pointerup');
    button.dispatchEvent(pointerUp);

    expect(component.cancelled).toBe(true);
    expect(component.pressTriggered).toBe(false);
  });

  it('should ignore non-primary pointer button', () => {
    const rightClickDown = new PointerEvent('pointerdown', { button: 2 });
    button.dispatchEvent(rightClickDown);

    vi.advanceTimersByTime(600);
    expect(component.pressTriggered).toBe(false);
  });

  it('should not trigger if disabled', () => {
    component.isDisabled.set(true);
    fixture.detectChanges();

    const pointerDown = new PointerEvent('pointerdown', { button: 0 });
    button.dispatchEvent(pointerDown);

    vi.advanceTimersByTime(600);
    expect(component.pressTriggered).toBe(false);
  });

  it('should cancel if pointer moves beyond threshold (touch scroll)', () => {
    const pointerDown = new PointerEvent('pointerdown', { button: 0, clientX: 10, clientY: 10 });
    button.dispatchEvent(pointerDown);

    vi.advanceTimersByTime(100);

    const pointerMove = new PointerEvent('pointermove', { clientX: 30, clientY: 30 });
    button.dispatchEvent(pointerMove);

    expect(component.cancelled).toBe(true);

    vi.advanceTimersByTime(500);
    expect(component.pressTriggered).toBe(false);
  });

  it('should suppress trailing click event after long press triggers', () => {
    const pointerDown = new PointerEvent('pointerdown', { button: 0 });
    button.dispatchEvent(pointerDown);

    vi.advanceTimersByTime(600);
    expect(component.pressTriggered).toBe(true);

    const clickEvent = new MouseEvent('click', { cancelable: true });
    const prevented = !button.dispatchEvent(clickEvent);
    expect(prevented).toBe(true);
  });
});
