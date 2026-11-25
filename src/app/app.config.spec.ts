import { Component, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DEFAULT_OPTIONS, MatDialog } from '@angular/material/dialog';
import { MATERIAL_ANIMATIONS } from '@angular/material/core';
import { afterEach, describe, expect, it } from 'vitest';
import { DIALOG_DEFAULT_OPTIONS } from './app.config';

@Component({
  template: `<p>Dialog body</p>
    <button type="button">Inside</button>`,
})
class TestDialogComponent {}

@Component({
  template: `<button type="button" id="trigger" (click)="open()">Open</button>`,
})
class TriggerComponent {
  private readonly dialog = inject(MatDialog);
  ref = null as ReturnType<MatDialog['open']> | null;
  open(): void {
    this.ref = this.dialog.open(TestDialogComponent, { disableClose: true });
  }
}

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve));

describe('DIALOG_DEFAULT_OPTIONS', () => {
  afterEach(() => TestBed.inject(MatDialog).closeAll());

  it('keeps Material defaults that dialogs need for assistive technology', () => {
    expect(DIALOG_DEFAULT_OPTIONS).toMatchObject({
      role: 'dialog',
      autoFocus: 'first-tabbable',
      restoreFocus: true,
      closeOnNavigation: false,
    });
  });

  it('opens a dialog with its role, moves focus into it, and returns focus on close', async () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: MAT_DIALOG_DEFAULT_OPTIONS, useValue: DIALOG_DEFAULT_OPTIONS },
        { provide: MATERIAL_ANIMATIONS, useValue: { animationsDisabled: true } },
      ],
    });
    const fixture = TestBed.createComponent(TriggerComponent);
    fixture.detectChanges();
    document.body.appendChild(fixture.nativeElement);
    const trigger = fixture.nativeElement.querySelector('#trigger') as HTMLButtonElement;
    trigger.focus();
    trigger.click();
    await fixture.whenStable();
    await settle();

    const container = document.querySelector('mat-dialog-container');
    expect(container?.getAttribute('role')).toBe('dialog');
    // The dialog's first tabbable element, or the dialog itself where the test DOM has no layout.
    expect(container?.contains(document.activeElement)).toBe(true);

    fixture.componentInstance.ref?.close();
    await fixture.whenStable();
    await settle();
    expect(document.activeElement).toBe(trigger);
    fixture.nativeElement.remove();
  });
});
