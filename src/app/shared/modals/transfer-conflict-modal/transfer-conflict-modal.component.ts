import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatRadioModule } from '@angular/material/radio';
import { TranslatePipe } from '@ngx-translate/core';

import { FormatFileSizePipe, FormatRelativeDatePipe } from '@app/pipes';
import type { ExistingFiles } from '@app/types';
import { findCopyName } from 'src/app/services/remote/utils/unique-name.util';
import { AlertBannerComponent } from '../../components/alert-banner/alert-banner.component';
import { PillDirective } from '../../directives/pill.directive';
import { EscapeCloseDirective } from '../../directives/escape-close.directive';

/** What happens to an item that has the name of one at the destination. */
export type ConflictAction = 'replace' | 'skip' | 'keepBoth';

export interface ConflictEntry {
  name: string;
  isDir: boolean;
  size?: number;
  /** ISO time, empty or missing when it is not known. */
  modTime?: string;
}

export interface TransferConflict {
  /** What the transfer brings. */
  incoming: ConflictEntry;
  /** What the destination holds under the same name. */
  existing: ConflictEntry;
}

export interface TransferConflictModalData {
  operation: 'copy' | 'move' | 'upload';
  /** Where the items go, as the user sees it (`drive:folder`). */
  destination: string;
  /** How many items the transfer brings, conflicting or not. */
  total: number;
  conflicts: TransferConflict[];
  /** Every name the destination holds or the transfer brings, which a kept copy must avoid. */
  taken: string[];
  /** The destination does not tell `A` from `a`, so a name taken in any case is taken. */
  caseInsensitive?: boolean;
}

export interface ConflictChoice {
  action: ConflictAction;
  /** The name a kept copy lands under. */
  name?: string;
  /** For a merged folder: what happens to its files of the same name. */
  existingFiles?: ExistingFiles;
}

/** The choice for each conflicting item, by its own name. */
export type ConflictChoices = Record<string, ConflictChoice>;

/**
 * Asks how the items of a copy, move or upload that have the name of one at the destination land
 * there: replace it (merge, for a folder), skip the item or keep both under a new name. One
 * conflict is a question with a button per answer; several are a list with an answer per row.
 * Closes with the choices, or with nothing when cancelled.
 */
@Component({
  selector: 'app-transfer-conflict-modal',
  hostDirectives: [EscapeCloseDirective],
  imports: [
    MatButtonModule,
    NgTemplateOutlet,
    MatIconModule,
    MatRadioModule,
    TranslatePipe,
    FormatFileSizePipe,
    FormatRelativeDatePipe,
    AlertBannerComponent,
    PillDirective,
  ],
  templateUrl: './transfer-conflict-modal.component.html',
  styleUrl: './transfer-conflict-modal.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TransferConflictModalComponent {
  private readonly dialogRef = inject(
    MatDialogRef<TransferConflictModalComponent, ConflictChoices>
  );
  readonly data = inject<TransferConflictModalData>(MAT_DIALOG_DATA);

  readonly conflicts = this.data.conflicts;
  readonly single = this.conflicts.length === 1;
  /** Keeping both loses nothing, so every item starts with it. */
  readonly actions = signal<ConflictAction[]>(this.conflicts.map(() => 'keepBoth'));
  /** For merged folders. Keeping the newer of two files never replaces a newer one. */
  readonly existingFiles = signal<ExistingFiles>('newer');
  readonly existingFileChoices: readonly ExistingFiles[] = ['newer', 'keep', 'replace'];

  /** The name each item gets when both are kept, none of them taken by another. */
  readonly copyNames: readonly string[] = ((): string[] => {
    const taken = new Set(this.data.taken);
    return this.conflicts.map(({ incoming }) => {
      const name = findCopyName(incoming.name, incoming.isDir, taken, this.data.caseInsensitive);
      taken.add(name);
      return name;
    });
  })();

  readonly sending = computed(
    () => this.data.total - this.actions().filter(action => action === 'skip').length
  );
  /** The action every item has, if they all have the same. */
  readonly forAll = computed(() => {
    const [first, ...rest] = this.actions();
    return rest.every(action => action === first) ? first : null;
  });
  readonly anyFolders = this.conflicts.some(conflict => this.canReplace(conflict));
  readonly merges = computed(() =>
    this.conflicts.some((conflict, i) => conflict.incoming.isDir && this.actions()[i] === 'replace')
  );
  /**
   * What cannot be taken back: a replaced file, or a merge, whose undo would remove or move away
   * what was in the folder before. The single question warns before its buttons are pressed.
   */
  readonly warning = computed(() => {
    const replaces = (conflict: TransferConflict): boolean =>
      !conflict.incoming.isDir || this.existingFiles() !== 'keep';
    if (this.single) {
      const [conflict] = this.conflicts;
      if (!this.canReplace(conflict)) return null;
      return replaces(conflict)
        ? 'nautilus.conflicts.replaceWarning'
        : 'nautilus.conflicts.mergeWarning';
    }
    const actions = this.actions();
    if (this.conflicts.some((conflict, i) => actions[i] === 'replace' && replaces(conflict))) {
      return 'nautilus.conflicts.replaceWarning';
    }
    return this.merges() ? 'nautilus.conflicts.mergeWarning' : null;
  });

  /** A file replaces a file and a folder merges into a folder; a file and a folder cannot. */
  canReplace(conflict: TransferConflict): boolean {
    return conflict.incoming.isDir === conflict.existing.isDir;
  }

  /** Whether both sizes and times of two files are known, to show them side by side. */
  canCompare({ incoming, existing }: TransferConflict): boolean {
    return !incoming.isDir && !existing.isDir && !!incoming.modTime && !!existing.modTime;
  }

  setAll(action: ConflictAction): void {
    this.actions.update(actions =>
      this.conflicts.map((conflict, i) =>
        action === 'replace' && !this.canReplace(conflict) ? actions[i] : action
      )
    );
  }

  setAction(index: number, action: ConflictAction): void {
    this.actions.update(actions => actions.map((current, i) => (i === index ? action : current)));
  }

  /** The single question's answer. */
  answer(action: ConflictAction): void {
    this.setAction(0, action);
    this.confirm();
  }

  confirm(): void {
    const actions = this.actions();
    const choices: ConflictChoices = {};
    this.conflicts.forEach((conflict, i) => {
      const action = actions[i];
      choices[conflict.incoming.name] = {
        action,
        ...(action === 'keepBoth' && { name: this.copyNames[i] }),
        ...(action === 'replace' &&
          conflict.incoming.isDir && { existingFiles: this.existingFiles() }),
      };
    });
    this.dialogRef.close(choices);
  }

  cancel(): void {
    this.dialogRef.close();
  }
}
