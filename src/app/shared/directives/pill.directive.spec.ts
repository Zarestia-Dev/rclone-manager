import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import type { PillTone, PillVariant } from '@app/types';
import { PillDirective } from './pill.directive';

@Component({
  imports: [PillDirective],
  template: `
    <span id="plain" appPill>Plain</span>
    <span id="static" appPill="solid" tone="accent" size="xs">Static</span>
    <span id="dynamic" [appPill]="variant()" [tone]="tone()">Dynamic</span>
    <button id="toggle" type="button" appPill tone="primary" [selected]="selected()">Toggle</button>
    <button id="action" type="button" appPill>Action</button>
  `,
})
class HostComponent {
  readonly variant = signal<PillVariant | ''>('');
  readonly tone = signal<PillTone | null>(null);
  readonly selected = signal(false);
}

describe('PillDirective', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;

  const pill = (id: string): HTMLElement =>
    (fixture.nativeElement as HTMLElement).querySelector(`#${id}`) as HTMLElement;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('adds the [appPill] class and no state attributes to a bare pill', () => {
    const el = pill('plain');
    expect(el.classList.contains('app-pill')).toBe(true);
    for (const name of ['tone', 'variant', 'size', 'selected']) {
      expect(el.hasAttribute(`data-${name}`)).toBe(false);
    }
    expect(el.hasAttribute('aria-pressed')).toBe(false);
  });

  it('reflects the emphasis, tone and size on the element', () => {
    const el = pill('static');
    expect(el.dataset['variant']).toBe('solid');
    expect(el.dataset['tone']).toBe('accent');
    expect(el.dataset['size']).toBe('xs');
  });

  it('follows a bound tone and variant, and drops them again', () => {
    host.tone.set('warn');
    host.variant.set('outline');
    fixture.detectChanges();
    expect(pill('dynamic').dataset['tone']).toBe('warn');
    expect(pill('dynamic').dataset['variant']).toBe('outline');

    host.tone.set(null);
    host.variant.set('');
    fixture.detectChanges();
    expect(pill('dynamic').hasAttribute('data-tone')).toBe(false);
    expect(pill('dynamic').hasAttribute('data-variant')).toBe(false);
  });

  it('does not mark the default size', () => {
    expect(pill('plain').hasAttribute('data-size')).toBe(false);
  });

  it('marks a toggle as pressed or not, and leaves other pills alone', () => {
    expect(pill('toggle').getAttribute('aria-pressed')).toBe('false');
    expect(pill('toggle').hasAttribute('data-selected')).toBe(false);

    host.selected.set(true);
    fixture.detectChanges();
    expect(pill('toggle').getAttribute('aria-pressed')).toBe('true');
    expect(pill('toggle').hasAttribute('data-selected')).toBe(true);

    expect(pill('action').hasAttribute('aria-pressed')).toBe(false);
  });
});
