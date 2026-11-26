import { ApplicationRef as ApplicationRefToken, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatDialog, MatDialogRef, MAT_DIALOG_DEFAULT_OPTIONS } from '@angular/material/dialog';
import { MATERIAL_ANIMATIONS } from '@angular/material/core';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DialogLabelsService } from './dialog-labels.service';
import { DIALOG_DEFAULT_OPTIONS } from 'src/app/app.config';

@Component({
  template: `<header>
      <button type="button" aria-label="Close">x</button>
      <p>Quick Add Remote</p>
    </header>
    <main><p>Body text</p></main>`,
})
class TitledDialogComponent {}

@Component({
  template: `<header><div role="tablist"></div></header>
    <main><p>Body text</p></main>`,
})
class UntitledDialogComponent {}

@Component({
  template: `<div>
    <h2>Delete remote?</h2>
    <p>This cannot be undone.</p>
  </div>`,
})
class ConfirmLikeDialogComponent {}

describe('DialogLabelsService', () => {
  let dialog: MatDialog;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        { provide: MAT_DIALOG_DEFAULT_OPTIONS, useValue: DIALOG_DEFAULT_OPTIONS },
        { provide: MATERIAL_ANIMATIONS, useValue: { animationsDisabled: true } },
      ],
    });
    TestBed.inject(DialogLabelsService);
    dialog = TestBed.inject(MatDialog);
  });

  afterEach(() => dialog.closeAll());

  const openAndSettle = async (ref: MatDialogRef<unknown>): Promise<HTMLElement> => {
    await firstValueFrom(ref.afterOpened());
    await TestBed.inject(ApplicationRefToken).whenStable();
    return document.getElementById(ref.id) as HTMLElement;
  };

  it('names a dialog after the title in its header, not its buttons or body', async () => {
    const container = await openAndSettle(dialog.open(TitledDialogComponent));
    const id = container.getAttribute('aria-labelledby');
    expect(id).toBeTruthy();
    expect(document.getElementById(id as string)?.textContent?.trim()).toBe('Quick Add Remote');
  });

  it('names a dialog without a header after its first heading', async () => {
    const container = await openAndSettle(dialog.open(ConfirmLikeDialogComponent));
    const id = container.getAttribute('aria-labelledby') as string;
    expect(document.getElementById(id)?.textContent?.trim()).toBe('Delete remote?');
  });

  it('keeps an aria-label given when the dialog opens', async () => {
    const container = await openAndSettle(
      dialog.open(TitledDialogComponent, { ariaLabel: 'Preferences' })
    );
    expect(container.getAttribute('aria-label')).toBe('Preferences');
    expect(container.hasAttribute('aria-labelledby')).toBe(false);
  });

  it('leaves a dialog without a header title unlabelled rather than guessing', async () => {
    const container = await openAndSettle(dialog.open(UntitledDialogComponent));
    expect(container.hasAttribute('aria-labelledby')).toBe(false);
  });
});
