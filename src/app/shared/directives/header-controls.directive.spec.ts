import { NgTemplateOutlet } from '@angular/common';
import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatExpansionModule } from '@angular/material/expansion';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HeaderControlsDirective } from './header-controls.directive';

@Component({
  imports: [MatExpansionModule, NgTemplateOutlet, HeaderControlsDirective],
  template: `
    <ng-template #actions>
      <button type="button" class="edit" (click)="edited = edited + 1">Edit</button>
    </ng-template>
    <mat-expansion-panel>
      <mat-expansion-panel-header>
        <mat-panel-title>Title</mat-panel-title>
        <span
          class="header-controls-slot"
          data-header-controls-slot="actions"
          aria-hidden="true"
          inert
        >
          <ng-container [ngTemplateOutlet]="actions" />
        </span>
      </mat-expansion-panel-header>
      <span appHeaderControls="actions" ngProjectAs="mat-expansion-panel-header">
        <ng-container [ngTemplateOutlet]="actions" />
      </span>
      <p>Body</p>
    </mat-expansion-panel>
  `,
})
class TestHostComponent {
  edited = 0;
}

describe('HeaderControlsDirective', () => {
  let fixture: ComponentFixture<TestHostComponent>;

  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn();
        disconnect = vi.fn();
      }
    );
    TestBed.configureTestingModule({
      imports: [TestHostComponent],
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  function render(): HTMLElement {
    fixture = TestBed.createComponent(TestHostComponent);
    fixture.detectChanges();
    return fixture.nativeElement;
  }

  it('keeps the real controls out of the header, beside it and outside the panel body', () => {
    const el = render();
    const header = el.querySelector('mat-expansion-panel-header') as HTMLElement;
    const controls = el.querySelector('.header-controls') as HTMLElement;

    expect(header.querySelector('.header-controls')).toBeNull();
    expect(controls.parentElement?.matches('mat-expansion-panel')).toBe(true);
    expect(controls.previousElementSibling).toBe(header);
    expect(el.querySelector('.mat-expansion-panel-body .header-controls')).toBeNull();
  });

  it('leaves only an inert, hidden copy inside the header', () => {
    const el = render();
    const slot = el.querySelector(
      'mat-expansion-panel-header .header-controls-slot'
    ) as HTMLElement;
    expect(slot.hasAttribute('inert')).toBe(true);
    expect(slot.getAttribute('aria-hidden')).toBe('true');
    expect(slot.querySelector('button.edit')).not.toBeNull();
  });

  it('acts on the real control without toggling the panel', () => {
    const el = render();
    (el.querySelector('.header-controls button.edit') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(fixture.componentInstance.edited).toBe(1);
    expect(el.querySelector('mat-expansion-panel')?.classList).not.toContain('mat-expanded');
  });

  it('places the controls over the slot, with its size and inherited text style', () => {
    const el = render();
    const panel = el.querySelector('mat-expansion-panel') as HTMLElement;
    const header = el.querySelector('mat-expansion-panel-header') as HTMLElement;
    const slot = el.querySelector('.header-controls-slot') as HTMLElement;
    const controls = el.querySelector('.header-controls') as HTMLElement;
    // jsdom has no layout: give the slot and the header a geometry.
    const define = (target: HTMLElement, values: Record<string, unknown>): void => {
      for (const [key, value] of Object.entries(values)) {
        Object.defineProperty(target, key, { configurable: true, value });
      }
    };
    define(controls, { offsetParent: panel });
    define(header, { offsetParent: panel, offsetLeft: 0, offsetTop: 0, clientLeft: 0 });
    define(slot, {
      offsetParent: header,
      offsetLeft: 300,
      offsetTop: 16,
      offsetWidth: 40,
      offsetHeight: 40,
    });
    slot.style.fontWeight = '600';
    // Offsets are whole pixels; client rects keep the fraction the controls must match. The
    // controls start at the rounded position, so their rect is half a pixel short of the slot's.
    const rect = (left: number, top: number, width: number): DOMRect =>
      ({ left, top, width, height: 40 }) as DOMRect;
    vi.spyOn(slot, 'getBoundingClientRect').mockReturnValue(rect(300.5, 16.25, 40.5));
    vi.spyOn(controls, 'getBoundingClientRect').mockReturnValue(rect(300, 16, 40));
    define(controls, { offsetParent: panel, offsetWidth: 40 });

    (
      fixture.debugElement
        .query(el => el.nativeElement === controls)
        .injector.get(HeaderControlsDirective) as unknown as { place(): void }
    ).place();

    expect(controls.style.left).toBe('300.5px');
    expect(controls.style.top).toBe('16.25px');
    expect(controls.style.width).toBe('40.5px');
    expect(controls.style.height).toBe('40px');
    expect(controls.style.fontWeight).toBe('600');
  });
});
