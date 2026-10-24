import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { CdkMenuModule } from '@angular/cdk/menu';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PersistentMenuCheckboxDirective,
  PersistentMenuItemDirective,
} from './persistent-menu-item.directive';

@Component({
  imports: [CdkMenuModule, PersistentMenuItemDirective, PersistentMenuCheckboxDirective],
  template: `
    <button [cdkMenuTriggerFor]="menu">Open</button>
    <ng-template #menu>
      <div cdkMenu>
        <button
          appPersistentMenuItem
          [cdkMenuItemDisabled]="disabled()"
          (cdkMenuItemTriggered)="count.set(count() + 1)"
        >
          Adjust
        </button>
        <button
          appPersistentMenuCheckbox
          [cdkMenuItemChecked]="checked()"
          (cdkMenuItemTriggered)="checked.set(!checked())"
        >
          Toggle
        </button>
      </div>
    </ng-template>
  `,
})
class TestMenuComponent {
  readonly count = signal(0);
  readonly checked = signal(false);
  readonly disabled = signal(false);
}

describe('Persistent CDK menu controls', () => {
  let fixture: ComponentFixture<TestMenuComponent>;
  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [TestMenuComponent] });
    fixture = TestBed.createComponent(TestMenuComponent);
    fixture.detectChanges();
    fixture.nativeElement.querySelector('button').click();
    fixture.detectChanges();
  });
  afterEach(() => fixture.destroy());

  it('allows repeated adjustments without dismissing the menu', () => {
    const item = document.querySelector<HTMLButtonElement>('[role="menuitem"]');
    item?.click();
    item?.click();
    expect(fixture.componentInstance.count()).toBe(2);
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
  });

  it('preserves checkbox semantics while keeping the menu open', () => {
    const item = document.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]');
    item?.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.checked()).toBe(true);
    expect(item?.getAttribute('aria-checked')).toBe('true');
    item?.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.checked()).toBe(false);
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
  });

  it('does not trigger a disabled adjustment', () => {
    fixture.componentInstance.disabled.set(true);
    fixture.detectChanges();
    document.querySelector<HTMLButtonElement>('[role="menuitem"]')?.click();
    expect(fixture.componentInstance.count()).toBe(0);
  });
});
