import {
  Component,
  ChangeDetectionStrategy,
  inject,
  ElementRef,
  viewChild,
  signal,
  computed,
  HostListener,
  afterNextRender,
  OnDestroy,
  DestroyRef,
  output,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { WorkflowStateService } from '../../../../services/flow/workflow-state.service';
import { WorkflowEngineService } from '../../../../services/flow/workflow-engine.service';
import { WorkflowNodeComponent } from './workflow-node/workflow-node.component';
import { WorkflowWireComponent } from './workflow-wire/workflow-wire.component';
import { WorkflowMinimapComponent } from './workflow-minimap/workflow-minimap.component';
import { generateCubicBezierPath } from '../../utils/bezier.util';
import { WorkflowNode, WorkflowEdge } from '../../types/workflow.types';
import { ModalService } from '../../../../services/ui/modal.service';
import { WorkflowDragDropService } from '../../../../services/flow/workflow-drag-drop.service';
import { WorkflowNodeLayoutService } from '../../../../services/flow/workflow-node-layout.service';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import {
  DEFAULT_CANVAS_WIDTH,
  DEFAULT_CANVAS_HEIGHT,
  MIN_ZOOM,
  MAX_ZOOM,
} from '../../constants/workflow.constants';
import { hasDetailedConfig } from '../../utils/node-style.util';
import {
  isInputFocused,
  isKeyboardEventInScope,
  matchesShortcut,
} from '../../../../shared/utils/keyboard-utils';

/** Zoom per unit of wheel travel; a notch of about 100 zooms by roughly an eighth. */
const WHEEL_ZOOM_SPEED = 0.0012;
/** The most one wheel event zooms by, so a fast flick does not leap. */
const WHEEL_ZOOM_MAX_STEP = 100;
/** Firefox reports the wheel in lines, about three to a notch. */
const WHEEL_LINE_PX = 33;

export interface RenderedWire {
  edge: WorkflowEdge;
  sourcePos: { x: number; y: number };
  targetPos: { x: number; y: number };
}

@Component({
  selector: 'app-workflow-canvas',
  imports: [
    CommonModule,
    MatIconModule,
    TranslatePipe,
    WorkflowNodeComponent,
    WorkflowWireComponent,
    WorkflowMinimapComponent,
  ],
  templateUrl: './workflow-canvas.component.html',
  styleUrl: './workflow-canvas.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkflowCanvasComponent implements OnDestroy {
  readonly stateService = inject(WorkflowStateService);
  readonly dragDropService = inject(WorkflowDragDropService);
  readonly engineService = inject(WorkflowEngineService);
  private readonly layoutService = inject(WorkflowNodeLayoutService);
  private readonly modalService = inject(ModalService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly elementRef = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly minZoom = MIN_ZOOM;
  readonly maxZoom = MAX_ZOOM;
  readonly showMinimap = signal<boolean>(true);
  readonly zoomPercentage = computed(() => Math.round(this.viewport().zoom * 100));

  readonly canvasContainer = viewChild<ElementRef<HTMLElement>>('canvasContainer');
  readonly inspectNode = output<string>();

  readonly isPanning = signal<boolean>(false);
  private panStart = { x: 0, y: 0 };
  private initialViewport = { x: 0, y: 0 };

  /** The pointer that owns the pan, node drag or wire being made; others are ignored. */
  private activePointerId: number | null = null;
  /** Touches on the canvas, for the pinch. */
  private readonly touches = new Map<number, { x: number; y: number }>();

  // Node Dragging State (supports multi-node group movements with RAF throttling)
  readonly draggingNodeId = signal<string | null>(null);
  private initialNodePositions = new Map<string, { x: number; y: number }>();
  private dragStartCanvasPos = { x: 0, y: 0 };
  private hasDraggedNode = false;
  private dragRafId: number | null = null;
  private pendingDragCoords: { clientX: number; clientY: number } | null = null;

  // Wire Connection State
  readonly isConnecting = this.stateService.isConnecting;
  private highlightedPortEl: HTMLElement | null = null;
  private connectStartScreen = { x: 0, y: 0 };

  // Pinch State
  private isPinching = false;
  private initialPinchDist = 0;
  private initialPinchZoom = 1;
  private pinchMidpoint = { x: 0, y: 0 };

  readonly activeWorkflow = this.stateService.currentWorkflow;
  readonly viewport = this.stateService.viewport;

  readonly canvasTransform = computed(() => {
    const vp = this.viewport();
    return `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`;
  });

  /** Map of node IDs to node objects for O(1) wire coordinate lookups */
  readonly nodeMap = computed(() => {
    const wf = this.activeWorkflow();
    const map = new Map<string, WorkflowNode>();
    if (wf) {
      for (const node of wf.nodes) {
        map.set(node.id, node);
      }
    }
    return map;
  });

  /** The wires drawn last time; a wire whose ends did not move keeps its object, and with it its path. */
  private wireCache = new Map<string, RenderedWire>();

  /** Precomputed wire coordinates to avoid O(E * N) template evaluations and object allocations */
  readonly renderedWires = computed<RenderedWire[]>(() => {
    const wf = this.activeWorkflow();
    if (!wf || !wf.edges.length) {
      this.wireCache = new Map();
      return [];
    }
    const map = this.nodeMap();
    const previous = this.wireCache;
    const next = new Map<string, RenderedWire>();

    const wires: RenderedWire[] = [];
    for (const edge of wf.edges) {
      const sourcePos = this.layoutService.portPosition(
        map.get(edge.sourceNodeId),
        edge.sourcePortId,
        true
      );
      const targetPos = this.layoutService.portPosition(
        map.get(edge.targetNodeId),
        edge.targetPortId,
        false
      );
      // A node is measured once it has been drawn; its wires follow in the same frame.
      if (!sourcePos || !targetPos) continue;
      const before = previous.get(edge.id);
      const wire =
        before &&
        before.edge === edge &&
        before.sourcePos.x === sourcePos.x &&
        before.sourcePos.y === sourcePos.y &&
        before.targetPos.x === targetPos.x &&
        before.targetPos.y === targetPos.y
          ? before
          : { edge, sourcePos, targetPos };
      next.set(edge.id, wire);
      wires.push(wire);
    }
    this.wireCache = next;
    return wires;
  });

  constructor() {
    afterNextRender(() => {
      this.updateContainerDimensions();
      // The panels beside the canvas open and close without the window changing size.
      const container = this.canvasContainer()?.nativeElement;
      if (container && typeof ResizeObserver !== 'undefined') {
        const observer = new ResizeObserver(() => this.updateContainerDimensions());
        observer.observe(container);
        this.destroyRef.onDestroy(() => observer.disconnect());
      }
    });
  }

  ngOnDestroy(): void {
    this.stateService.isMobileFocusMode.set(false);
    this.flushPendingDrag();
    this.clearPortCandidateHighlight();
  }

  private updateContainerDimensions(): void {
    const el = this.canvasContainer()?.nativeElement;
    if (el) {
      const width = el.clientWidth || DEFAULT_CANVAS_WIDTH;
      const height = el.clientHeight || DEFAULT_CANVAS_HEIGHT;
      this.stateService.canvasDimensions.set({ width, height });
    }
  }

  readonly connectingPath = computed(() => {
    const conn = this.isConnecting();
    if (!conn) return '';

    const port = this.layoutService.portPosition(
      this.nodeMap().get(conn.sourceNodeId),
      conn.sourcePortId,
      conn.isSourceOutput
    );
    if (!port) return '';
    const { x: portX, y: portY } = port;

    const vp = this.viewport();
    const mouseX = (conn.currentX - vp.x) / vp.zoom;
    const mouseY = (conn.currentY - vp.y) / vp.zoom;

    if (conn.isSourceOutput) {
      return generateCubicBezierPath(portX, portY, mouseX, mouseY);
    } else {
      return generateCubicBezierPath(mouseX, mouseY, portX, portY);
    }
  });

  // ── Pointer Input (mouse, pen and touch) ────────────────────────────────

  onPointerDown(event: PointerEvent): void {
    const target = event.target as HTMLElement | null;
    const isTouch = event.pointerType === 'touch';

    if (isTouch) {
      this.touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this.touches.size === 2) {
        this.startPinch();
        return;
      }
    }
    if (this.activePointerId !== null && this.activePointerId !== event.pointerId) return;

    // A wire waiting for its second end (tap-to-connect) ends on a port, or is dropped.
    const portHandle = target?.closest<HTMLElement>('.port-handle') ?? null;
    if (this.isConnecting() && event.button === 0) {
      if (portHandle) this.finishConnectingAt(portHandle);
      else this.stateService.cancelConnecting();
      this.clearPortCandidateHighlight();
      if (portHandle) return;
    }

    if (portHandle && event.button === 0) {
      this.beginConnecting(portHandle, event);
      return;
    }

    const nodeEl = target?.closest<HTMLElement>('.workflow-node-positioned') ?? null;
    if (nodeEl && event.button === 0) {
      if (target?.closest('.action-button')) return;
      const node = this.nodeMap().get(nodeEl.dataset['nodeId'] ?? '');
      if (node) this.beginNodeDrag(node, event);
      return;
    }

    // Left button on the background, or the middle or right button anywhere, pans.
    if (event.button === 1 || event.button === 2 || target === event.currentTarget) {
      event.preventDefault();
      this.activePointerId = event.pointerId;
      this.isPanning.set(true);
      this.startPan(event.clientX, event.clientY);
      this.stateService.clearSelection();
    }
  }

  @HostListener('window:pointermove', ['$event'])
  onWindowPointerMove(event: PointerEvent): void {
    if (this.touches.has(event.pointerId)) {
      this.touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }
    if (this.isPinching) {
      this.updatePinch();
      return;
    }

    const ownsGesture = event.pointerId === this.activePointerId;
    if (ownsGesture && this.isPanning()) {
      this.stateService.setPan(
        this.initialViewport.x + event.clientX - this.panStart.x,
        this.initialViewport.y + event.clientY - this.panStart.y
      );
    } else if (ownsGesture && this.draggingNodeId()) {
      this.scheduleDragDelta(event.clientX, event.clientY);
    } else if (this.isConnecting() && (ownsGesture || event.pointerType !== 'touch')) {
      const rect = this.canvasContainer()?.nativeElement.getBoundingClientRect();
      if (!rect) return;
      this.stateService.updateConnecting(event.clientX - rect.left, event.clientY - rect.top);
      this.updatePortCandidateHighlight(event.clientX, event.clientY);
    }
  }

  @HostListener('window:pointerup', ['$event'])
  onWindowPointerUp(event: PointerEvent): void {
    this.touches.delete(event.pointerId);
    if (this.isPinching) {
      if (this.touches.size < 2) this.endPinch();
      return;
    }
    if (event.pointerId !== this.activePointerId) return;
    this.activePointerId = null;

    if (this.isPanning()) this.isPanning.set(false);
    this.endNodeDrag();
    if (this.isConnecting()) this.completeConnecting(event);
  }

  @HostListener('window:pointercancel', ['$event'])
  onWindowPointerCancel(event: PointerEvent): void {
    this.touches.delete(event.pointerId);
    if (this.isPinching) {
      if (this.touches.size < 2) this.endPinch();
      return;
    }
    if (event.pointerId !== this.activePointerId) return;
    this.activePointerId = null;

    if (this.isPanning()) this.isPanning.set(false);
    this.endNodeDrag();
    this.abortConnecting();
  }

  @HostListener('window:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent): void {
    if (!isKeyboardEventInScope(event, this.elementRef.nativeElement)) return;
    if (isInputFocused(event)) return;

    if (event.key === 'Escape') {
      if (this.isConnecting()) {
        event.preventDefault();
        this.abortConnecting();
        this.activePointerId = null;
        return;
      }
      if (this.isPanning()) {
        event.preventDefault();
        this.isPanning.set(false);
        this.activePointerId = null;
        return;
      }
      const selectedNodes = this.stateService.selectedNodeIds();
      const selectedEdges = this.stateService.selectedEdgeIds();
      if (selectedNodes.size > 0 || selectedEdges.size > 0) {
        event.preventDefault();
        this.stateService.clearSelection();
        return;
      }
    }

    if (matchesShortcut('Delete / Backspace', event)) {
      const selectedNodes = this.stateService.selectedNodeIds();
      const selectedEdges = this.stateService.selectedEdgeIds();
      if (selectedNodes.size > 0 || selectedEdges.size > 0) {
        event.preventDefault();
        this.stateService.removeSelected();
      }
    }
  }

  private startPan(clientX: number, clientY: number): void {
    this.panStart = { x: clientX, y: clientY };
    this.initialViewport = { ...this.viewport() };
  }

  // ── Node Drag Delta & RAF Throttling ─────────────────────────────────────

  private applyDragDelta(clientX: number, clientY: number): void {
    const dragId = this.draggingNodeId();
    if (!dragId) return;

    const container = this.canvasContainer()?.nativeElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const vp = this.viewport();

    const canvasX = (clientX - rect.left - vp.x) / vp.zoom;
    const canvasY = (clientY - rect.top - vp.y) / vp.zoom;

    const deltaX = canvasX - this.dragStartCanvasPos.x;
    const deltaY = canvasY - this.dragStartCanvasPos.y;

    if (!this.hasDraggedNode && Math.hypot(deltaX, deltaY) > 6) {
      this.hasDraggedNode = true;
      this.stateService.snapshot();
      this.stateService.isDraggingNode.set(true);
    }

    if (this.hasDraggedNode) {
      const updates = new Map<string, { x: number; y: number }>();
      for (const [id, initialPos] of this.initialNodePositions) {
        updates.set(id, { x: initialPos.x + deltaX, y: initialPos.y + deltaY });
      }
      this.stateService.updateNodesPositions(updates);
    }
  }

  private scheduleDragDelta(clientX: number, clientY: number): void {
    if (!this.hasDraggedNode) {
      // First movement crossing threshold: execute synchronously for zero initial latency
      this.applyDragDelta(clientX, clientY);
      return;
    }

    this.pendingDragCoords = { clientX, clientY };
    if (this.dragRafId !== null) return;

    this.dragRafId = requestAnimationFrame(() => {
      this.dragRafId = null;
      if (this.pendingDragCoords) {
        this.applyDragDelta(this.pendingDragCoords.clientX, this.pendingDragCoords.clientY);
        this.pendingDragCoords = null;
      }
    });
  }

  private flushPendingDrag(): void {
    if (this.dragRafId !== null) {
      cancelAnimationFrame(this.dragRafId);
      this.dragRafId = null;
    }
    if (this.pendingDragCoords) {
      this.applyDragDelta(this.pendingDragCoords.clientX, this.pendingDragCoords.clientY);
      this.pendingDragCoords = null;
    }
  }

  // ── Canvas Zoom (Mouse Wheel) ────────────────────────────────────────────

  onCanvasWheel(event: WheelEvent): void {
    event.preventDefault();
    const container = this.canvasContainer()?.nativeElement;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;

    // The zoom follows how far the wheel turned; a trackpad sends many small steps.
    const lines = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? WHEEL_LINE_PX : 1;
    const delta = Math.max(
      -WHEEL_ZOOM_MAX_STEP,
      Math.min(WHEEL_ZOOM_MAX_STEP, event.deltaY * lines)
    );
    this.stateService.setZoom(
      this.viewport().zoom * Math.exp(-delta * WHEEL_ZOOM_SPEED),
      mouseX,
      mouseY
    );
  }

  // ── Wires ────────────────────────────────────────────────────────────────

  /** Whether a press ended where the wire started: the port itself, to be followed by a click on another. */
  private isNearConnectStart(clientX: number, clientY: number): boolean {
    const dx = Math.abs(clientX - this.connectStartScreen.x);
    const dy = Math.abs(clientY - this.connectStartScreen.y);
    return dx < 12 && dy < 12;
  }

  private findPortHandleAt(clientX: number, clientY: number): HTMLElement | null {
    if (typeof document.elementFromPoint !== 'function') return null;
    const hitEl = document.elementFromPoint(clientX, clientY);
    if (!hitEl) return null;
    return (
      (hitEl.closest('.port-handle') as HTMLElement | null) ||
      (hitEl.closest('.port-slot')?.querySelector('.port-handle') as HTMLElement | null) ||
      (hitEl.closest('.port-row')?.querySelector('.port-handle') as HTMLElement | null)
    );
  }

  private updatePortCandidateHighlight(clientX: number, clientY: number): void {
    const portHandle = this.findPortHandleAt(clientX, clientY);
    if (portHandle !== this.highlightedPortEl) {
      this.clearPortCandidateHighlight();
      if (portHandle) {
        portHandle.classList.add('connect-candidate');
        this.highlightedPortEl = portHandle;
      }
    }
  }

  private clearPortCandidateHighlight(): void {
    if (this.highlightedPortEl) {
      this.highlightedPortEl.classList.remove('connect-candidate');
      this.highlightedPortEl = null;
    }
  }

  private beginConnecting(portHandle: HTMLElement, event: PointerEvent): void {
    const container = this.canvasContainer()?.nativeElement;
    const nodeId = portHandle.dataset['nodeId'];
    const portId = portHandle.dataset['portId'];
    if (!container || !nodeId || !portId) return;
    const rect = container.getBoundingClientRect();
    this.activePointerId = event.pointerId;
    this.connectStartScreen = { x: event.clientX, y: event.clientY };
    this.stateService.startConnecting(
      nodeId,
      portId,
      event.clientX - rect.left,
      event.clientY - rect.top,
      portHandle.dataset['isOutput'] === 'true'
    );
  }

  private finishConnectingAt(portHandle: HTMLElement): boolean {
    const nodeId = portHandle.dataset['nodeId'];
    const portId = portHandle.dataset['portId'];
    if (!nodeId || !portId) return false;
    return this.stateService.finishConnecting(
      nodeId,
      portId,
      portHandle.dataset['isOutput'] === 'true'
    );
  }

  /** The pointer that drew a wire is up: connect it to the port below, or drop it. */
  private completeConnecting(event: PointerEvent): void {
    const candidate = this.highlightedPortEl;
    this.clearPortCandidateHighlight();

    // A click or tap on the start port is not a drag: the wire waits for a click on the other
    // end, and is dropped by a click anywhere else or Escape.
    if (this.isNearConnectStart(event.clientX, event.clientY)) return;
    const portHandle = this.findPortHandleAt(event.clientX, event.clientY) ?? candidate;
    if (portHandle && this.finishConnectingAt(portHandle)) return;
    this.stateService.cancelConnecting();
  }

  private abortConnecting(): void {
    if (!this.isConnecting()) return;
    this.clearPortCandidateHighlight();
    this.stateService.cancelConnecting();
  }

  // ── Node Interactions ────────────────────────────────────────────────────

  /**
   * Selects the node, unless it is part of the selection already, and prepares to move it
   * together with the rest of the selection. Nothing moves before the pointer travels
   * past the drag threshold.
   */
  private beginNodeDrag(node: WorkflowNode, event: PointerEvent): void {
    if (event.shiftKey || event.ctrlKey) {
      this.stateService.selectNode(node.id, true);
    } else if (!this.stateService.selectedNodeIds().has(node.id)) {
      this.stateService.selectNode(node.id, false);
    }

    this.activePointerId = event.pointerId;
    this.draggingNodeId.set(node.id);
    this.hasDraggedNode = false;

    const container = this.canvasContainer()?.nativeElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const vp = this.viewport();
    this.dragStartCanvasPos = {
      x: (event.clientX - rect.left - vp.x) / vp.zoom,
      y: (event.clientY - rect.top - vp.y) / vp.zoom,
    };

    this.initialNodePositions.clear();
    const currentSelected = this.stateService.selectedNodeIds();
    const nodeMap = this.nodeMap();
    if (currentSelected.has(node.id)) {
      for (const id of currentSelected) {
        const n = nodeMap.get(id);
        if (n) {
          this.initialNodePositions.set(id, { x: n.x, y: n.y });
        }
      }
    } else {
      this.initialNodePositions.set(node.id, { x: node.x, y: node.y });
    }
  }

  private endNodeDrag(): void {
    if (!this.draggingNodeId()) return;
    this.flushPendingDrag();
    this.stateService.isDraggingNode.set(false);
    this.draggingNodeId.set(null);
    this.hasDraggedNode = false;
    this.initialNodePositions.clear();
  }

  // ── Pinch-to-Zoom ────────────────────────────────────────────────────────

  /** A second finger came down: whatever the first one was doing stops, and the two zoom. */
  private startPinch(): void {
    this.isPanning.set(false);
    this.activePointerId = null;
    this.endNodeDrag();
    this.abortConnecting();

    const [first, second] = [...this.touches.values()];
    const rect = this.canvasContainer()?.nativeElement.getBoundingClientRect();
    this.isPinching = true;
    this.initialPinchDist = Math.hypot(first.x - second.x, first.y - second.y);
    this.initialPinchZoom = this.viewport().zoom;
    this.pinchMidpoint = {
      x: (first.x + second.x) / 2 - (rect?.left ?? 0),
      y: (first.y + second.y) / 2 - (rect?.top ?? 0),
    };
  }

  private updatePinch(): void {
    const [first, second] = [...this.touches.values()];
    if (!first || !second || this.initialPinchDist <= 0) return;
    const dist = Math.hypot(first.x - second.x, first.y - second.y);
    this.stateService.setZoom(
      this.initialPinchZoom * (dist / this.initialPinchDist),
      this.pinchMidpoint.x,
      this.pinchMidpoint.y
    );
  }

  /** One finger is left: it carries on as a pan. */
  private endPinch(): void {
    this.isPinching = false;
    const remaining = [...this.touches.entries()][0];
    if (!remaining) return;
    const [pointerId, point] = remaining;
    this.activePointerId = pointerId;
    this.isPanning.set(true);
    this.startPan(point.x, point.y);
  }

  onNodeSelected(nodeId: string): void {
    if (!this.stateService.selectedNodeIds().has(nodeId)) {
      this.stateService.selectNode(nodeId);
    }
  }

  onMinimapPanTo(pos: { x: number; y: number }): void {
    this.stateService.setPan(pos.x, pos.y);
  }

  onInspectNode(nodeId: string): void {
    const node = this.activeWorkflow()?.nodes.find(n => n.id === nodeId);
    if (!node) return;

    this.stateService.selectNode(nodeId);
    if (hasDetailedConfig(node.type)) {
      this.modalService.openWorkflowNodeEditor(node);
    } else {
      this.inspectNode.emit(nodeId);
    }
  }

  toggleMinimap(): void {
    this.showMinimap.update(v => !v);
  }

  toggleFocusMode(): void {
    this.stateService.isMobileFocusMode.update(v => !v);
  }

  zoomIn(): void {
    this.stateService.zoomIn();
  }

  zoomOut(): void {
    this.stateService.zoomOut();
  }

  resetZoom(): void {
    this.stateService.resetZoom();
  }

  fitToView(): void {
    this.stateService.fitToView();
  }
}
