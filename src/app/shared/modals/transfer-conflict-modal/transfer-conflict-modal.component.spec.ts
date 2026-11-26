import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatIconTestingModule } from '@angular/material/icon/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TransferConflict,
  TransferConflictModalComponent,
  TransferConflictModalData,
} from './transfer-conflict-modal.component';

const file = (name: string, modTime = ''): TransferConflict['incoming'] => ({
  name,
  isDir: false,
  size: 4,
  modTime,
});
const folder = (name: string): TransferConflict['incoming'] => ({ name, isDir: true });

describe('TransferConflictModalComponent', () => {
  const close = vi.fn();

  const open = (
    conflicts: TransferConflict[],
    rest: Partial<TransferConflictModalData> = {}
  ): { component: TransferConflictModalComponent; element: HTMLElement } => {
    TestBed.overrideProvider(MAT_DIALOG_DATA, {
      useValue: {
        operation: 'copy',
        destination: 'drive:docs',
        total: conflicts.length,
        conflicts,
        taken: conflicts.map(conflict => conflict.existing.name),
        ...rest,
      },
    });
    const fixture = TestBed.createComponent(TransferConflictModalComponent);
    fixture.detectChanges();
    return { component: fixture.componentInstance, element: fixture.nativeElement };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      imports: [TransferConflictModalComponent, MatIconTestingModule],
      providers: [
        provideTranslateService(),
        { provide: MatDialogRef, useValue: { close } },
        { provide: MAT_DIALOG_DATA, useValue: {} },
      ],
    });
  });

  it('answers a single file conflict with the button pressed', () => {
    const { component, element } = open([
      { incoming: file('a.txt', '2026-11-25T10:00:00Z'), existing: file('a.txt', '2026-11-01') },
    ]);
    // Both times are known, so the two files are shown side by side.
    expect(element.querySelector('.compare')).not.toBeNull();
    expect(component.warning()).toBe('nautilus.conflicts.replaceWarning');

    component.answer('replace');
    expect(close).toHaveBeenCalledExactlyOnceWith({ 'a.txt': { action: 'replace' } });
  });

  it('keeps both under a free name and does not compare what it does not know', () => {
    const { component, element } = open([{ incoming: file('a.txt'), existing: file('a.txt') }], {
      taken: ['a.txt', 'a (2).txt'],
    });
    expect(element.querySelector('.compare')).toBeNull();
    component.answer('keepBoth');
    expect(close).toHaveBeenCalledExactlyOnceWith({
      'a.txt': { action: 'keepBoth', name: 'a (3).txt' },
    });
  });

  it('merges a folder with a choice for its files of the same name, and warns it cannot be undone', () => {
    const { component, element } = open([
      { incoming: folder('Photos'), existing: folder('Photos') },
    ]);
    // Keeping the newer of two files is the default: it never replaces a newer file.
    expect(element.querySelectorAll('mat-radio-button')).toHaveLength(3);
    expect(component.existingFiles()).toBe('newer');
    expect(component.warning()).toBe('nautilus.conflicts.replaceWarning');
    component.existingFiles.set('keep');
    expect(component.warning()).toBe('nautilus.conflicts.mergeWarning');
    component.answer('replace');
    expect(close).toHaveBeenCalledExactlyOnceWith({
      Photos: { action: 'replace', existingFiles: 'keep' },
    });
  });

  it('offers no replace between a file and a folder', () => {
    const conflict = { incoming: file('x'), existing: folder('x') };
    const { component, element } = open([conflict]);
    expect(component.canReplace(conflict)).toBe(false);
    expect(component.warning()).toBeNull();
    expect(element.querySelectorAll('footer button')).toHaveLength(3);
  });

  it('lists several conflicts, each with its own answer, and counts what is still sent', () => {
    const conflicts = [
      { incoming: file('a.txt'), existing: file('a.txt') },
      { incoming: folder('Photos'), existing: folder('Photos') },
      { incoming: file('x'), existing: folder('x') },
    ];
    const { component, element } = open(conflicts, {
      total: 5,
      taken: ['a.txt', 'Photos', 'x', 'b.txt'],
    });
    expect(element.querySelectorAll('.items li')).toHaveLength(3);
    // Every item starts kept beside the one there, which loses nothing.
    expect(component.forAll()).toBe('keepBoth');
    expect(component.warning()).toBeNull();
    expect(component.copyNames).toEqual(['a (2).txt', 'Photos (2)', 'x (2)']);

    component.setAll('replace');
    // A file cannot replace a folder, so that row keeps its answer.
    expect(component.actions()).toEqual(['replace', 'replace', 'keepBoth']);
    expect(component.forAll()).toBeNull();
    expect(component.merges()).toBe(true);
    expect(component.warning()).toBe('nautilus.conflicts.replaceWarning');

    component.setAction(0, 'skip');
    component.existingFiles.set('keep');
    expect(component.warning()).toBe('nautilus.conflicts.mergeWarning');
    expect(component.sending()).toBe(4);

    component.confirm();
    expect(close).toHaveBeenCalledExactlyOnceWith({
      'a.txt': { action: 'skip' },
      Photos: { action: 'replace', existingFiles: 'keep' },
      x: { action: 'keepBoth', name: 'x (2)' },
    });
  });

  it('closes with nothing when cancelled', () => {
    const { component } = open([
      { incoming: file('a'), existing: file('a') },
      { incoming: file('b'), existing: file('b') },
    ]);
    component.setAll('skip');
    expect(component.sending()).toBe(0);
    component.cancel();
    expect(close).toHaveBeenCalledExactlyOnceWith();
  });
});
