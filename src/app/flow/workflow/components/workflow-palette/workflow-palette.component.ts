import {
  Component,
  ChangeDetectionStrategy,
  DestroyRef,
  inject,
  signal,
  computed,
  output,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { SearchContainerComponent } from '../../../../shared/components/search-container/search-container.component';
import { WorkflowStateService } from '../../../../services/flow/workflow-state.service';
import { WorkflowDragDropService } from '../../../../services/flow/workflow-drag-drop.service';
import { NodePaletteItem, WorkflowNodeCategory } from '../../types/workflow.types';
import { PALETTE_ITEMS } from '../../constants/palette.registry';

export { PALETTE_ITEMS };

@Component({
  selector: 'app-workflow-palette',
  imports: [CommonModule, MatIconModule, MatButtonModule, TranslatePipe, SearchContainerComponent],
  templateUrl: './workflow-palette.component.html',
  styleUrl: './workflow-palette.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host {
        overflow: hidden;
        display: flex;
        flex-direction: column;
        height: 100%;
      }
    `,
  ],
})
export class WorkflowPaletteComponent {
  private readonly stateService = inject(WorkflowStateService);
  private readonly dragDropService = inject(WorkflowDragDropService);
  private readonly translate = inject(TranslateService);
  private readonly destroyRef = inject(DestroyRef);

  readonly closePalette = output<void>();
  readonly nodeAdded = output<NodePaletteItem>();
  readonly searchQuery = signal<string>('');
  readonly selectedCategory = signal<WorkflowNodeCategory | 'all'>('all');
  readonly isSearchOpen = signal<boolean>(false);

  private _pendingPointerDrag: {
    item: NodePaletteItem;
    pointerId: number;
    startX: number;
    startY: number;
    started: boolean;
    svgIcon: SVGElement | null;
  } | null = null;
  private _ignoreNextItemClick = false;

  readonly categories: { id: WorkflowNodeCategory | 'all'; label: string; icon: string }[] = [
    { id: 'all', label: 'flow.workflow.categories.all', icon: 'grid' },
    { id: 'trigger', label: 'flow.workflow.category.trigger', icon: 'play' },
    { id: 'task', label: 'flow.workflow.category.task', icon: 'sync' },
    { id: 'logic', label: 'flow.workflow.category.logic', icon: 'flow' },
    { id: 'action', label: 'flow.workflow.category.action', icon: 'bell' },
  ];

  constructor() {
    this.destroyRef.onDestroy(() => {
      this._removePointerListeners();
      this.dragDropService.cancelDrag();
    });
  }

  readonly filteredItems = computed(() => {
    const query = this.searchQuery().trim().toLowerCase();
    const cat = this.selectedCategory();

    return PALETTE_ITEMS.filter(item => {
      const matchCat = cat === 'all' || item.category === cat;
      if (!matchCat) return false;
      if (!query) return true;

      const title = item.titleKey ? this.translate.instant(item.titleKey) : item.title;
      const desc = item.descriptionKey
        ? this.translate.instant(item.descriptionKey)
        : item.description;

      return (
        title.toLowerCase().includes(query) ||
        desc.toLowerCase().includes(query) ||
        item.title.toLowerCase().includes(query) ||
        item.description.toLowerCase().includes(query) ||
        item.type.toLowerCase().includes(query)
      );
    });
  });

  toggleSearch(): void {
    this.isSearchOpen.update(v => !v);
  }

  onItemPointerDown(item: NodePaletteItem, event: PointerEvent): void {
    if (event.button !== 0) return;

    this._removePointerListeners();
    const cardEl = event.currentTarget as HTMLElement | null;
    const svgIcon = cardEl?.querySelector('svg') ?? null;

    this._pendingPointerDrag = {
      item,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      started: false,
      svgIcon,
    };

    window.addEventListener('pointermove', this._onWindowPointerMove);
    window.addEventListener('pointerup', this._onWindowPointerUp);
    window.addEventListener('pointercancel', this._onWindowPointerCancel);
  }

  private readonly _onWindowPointerMove = (event: PointerEvent): void => {
    if (!this._pendingPointerDrag || event.pointerId !== this._pendingPointerDrag.pointerId) return;

    const dx = Math.abs(event.clientX - this._pendingPointerDrag.startX);
    const dy = Math.abs(event.clientY - this._pendingPointerDrag.startY);

    if (!this._pendingPointerDrag.started) {
      if (dx < 8 && dy < 8) return;

      this._pendingPointerDrag.started = true;
      this.dragDropService.beginDrag(
        this._pendingPointerDrag.item,
        { x: event.clientX, y: event.clientY },
        this._pendingPointerDrag.svgIcon
      );
      event.preventDefault();
      return;
    }

    this.dragDropService.updateDrag({ x: event.clientX, y: event.clientY });
    event.preventDefault();
  };

  private readonly _onWindowPointerUp = (event: PointerEvent): void => {
    if (!this._pendingPointerDrag || event.pointerId !== this._pendingPointerDrag.pointerId) return;

    const wasDragging = this._pendingPointerDrag.started;
    const item = this._pendingPointerDrag.item;
    this._pendingPointerDrag = null;
    this._removePointerListeners();

    if (wasDragging) {
      this._ignoreNextItemClick = true;
      setTimeout(() => {
        this._ignoreNextItemClick = false;
      }, 50);

      const result = this.dragDropService.commitDrag({ x: event.clientX, y: event.clientY });
      if (result) {
        this.nodeAdded.emit(item);
      }
    }
  };

  private readonly _onWindowPointerCancel = (): void => {
    this._pendingPointerDrag = null;
    this._removePointerListeners();
    this.dragDropService.cancelDrag();
  };

  private _removePointerListeners(): void {
    window.removeEventListener('pointermove', this._onWindowPointerMove);
    window.removeEventListener('pointerup', this._onWindowPointerUp);
    window.removeEventListener('pointercancel', this._onWindowPointerCancel);
  }

  addNodeToCanvas(item: NodePaletteItem): void {
    if (this._ignoreNextItemClick) return;

    const vp = this.stateService.viewport();
    // Center node relative to current canvas camera
    const canvasX = (400 - vp.x) / vp.zoom;
    const canvasY = (300 - vp.y) / vp.zoom;
    const title = item.titleKey ? this.translate.instant(item.titleKey) : item.title;

    this.stateService.addNode(item.type, item.category, title, canvasX, canvasY, {
      icon: item.icon,
      inputs: item.defaultInputs,
      outputs: item.defaultOutputs,
      config: item.defaultConfig,
    });
    this.nodeAdded.emit(item);
  }
}
