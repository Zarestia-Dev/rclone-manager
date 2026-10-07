import { Component, ChangeDetectionStrategy, inject, signal, computed } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef, MatDialogModule } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatDividerModule } from '@angular/material/divider';
import { MatExpansionModule } from '@angular/material/expansion';
import { TranslatePipe } from '@ngx-translate/core';

import { UserPresetTemplate, TemplateCategory } from '@app/types';
import { EscapeCloseDirective } from '../../directives/escape-close.directive';
import {
  computeTemplateDiff,
  filterTemplateValues,
  ApplyStrategy,
  TemplateDiffResult,
} from '../template-diff.utils';

export interface ApplyTemplateModalData {
  template: UserPresetTemplate;
  currentValues?: Partial<Record<TemplateCategory, Record<string, unknown>>>;
  applicableCategories?: readonly TemplateCategory[];
}

export interface ApplyTemplateModalResult {
  applied: boolean;
  values: Partial<Record<TemplateCategory, Record<string, unknown>>>;
  strategy: ApplyStrategy;
}

@Component({
  selector: 'app-apply-template-modal',
  hostDirectives: [EscapeCloseDirective],
  imports: [
    MatDialogModule,
    MatIconModule,
    MatButtonModule,
    MatCheckboxModule,
    MatDividerModule,
    MatExpansionModule,
    TranslatePipe,
  ],
  templateUrl: './apply-template-modal.component.html',
  styleUrls: ['./apply-template-modal.component.scss', '../../../styles/_shared-modal.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ApplyTemplateModalComponent {
  private readonly dialogRef = inject(
    MatDialogRef<ApplyTemplateModalComponent, ApplyTemplateModalResult>
  );
  readonly data = inject<ApplyTemplateModalData>(MAT_DIALOG_DATA);

  readonly template = this.data.template;
  readonly strategy = signal<ApplyStrategy>('overwrite');

  readonly diffResult = computed<TemplateDiffResult>(() =>
    computeTemplateDiff(
      this.data?.currentValues,
      this.template?.values,
      this.data?.applicableCategories
    )
  );

  readonly selectedCategories = signal<Set<TemplateCategory>>(
    new Set(this.diffResult().categories)
  );

  readonly filteredValues = computed(() =>
    filterTemplateValues(this.template?.values ?? {}, {
      strategy: this.strategy(),
      selectedCategories: Array.from(this.selectedCategories()),
      currentValues: this.data?.currentValues,
      applicableCategories: this.data?.applicableCategories,
    })
  );

  readonly filteredKeysCount = computed(() => {
    const vals = this.filteredValues();
    let count = 0;
    for (const catObj of Object.values(vals)) {
      if (catObj && typeof catObj === 'object') {
        count += Object.keys(catObj).length;
      }
    }
    return count;
  });

  setStrategy(strategy: ApplyStrategy): void {
    this.strategy.set(strategy);
  }

  isCategorySelected(cat: TemplateCategory): boolean {
    return this.selectedCategories().has(cat);
  }

  toggleCategory(cat: TemplateCategory): void {
    this.selectedCategories.update(set => {
      const next = new Set(set);
      if (next.has(cat)) {
        next.delete(cat);
      } else {
        next.add(cat);
      }
      return next;
    });
  }

  onApply(): void {
    this.dialogRef.close({
      applied: true,
      values: this.filteredValues(),
      strategy: this.strategy(),
    });
  }

  onClose(): void {
    this.dialogRef.close();
  }
}
