import { Component, computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FormControl } from '@angular/forms';
import { describe, expect, it } from 'vitest';

import { controlVersion } from './form-signal';

describe('controlVersion', () => {
  @Component({ selector: 'app-host', template: '' })
  class HostComponent {
    readonly control = signal<FormControl | null>(new FormControl('a'));
    readonly version = controlVersion(this.control);
    readonly seen = computed(() => {
      this.version();
      return this.control()?.value ?? null;
    });
  }

  const create = (): HostComponent => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    return fixture.componentInstance;
  };

  it('moves with each value change of the control', () => {
    const host = create();
    const control = host.control() as FormControl;
    expect(host.seen()).toBe('a');

    control.setValue('b');
    expect(host.seen()).toBe('b');
    control.setValue('c');
    expect(host.seen()).toBe('c');
  });

  it('follows another control and lets go of the old one', () => {
    const host = create();
    const first = host.control() as FormControl;
    const second = new FormControl('x');
    host.control.set(second);
    TestBed.tick();
    expect(host.seen()).toBe('x');

    const before = host.version();
    first.setValue('ignored');
    expect(host.version()).toBe(before);
    second.setValue('y');
    expect(host.seen()).toBe('y');
  });

  it('copes with no control', () => {
    const host = create();
    host.control.set(null);
    TestBed.tick();
    expect(host.seen()).toBeNull();
  });
});
