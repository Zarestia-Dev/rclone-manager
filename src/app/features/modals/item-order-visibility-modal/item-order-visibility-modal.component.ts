import { ChangeDetectionStrategy, Component, inject, signal, computed } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';
import { TranslatePipe } from '@ngx-translate/core';
import { ACTION_CONFIGS, PrimaryActionType } from '@app/types';

export interface ItemOrderVisibilityConfigItem<T = any> {
  id: string;
  label: string;
  subLabel?: string;
  icon?: string;
  isVisible: boolean;
  value?: T;
}

export interface ItemOrderVisibilityModalData<T = any> {
  title: string;
  description?: string;
  descriptionParams?: Record<string, any>;
  items: ItemOrderVisibilityConfigItem<T>[];
  defaultItems?: ItemOrderVisibilityConfigItem<T>[];
  mode?: 'star' | 'visibility';
  maxVisible?: number;
  iconHeader?: string;
}

export interface ItemOrderVisibilityResult<T = any> {
  items: ItemOrderVisibilityConfigItem<T>[];
  orderedVisibleIds: string[];
  hiddenIds: string[];
  isReset?: boolean;
}

export function buildActionOrderItems(
  currentActions: PrimaryActionType[],
  allowedActions?: readonly PrimaryActionType[]
): ItemOrderVisibilityConfigItem<PrimaryActionType>[] {
  const allowedSet = allowedActions ? new Set(allowedActions) : null;
  const isAllowed = (key: PrimaryActionType): boolean => !allowedSet || allowedSet.has(key);

  const starredSet = new Set<PrimaryActionType>(currentActions.filter(isAllowed));
  const items: ItemOrderVisibilityConfigItem<PrimaryActionType>[] = [];

  for (const key of currentActions) {
    if (!isAllowed(key)) continue;
    const config = ACTION_CONFIGS.find(c => c.key === key);
    if (config) {
      items.push({
        id: config.key,
        label: config.label,
        icon: config.icon,
        isVisible: true,
        value: config.key,
      });
    }
  }

  for (const config of ACTION_CONFIGS) {
    if (isAllowed(config.key) && !starredSet.has(config.key)) {
      items.push({
        id: config.key,
        label: config.label,
        icon: config.icon,
        isVisible: false,
        value: config.key,
      });
    }
  }

  return items;
}

@Component({
  selector: 'app-item-order-visibility-modal',
  imports: [MatButtonModule, MatIconModule, MatTooltipModule, DragDropModule, TranslatePipe],
  templateUrl: './item-order-visibility-modal.component.html',
  styleUrls: ['./item-order-visibility-modal.component.scss', '../../../styles/_shared-modal.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(keydown.escape)': 'onCancel()',
  },
})
export class ItemOrderVisibilityModalComponent {
  private readonly dialogRef = inject(MatDialogRef<ItemOrderVisibilityModalComponent>);
  private readonly data = inject<ItemOrderVisibilityModalData>(MAT_DIALOG_DATA);

  readonly title = this.data.title;
  readonly description = this.data.description ?? '';
  readonly descriptionParams = this.data.descriptionParams ?? {};
  readonly mode = this.data.mode ?? 'visibility';
  readonly maxVisible = this.data.maxVisible;
  readonly iconHeader = this.data.iconHeader ?? (this.mode === 'star' ? 'operations' : 'tune');

  private readonly defaultItems: ItemOrderVisibilityConfigItem[] = (
    this.data.defaultItems ?? []
  ).map(item => ({ ...item }));

  private readonly initialItems: ItemOrderVisibilityConfigItem[] = (this.data.items ?? []).map(
    item => ({ ...item })
  );

  readonly items = signal<ItemOrderVisibilityConfigItem[]>(
    (this.data.items ?? []).map(item => ({ ...item }))
  );

  private readonly isResetState = signal<boolean>(false);

  readonly visibleItems = computed(() => this.items().filter(i => i.isVisible));
  readonly canShowMore = computed(() =>
    this.maxVisible !== undefined ? this.visibleItems().length < this.maxVisible : true
  );

  readonly visibleIndexMap = computed(() => {
    const map = new Map<string, number>();
    this.visibleItems().forEach((item, idx) => map.set(item.id, idx + 1));
    return map;
  });

  readonly canReset = computed(() => {
    const target = this.defaultItems.length ? this.defaultItems : this.initialItems;
    const curr = this.items();
    if (curr.length !== target.length) return true;
    return curr.some(
      (item, idx) => item.id !== target[idx].id || item.isVisible !== target[idx].isVisible
    );
  });

  readonly hasChanges = computed(() => {
    const curr = this.items();
    const init = this.initialItems;
    if (curr.length !== init.length) return true;
    return curr.some(
      (item, idx) => item.id !== init[idx].id || item.isVisible !== init[idx].isVisible
    );
  });

  onDrop(event: CdkDragDrop<ItemOrderVisibilityConfigItem[]>): void {
    this.isResetState.set(false);
    this.items.update(items => {
      const updated = [...items];
      moveItemInArray(updated, event.previousIndex, event.currentIndex);
      return updated;
    });
  }

  toggleVisibility(id: string): void {
    this.isResetState.set(false);
    this.items.update(items =>
      items.map(item => {
        if (item.id !== id) return item;
        if (!item.isVisible && !this.canShowMore()) return item;
        return { ...item, isVisible: !item.isVisible };
      })
    );
  }

  onReset(): void {
    const target = this.defaultItems.length ? this.defaultItems : this.initialItems;
    this.items.set(target.map(item => ({ ...item })));
    this.isResetState.set(true);
  }

  onSave(): void {
    const items = this.items();
    const result: ItemOrderVisibilityResult = {
      items,
      orderedVisibleIds: items.filter(i => i.isVisible).map(i => i.id),
      hiddenIds: items.filter(i => !i.isVisible).map(i => i.id),
      isReset: this.isResetState() && !this.canReset(),
    };
    this.dialogRef.close(result);
  }

  onCancel(): void {
    this.dialogRef.close();
  }
}
