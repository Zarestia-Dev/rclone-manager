import { Directive, forwardRef } from '@angular/core';
import { CdkMenuItem, CdkMenuItemCheckbox } from '@angular/cdk/menu';

/** Settings controls should allow repeated adjustments without dismissing the menu. */
@Directive({
  selector: '[appPersistentMenuItem]',
  providers: [{ provide: CdkMenuItem, useExisting: forwardRef(() => PersistentMenuItemDirective) }],
})
export class PersistentMenuItemDirective extends CdkMenuItem {
  override trigger(options?: { keepOpen: boolean }): void {
    super.trigger({ ...options, keepOpen: true });
  }
}

@Directive({
  selector: '[appPersistentMenuCheckbox]',
  providers: [
    { provide: CdkMenuItem, useExisting: forwardRef(() => PersistentMenuCheckboxDirective) },
  ],
})
export class PersistentMenuCheckboxDirective extends CdkMenuItemCheckbox {
  override trigger(options?: { keepOpen: boolean }): void {
    super.trigger({ ...options, keepOpen: true });
  }
}
