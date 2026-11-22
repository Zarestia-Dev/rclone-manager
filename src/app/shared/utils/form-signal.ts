import { effect, signal, type Signal } from '@angular/core';
import type { AbstractControl } from '@angular/forms';

/**
 * A signal that moves each time the value of the control that `source` gives changes. It follows
 * `source` when that gives another control or none. A `computed` reads it before it reads the
 * control's value, and so runs again when the value changes: a form control is no signal itself.
 *
 * Call it where an injection context exists (a field initializer or a constructor). A change
 * made with `emitEvent: false` is not seen.
 */
export function controlVersion(source: () => AbstractControl | null | undefined): Signal<number> {
  const version = signal(0);
  effect(onCleanup => {
    const subscription = source()?.valueChanges.subscribe(() => version.update(value => value + 1));
    onCleanup(() => subscription?.unsubscribe());
  });
  return version.asReadonly();
}
