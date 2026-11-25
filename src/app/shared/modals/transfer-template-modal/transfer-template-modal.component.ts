import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { TranslatePipe } from '@ngx-translate/core';

import { TemplateCategory } from '@app/types';
import { UserTemplateService } from 'src/app/services/remote/user-template.service';
import { AppSettingsService } from 'src/app/services/settings/app-settings.service';
import { ModalService } from 'src/app/services/ui/modal.service';
import { EscapeCloseDirective } from '../../directives/escape-close.directive';
import { PillDirective } from '../../directives/pill.directive';

export interface TransferTemplateModalData {
  /** The file browser's default template, preselected; empty for none. */
  selected: string;
  operation: 'upload' | 'copy' | 'move';
  count: number;
  /** Where the items go, as the user sees it (`drive:folder`). */
  destination: string;
}

interface OptionGroup {
  category: TemplateCategory;
  entries: { key: string; value: string }[];
}

/**
 * Asks which user template a file browser transfer runs with, and shows what that template sets
 * for it. Closes with the chosen id ('' for none), or with nothing when the transfer is cancelled.
 */
@Component({
  selector: 'app-transfer-template-modal',
  hostDirectives: [EscapeCloseDirective],
  imports: [
    MatButtonModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatIconModule,
    MatSelectModule,
    TranslatePipe,
    PillDirective,
  ],
  templateUrl: './transfer-template-modal.component.html',
  styleUrls: ['./transfer-template-modal.component.scss', '../../../styles/_shared-modal.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TransferTemplateModalComponent {
  private readonly dialogRef = inject(MatDialogRef<TransferTemplateModalComponent, string>);
  private readonly modalService = inject(ModalService);
  private readonly appSettings = inject(AppSettingsService);
  readonly data = inject<TransferTemplateModalData>(MAT_DIALOG_DATA);
  readonly templates = inject(UserTemplateService).userTemplates;

  private readonly choice = signal(this.data.selected);
  /** A default template that was deleted is not offered; the transfer then runs without one. */
  readonly selected = computed(() =>
    this.templates().some(template => template.id === this.choice()) ? this.choice() : ''
  );
  readonly useAsDefault = signal(false);
  readonly dontAskAgain = signal(false);

  /** The categories of a template this transfer reads, as the backend does. */
  private readonly categories: readonly TemplateCategory[] = [
    this.data.operation === 'move' ? 'move' : 'copy',
    'filter',
    'backend',
  ];

  readonly chosen = computed(() => this.templates().find(t => t.id === this.selected()));
  readonly optionGroups = computed<OptionGroup[]>(() => {
    const values = this.chosen()?.values ?? {};
    return this.categories
      .map(category => ({
        category,
        entries: Object.entries(values[category] ?? {}).map(([key, value]) => ({
          key,
          value: typeof value === 'string' ? value : JSON.stringify(value),
        })),
      }))
      .filter(group => group.entries.length > 0);
  });

  select(id: string): void {
    this.choice.set(id);
  }

  /** Templates are made and changed in the template manager; the list follows it. */
  openTemplateManager(mode: 'save' | 'manage'): void {
    const before = new Set(this.templates().map(template => template.id));
    this.modalService
      .openTemplateManager({ mode })
      .afterClosed()
      .subscribe(() => {
        const created = this.templates().find(template => !before.has(template.id));
        if (created) this.choice.set(created.id);
      });
  }

  async start(): Promise<void> {
    const selected = this.selected();
    const saves: Promise<void>[] = [];
    if (this.useAsDefault()) {
      saves.push(this.appSettings.saveSetting('file_browser', 'transfer_template', selected));
    }
    if (this.dontAskAgain()) {
      saves.push(this.appSettings.saveSetting('file_browser', 'ask_transfer_template', false));
    }
    // The transfer starts either way; a preference that could not be saved is only logged.
    await Promise.all(saves).catch(error =>
      console.error('[TransferTemplateModal] Cannot save the transfer preferences', error)
    );
    this.dialogRef.close(selected);
  }

  cancel(): void {
    this.dialogRef.close();
  }
}
