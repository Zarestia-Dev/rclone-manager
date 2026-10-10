import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { MatDialog, MatDialogRef } from '@angular/material/dialog';
import { EscapeCloseDirective } from './escape-close.directive';

@Component({
  imports: [EscapeCloseDirective],
  template: `<div appEscapeClose>Dialog Content</div>`,
})
class TestHostComponent {}

describe('EscapeCloseDirective', () => {
  let fixture: ComponentFixture<TestHostComponent>;
  let mockDialogRef: { close: ReturnType<typeof vi.fn> };
  let mockOtherDialogRef: { close: ReturnType<typeof vi.fn> };
  let mockDialog: { openDialogs: unknown[] };

  beforeEach(() => {
    mockDialogRef = { close: vi.fn() };
    mockOtherDialogRef = { close: vi.fn() };
    mockDialog = { openDialogs: [mockDialogRef] };
  });

  it('should close dialog when Escape is pressed and dialog is top of stack', () => {
    TestBed.configureTestingModule({
      imports: [TestHostComponent],
      providers: [
        { provide: MatDialogRef, useValue: mockDialogRef },
        { provide: MatDialog, useValue: mockDialog },
      ],
    });

    fixture = TestBed.createComponent(TestHostComponent);
    fixture.detectChanges();

    const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape' });
    document.dispatchEvent(escapeEvent);

    expect(mockDialogRef.close).toHaveBeenCalledTimes(1);
  });

  it('should NOT close dialog when Escape is pressed and another dialog is top of stack', () => {
    mockDialog.openDialogs = [mockDialogRef, mockOtherDialogRef];

    TestBed.configureTestingModule({
      imports: [TestHostComponent],
      providers: [
        { provide: MatDialogRef, useValue: mockDialogRef },
        { provide: MatDialog, useValue: mockDialog },
      ],
    });

    fixture = TestBed.createComponent(TestHostComponent);
    fixture.detectChanges();

    const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape' });
    document.dispatchEvent(escapeEvent);

    expect(mockDialogRef.close).not.toHaveBeenCalled();
  });

  it('should not throw when MatDialogRef is not provided', () => {
    TestBed.configureTestingModule({
      imports: [TestHostComponent],
      providers: [{ provide: MatDialog, useValue: mockDialog }],
    });

    fixture = TestBed.createComponent(TestHostComponent);
    fixture.detectChanges();

    const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape' });
    expect(() => document.dispatchEvent(escapeEvent)).not.toThrow();
  });
});
