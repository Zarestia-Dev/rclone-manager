import { DestroyRef, inject, Injectable, signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { WorkflowStateService } from './workflow-state.service';
import { NodePaletteItem, WorkflowNode } from '../../flow/workflow/types/workflow.types';

export interface WorkflowDropResult {
  item: NodePaletteItem;
  canvasX: number;
  canvasY: number;
  node: WorkflowNode;
}

@Injectable({
  providedIn: 'root',
})
export class WorkflowDragDropService {
  private readonly stateService = inject(WorkflowStateService);
  private readonly translate = inject(TranslateService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly _isDragging = signal(false);
  readonly isDragging = this._isDragging.asReadonly();

  readonly draggedItem = signal<NodePaletteItem | null>(null);

  private _dragGhostEl: HTMLElement | null = null;
  private _moveRafId: number | null = null;
  private _lastMovePoint: { x: number; y: number } | null = null;

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.cancelDrag();
    });
  }

  beginDrag(
    item: NodePaletteItem,
    point: { x: number; y: number },
    svgIcon: SVGElement | null = null
  ): void {
    this.cancelDrag();

    this._isDragging.set(true);
    this.draggedItem.set(item);

    this._dragGhostEl = this._createDragGhost(item, svgIcon);
    document.documentElement.appendChild(this._dragGhostEl);

    if ('popover' in this._dragGhostEl) {
      try {
        const el = this._dragGhostEl as HTMLElement & {
          popover?: string;
          showPopover?: () => void;
        };
        el.popover = 'manual';
        el.showPopover?.();
      } catch {
        // Fallback gracefully if popover is unsupported
      }
    }

    this._updateDragGhostPosition(point.x + 12, point.y + 12);
  }

  updateDrag(point: { x: number; y: number }): void {
    if (!this._isDragging()) return;
    this._updateDragGhostPosition(point.x + 12, point.y + 12);
    this._scheduleMove(point);
  }

  private _scheduleMove(point: { x: number; y: number }): void {
    this._lastMovePoint = point;
    if (this._moveRafId !== null) return;
    this._moveRafId = requestAnimationFrame(() => {
      this._moveRafId = null;
      if (this._lastMovePoint) {
        this._updateDragGhostPosition(this._lastMovePoint.x + 12, this._lastMovePoint.y + 12);
      }
    });
  }

  commitDrag(point: { x: number; y: number }): WorkflowDropResult | null {
    if (!this._isDragging()) return null;

    const item = this.draggedItem();
    if (!item) {
      this.cancelDrag();
      return null;
    }

    const hitEl =
      typeof document.elementFromPoint === 'function'
        ? document.elementFromPoint(point.x, point.y)
        : null;
    let container = hitEl?.closest('.workflow-canvas-container') as HTMLElement | null;

    if (!container) {
      const allContainers = document.querySelectorAll('.workflow-canvas-container');
      for (const c of Array.from(allContainers)) {
        const r = (c as HTMLElement).getBoundingClientRect();
        if (point.x >= r.left && point.x <= r.right && point.y >= r.top && point.y <= r.bottom) {
          container = c as HTMLElement;
          break;
        }
      }
    }

    if (!container) {
      this.cancelDrag();
      return null;
    }

    const rect = container.getBoundingClientRect();
    const vp = this.stateService.viewport();
    const canvasX = (point.x - rect.left - vp.x) / vp.zoom;
    const canvasY = (point.y - rect.top - vp.y) / vp.zoom;
    const title = item.titleKey ? this.translate.instant(item.titleKey) : item.title;

    const node = this.stateService.addNode(item.type, item.category, title, canvasX, canvasY, {
      icon: item.icon,
      inputs: item.defaultInputs,
      outputs: item.defaultOutputs,
      config: item.defaultConfig,
    });

    this.cancelDrag();
    return { item, canvasX, canvasY, node };
  }

  cancelDrag(): void {
    if (this._moveRafId !== null) {
      cancelAnimationFrame(this._moveRafId);
      this._moveRafId = null;
    }
    this._lastMovePoint = null;
    this._isDragging.set(false);
    this.draggedItem.set(null);
    this._dragGhostEl?.remove();
    this._dragGhostEl = null;
  }

  private _createDragGhost(item: NodePaletteItem, svgIcon: SVGElement | null): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'workflow-drag-ghost';
    wrapper.style.cssText = `
      position: fixed; top: 0; left: 0; margin: 0; padding: 0; border: none;
      background: transparent; z-index: 2147483647; pointer-events: none;
      width: 220px; height: 48px; opacity: 0.95; visibility: visible;
    `;

    const card = document.createElement('div');
    card.style.cssText = `
      width: 100%; height: 100%; display: flex; align-items: center; gap: 10px;
      padding: 0 12px; border-radius: var(--card-border-radius, 10px);
      background: var(--popover-bg-color, #272a2f);
      border: 1.5px solid var(--accent-color, #0ea5e9);
      box-shadow: var(--shadow-popover, 0 10px 25px rgba(0, 0, 0, 0.45));
      box-sizing: border-box; overflow: hidden;
    `;

    const iconBox = document.createElement('div');
    iconBox.style.cssText = `
      width: 32px; height: 32px; border-radius: var(--radius-xs, 6px);
      display: flex; align-items: center; justify-content: center; flex-shrink: 0;
      background: rgba(var(--accent-color-rgb, 14, 165, 233), 0.15);
      color: var(--accent-color, #0ea5e9);
    `;

    if (svgIcon) {
      const clone = svgIcon.cloneNode(true) as SVGElement;
      clone.style.cssText = 'width: 18px; height: 18px; display: block; fill: currentColor;';
      iconBox.appendChild(clone);
    } else {
      iconBox.textContent = '⚡';
    }
    card.appendChild(iconBox);

    const textCol = document.createElement('div');
    textCol.style.cssText = `flex: 1; min-width: 0; overflow: hidden; display: flex; flex-direction: column; justify-content: center;`;

    const titleEl = document.createElement('span');
    titleEl.style.cssText = `
      font-size: 13px; font-weight: 600; color: var(--window-fg-color, #f3f4f6);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    `;
    titleEl.textContent = item.titleKey ? this.translate.instant(item.titleKey) : item.title;
    textCol.appendChild(titleEl);

    const catEl = document.createElement('span');
    catEl.style.cssText = `
      font-size: 10px; font-weight: 500; color: var(--dim-color, #9ca3af);
      text-transform: uppercase; letter-spacing: 0.5px; margin-top: 1px;
    `;
    catEl.textContent = item.category;
    textCol.appendChild(catEl);

    card.appendChild(textCol);
    wrapper.appendChild(card);
    return wrapper;
  }

  private _updateDragGhostPosition(x: number, y: number): void {
    if (!this._dragGhostEl) return;
    this._dragGhostEl.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }
}
