import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialog, MatDialogRef } from '@angular/material/dialog';
import { MatIconTestingModule } from '@angular/material/icon/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialogData } from '@app/types';
import { ConfirmModalComponent } from './confirm-modal.component';

describe('ConfirmModalComponent', () => {
  let fixture: ComponentFixture<ConfirmModalComponent>;
  let dialogRef: { close: ReturnType<typeof vi.fn> };
  let data: ConfirmDialogData;

  beforeEach(() => {
    dialogRef = { close: vi.fn() };
    data = {
      title: 'nautilus.modals.delete.title',
      message: 'Delete this file?',
      confirmText: 'common.delete',
      cancelText: 'common.cancel',
      icon: 'trash',
      color: 'warn',
    };
  });

  async function setup(options: Partial<ConfirmDialogData> = {}): Promise<void> {
    await TestBed.configureTestingModule({
      imports: [ConfirmModalComponent, MatIconTestingModule],
      providers: [
        provideTranslateService(),
        { provide: MAT_DIALOG_DATA, useValue: { ...data, ...options } },
        { provide: MatDialogRef, useValue: dialogRef },
        { provide: MatDialog, useValue: { openDialogs: [dialogRef] } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ConfirmModalComponent);
    fixture.detectChanges();
  }

  it.each(['.cancel-btn', '.confirm-btn', '.modal-message'])(
    'should confirm once and prevent native activation when Enter is pressed on %s',
    async selector => {
      await setup();
      const element: HTMLElement = fixture.nativeElement.querySelector(selector);
      element.focus();
      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      });

      element.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(dialogRef.close).toHaveBeenCalledExactlyOnceWith(true);
    }
  );

  it.each([undefined, ''])('should not confirm without confirm text (%s)', async confirmText => {
    await setup({ confirmText });
    const element: HTMLElement = fixture.nativeElement;

    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(element.querySelector('.confirm-btn')).toBeNull();
    expect(dialogRef.close).not.toHaveBeenCalled();
  });

  it('should cancel when the cancel button is clicked', async () => {
    await setup();
    fixture.nativeElement.querySelector('.cancel-btn').click();

    expect(dialogRef.close).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('should confirm when the confirm button is clicked', async () => {
    await setup();
    fixture.nativeElement.querySelector('.confirm-btn').click();

    expect(dialogRef.close).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('should close without confirming when Escape is pressed', async () => {
    await setup();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(dialogRef.close).toHaveBeenCalledExactlyOnceWith();
  });
});
