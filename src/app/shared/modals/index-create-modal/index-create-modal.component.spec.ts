import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { IndexCreateModalComponent } from './index-create-modal.component';

describe('IndexCreateModalComponent', () => {
  let component: IndexCreateModalComponent;
  let dialogRef: { close: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    dialogRef = { close: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        provideTranslateService(),
        { provide: MatDialogRef, useValue: dialogRef },
        { provide: MAT_DIALOG_DATA, useValue: { target: 'drive:/site' } },
      ],
    });
    // The form is the part under test; the rows are rendered by setting-control, which has its own spec.
    component = TestBed.createComponent(IndexCreateModalComponent).componentInstance;
  });

  it('starts at the defaults of rclone index', () => {
    component.onConfirm();

    expect(dialogRef.close).toHaveBeenCalledExactlyOnceWith({
      output: ['index.html=html'],
      maxDepth: -1,
      IncludeRule: [],
      ExcludeRule: [],
      dirTime: 'newest',
      noModTime: false,
      linkIndex: false,
      UseServerModTime: false,
      rewrite: false,
    });
  });

  it('closes with the choices made in the form, by rclone names', () => {
    component.form.patchValue({
      output: ['index.json=json'],
      maxDepth: 2,
      ExcludeRule: ['/private/**'],
      dirTime: 'dir',
      UseServerModTime: true,
    });

    component.onConfirm();

    expect(dialogRef.close).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        output: ['index.json=json'],
        maxDepth: 2,
        ExcludeRule: ['/private/**'],
        dirTime: 'dir',
        UseServerModTime: true,
      })
    );
  });

  it('cannot be confirmed without a listing format', () => {
    component.form.controls['output'].setValue([]);

    expect(component.form.invalid).toBe(true);
    component.onConfirm();

    expect(dialogRef.close).not.toHaveBeenCalled();
  });

  it('closes without a result when dismissed', () => {
    component.dismiss();

    expect(dialogRef.close).toHaveBeenCalledExactlyOnceWith();
  });
});
