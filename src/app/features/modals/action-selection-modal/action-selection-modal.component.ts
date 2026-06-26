import { ChangeDetectionStrategy, Component, inject, signal, computed } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';
import { TranslateModule } from '@ngx-translate/core';
import { ACTION_CONFIGS, ActionConfig, PrimaryActionType, MODE_DEFAULTS } from '@app/types';

export interface ActionSelectionModalData {
  remoteName: string;
  primaryActions: PrimaryActionType[];
  allowedKeys?: PrimaryActionType[];
}

export interface ActionSelectionItem {
  key: PrimaryActionType;
  label: string;
  icon: string;
  isStarred: boolean;
}

@Component({
  selector: 'app-action-selection-modal',
  imports: [MatButtonModule, MatIconModule, MatTooltipModule, DragDropModule, TranslateModule],
  templateUrl: './action-selection-modal.component.html',
  styleUrls: ['./action-selection-modal.component.scss', '../../../styles/_shared-modal.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(keydown.escape)': 'onCancel()',
  },
})
export class ActionSelectionModalComponent {
  private readonly dialogRef = inject(MatDialogRef<ActionSelectionModalComponent>);
  private readonly data = inject<ActionSelectionModalData>(MAT_DIALOG_DATA);

  readonly remoteName = this.data.remoteName;
  readonly maxStarred = 3;

  private readonly allowedKeys = this.data.allowedKeys ? new Set(this.data.allowedKeys) : null;
  private readonly initialStarredKeys = this.resolveInitialStarredKeys();

  readonly items = signal<ActionSelectionItem[]>(this.buildInitialList());

  readonly starredItems = computed(() => this.items().filter(i => i.isStarred));
  readonly starredCount = computed(() => this.starredItems().length);
  readonly canStarMore = computed(() => this.starredCount() < this.maxStarred);
  readonly hasChanges = computed(() => {
    const currentKeys = this.starredItems().map(i => i.key);
    if (currentKeys.length !== this.initialStarredKeys.length) return true;
    return currentKeys.some((key, i) => key !== this.initialStarredKeys[i]);
  });

  private resolveInitialStarredKeys(): PrimaryActionType[] {
    const provided = this.data.primaryActions?.length
      ? this.data.primaryActions
      : this.defaultPrimaryActions();
    const allowed = this.allowedKeys;
    return allowed ? provided.filter(key => allowed.has(key)) : provided;
  }

  private defaultPrimaryActions(): PrimaryActionType[] {
    return this.allowedKeys
      ? (MODE_DEFAULTS.operations as PrimaryActionType[])
      : (MODE_DEFAULTS.general as PrimaryActionType[]);
  }

  private buildInitialList(): ActionSelectionItem[] {
    const starred = new Set(this.initialStarredKeys);
    const allowed = this.allowedKeys;
    const starredItems: ActionSelectionItem[] = [];
    const unstarredItems: ActionSelectionItem[] = [];

    // Preserve the saved order for starred items
    for (const key of this.initialStarredKeys) {
      const config = ACTION_CONFIGS.find(c => c.key === key);
      if (config) starredItems.push(this.toItem(config, true));
    }

    // Add remaining unstarred items in default order
    for (const config of ACTION_CONFIGS) {
      if (allowed && !allowed.has(config.key)) continue;
      if (!starred.has(config.key)) unstarredItems.push(this.toItem(config, false));
    }

    return [...starredItems, ...unstarredItems];
  }

  private toItem(config: ActionConfig, isStarred: boolean): ActionSelectionItem {
    return {
      key: config.key,
      label: config.label,
      icon: config.icon,
      isStarred,
    };
  }

  getStarredIndex(item: ActionSelectionItem): number {
    return this.starredItems().indexOf(item) + 1;
  }

  onDrop(event: CdkDragDrop<ActionSelectionItem[]>): void {
    this.items.update(items => {
      const updated = [...items];
      moveItemInArray(updated, event.previousIndex, event.currentIndex);
      return updated;
    });
  }

  toggleStar(key: PrimaryActionType): void {
    this.items.update(items =>
      items.map(item => (item.key === key ? { ...item, isStarred: !item.isStarred } : item))
    );
  }

  onSave(): void {
    this.dialogRef.close(this.starredItems().map(i => i.key));
  }

  onCancel(): void {
    this.dialogRef.close();
  }
}
