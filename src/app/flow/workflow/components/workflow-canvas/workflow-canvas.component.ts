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
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import {
  NODE_WIDTH,
  PORT_ROW_START_Y,
  PORT_ROW_HEIGHT,
  DEFAULT_CANVAS_WIDTH,
  DEFAULT_CANVAS_HEIGHT,
  MIN_ZOOM,
  MAX_ZOOM,
} from '../../constants/workflow.constants';
import { hasDetailedConfig } from '../../utils/node-style.util';
import { isInputFocused, matchesShortcut } from '../../../../shared/utils/keyboard-utils';

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
  private readonly modalService = inject(ModalService);
  private readonly destroyRef = inject(DestroyRef);

  readonly minZoom = MIN_ZOOM;
  readonly maxZoom = MAX_ZOOM;
  readonly showMinimap = signal<boolean>(true);
  readonly isMobile = signal<boolean>(false);
  readonly zoomPercentage = computed(() => Math.round(this.viewport().zoom * 100));

  readonly navigationActionIcon = computed(() => {
    if (this.isMobile()) {
      return this.stateService.isMobileFocusMode() ? 'caret-up' : 'caret-down';
    }
    return 'detailed';
  });

  readonly navigationActionTitle = computed(() => {
    if (this.isMobile()) {
      return this.stateService.isMobileFocusMode()
        ? 'flow.workflow.canvas.exitFocusMode'
        : 'flow.workflow.canvas.enterFocusMode';
    }
    return 'flow.workflow.canvas.toggleMinimap';
  });

  readonly isNavigationActionActive = computed(() => {
    if (this.isMobile()) {
      return this.stateService.isMobileFocusMode();
    }
    return this.showMinimap();
  });

  readonly canvasContainer = viewChild<ElementRef<HTMLElement>>('canvasContainer');
  readonly inspectNode = output<string>();

  readonly isPanning = signal<boolean>(false);
  private panStart = { x: 0, y: 0 };
  private initialViewport = { x: 0, y: 0 };

  // Node Dragging State (supports multi-node group movements with RAF throttling)
  readonly draggingNodeId = signal<string | null>(null);
  private initialNodePositions = new Map<string, { x: number; y: number }>();
  private dragStartCanvasPos = { x: 0, y: 0 };
  private hasDraggedNode = false;
  private dragRafId: number | null = null;
  private pendingDragCoords: { clientX: number; clientY: number } | null = null;
  private ignoreNextClick = false;

  // Wire Connection State
  readonly isConnecting = this.stateService.isConnecting;
  private highlightedPortEl: HTMLElement | null = null;
  private connectStartScreen = { x: 0, y: 0 };

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

  /** Precomputed wire coordinates to avoid O(E * N) template evaluations and object allocations */
  readonly renderedWires = computed<RenderedWire[]>(() => {
    const wf = this.activeWorkflow();
    if (!wf || !wf.edges.length) return [];
    const map = this.nodeMap();

    return wf.edges.map(edge => {
      const sourceNode = map.get(edge.sourceNodeId);
      const targetNode = map.get(edge.targetNodeId);

      return {
        edge,
        sourcePos: this.calculatePortCoordinate(sourceNode, edge.sourcePortId, true),
        targetPos: this.calculatePortCoordinate(targetNode, edge.targetPortId, false),
      };
    });
  });

  constructor() {
    afterNextRender(() => {
      this.updateContainerDimensions();
      if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
        const mql = window.matchMedia('(max-width: 599.98px)');
        this.isMobile.set(mql.matches);
        const handler = (e: MediaQueryListEvent): void => this.isMobile.set(e.matches);
        mql.addEventListener('change', handler);
        this.destroyRef.onDestroy(() => mql.removeEventListener('change', handler));
      }
    });
  }

  @HostListener('window:resize')
  onResize(): void {
    this.updateContainerDimensions();
  }

  ngOnDestroy(): void {
    this.flushPendingDrag();
    this.clearPortCandidateHighlight();
    this.stateService.isMobileFocusMode.set(false);
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

    const { x: portX, y: portY } = this.getPortCoordinate(
      conn.sourceNodeId,
      conn.sourcePortId,
      conn.isSourceOutput
    );

    const vp = this.viewport();
    const mouseX = (conn.currentX - vp.x) / vp.zoom;
    const mouseY = (conn.currentY - vp.y) / vp.zoom;

    if (conn.isSourceOutput) {
      return generateCubicBezierPath(portX, portY, mouseX, mouseY);
    } else {
      return generateCubicBezierPath(mouseX, mouseY, portX, portY);
    }
  });

  private calculatePortCoordinate(
    node: WorkflowNode | undefined,
    portId: string,
    isOutput: boolean
  ): { x: number; y: number } {
    if (!node) return { x: 0, y: 0 };

    const ports = isOutput ? node.outputs : node.inputs;
    const portIndex = Math.max(
      0,
      ports.findIndex(p => p.id === portId)
    );

    const x = isOutput ? node.x + NODE_WIDTH : node.x;
    const y = node.y + PORT_ROW_START_Y + portIndex * PORT_ROW_HEIGHT;

    return { x, y };
  }

  // Calculate socket coordinates for rendering edges
  getPortCoordinate(nodeId: string, portId: string, isOutput: boolean): { x: number; y: number } {
    return this.calculatePortCoordinate(this.nodeMap().get(nodeId), portId, isOutput);
  }

  // ── Canvas Pan (Mouse Drag) ──────────────────────────────────────────────

  onCanvasMouseDown(event: MouseEvent): void {
    // Only pan on left-click background, middle click, or right click
    if (
      event.button === 1 ||
      event.button === 2 ||
      (event.button === 0 && event.target === event.currentTarget)
    ) {
      event.preventDefault();
      this.isPanning.set(true);
      this.panStart = { x: event.clientX, y: event.clientY };
      this.initialViewport = { ...this.viewport() };
      this.stateService.clearSelection();
    }
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
      if (this.initialNodePositions.size > 1) {
        const updates = new Map<string, { x: number; y: number }>();
        for (const [id, initialPos] of this.initialNodePositions) {
          updates.set(id, {
            x: initialPos.x + deltaX,
            y: initialPos.y + deltaY,
          });
        }
        this.stateService.updateNodesPositions(updates);
      } else {
        const initialPos = this.initialNodePositions.get(dragId) ?? { x: 0, y: 0 };
        this.stateService.updateNodePosition(dragId, initialPos.x + deltaX, initialPos.y + deltaY);
      }
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

  @HostListener('window:mousemove', ['$event'])
  onWindowMouseMove(event: MouseEvent): void {
    if (this.isPanning()) {
      const dx = event.clientX - this.panStart.x;
      const dy = event.clientY - this.panStart.y;
      this.stateService.setPan(this.initialViewport.x + dx, this.initialViewport.y + dy);
      return;
    }

    const dragId = this.draggingNodeId();
    if (dragId) {
      this.scheduleDragDelta(event.clientX, event.clientY);
      return;
    }

    if (this.isConnecting()) {
      const container = this.canvasContainer()?.nativeElement;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      this.stateService.updateConnecting(event.clientX - rect.left, event.clientY - rect.top);
      this.updatePortCandidateHighlight(event.clientX, event.clientY);
    }
  }

  @HostListener('window:mouseup')
  onWindowMouseUp(): void {
    if (this.isPanning()) {
      this.isPanning.set(false);
    }
    if (this.draggingNodeId()) {
      this.flushPendingDrag();
      this.stateService.isDraggingNode.set(false);
      this.draggingNodeId.set(null);
      if (this.hasDraggedNode) {
        this.ignoreNextClick = true;
        setTimeout(() => {
          this.ignoreNextClick = false;
        }, 100);
      }
      this.hasDraggedNode = false;
      this.initialNodePositions.clear();
    }
    if (this.isConnecting()) {
      this.clearPortCandidateHighlight();
      this.stateService.cancelConnecting();
    }
  }

  @HostListener('window:touchcancel')
  onWindowTouchCancel(): void {
    if (this.isPanning()) {
      this.isPanning.set(false);
    }
    if (this.draggingNodeId()) {
      this.flushPendingDrag();
      this.stateService.isDraggingNode.set(false);
      this.draggingNodeId.set(null);
      this.hasDraggedNode = false;
      this.initialNodePositions.clear();
    }
    if (this.isConnecting()) {
      this.clearPortCandidateHighlight();
      this.stateService.cancelConnecting();
    }
  }

  @HostListener('window:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent): void {
    if (isInputFocused(event)) return;

    if (event.key === 'Escape') {
      if (this.isConnecting()) {
        event.preventDefault();
        this.stateService.cancelConnecting();
        return;
      }
      if (this.isPanning()) {
        event.preventDefault();
        this.isPanning.set(false);
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

  // ── Canvas Zoom (Mouse Wheel) ────────────────────────────────────────────

  onCanvasWheel(event: WheelEvent): void {
    event.preventDefault();
    const container = this.canvasContainer()?.nativeElement;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;

    const zoomFactor = event.deltaY < 0 ? 1.12 : 0.88;
    this.stateService.setZoom(this.viewport().zoom * zoomFactor, mouseX, mouseY);
  }

  // ── Node Interactions ────────────────────────────────────────────────────

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

  onNodeMouseDown(node: WorkflowNode, event: MouseEvent): void {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('.port-handle') || target?.closest('.action-button')) {
      return;
    }
    event.stopPropagation();

    const isMultiModifier = event.shiftKey || event.ctrlKey;
    const isAlreadySelected = this.stateService.selectedNodeIds().has(node.id);

    if (isMultiModifier) {
      this.stateService.selectNode(node.id, true);
    } else if (!isAlreadySelected) {
      this.stateService.selectNode(node.id, false);
    }

    this.draggingNodeId.set(node.id);
    this.hasDraggedNode = false;

    const container = this.canvasContainer()?.nativeElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const vp = this.viewport();

    const canvasX = (event.clientX - rect.left - vp.x) / vp.zoom;
    const canvasY = (event.clientY - rect.top - vp.y) / vp.zoom;
    this.dragStartCanvasPos = { x: canvasX, y: canvasY };

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

  onNodeTouchStart(node: WorkflowNode, event: TouchEvent): void {
    if (event.touches.length !== 1) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('.port-handle') || target?.closest('.action-button')) {
      return;
    }
    event.stopPropagation();

    this.draggingNodeId.set(node.id);
    this.hasDraggedNode = false;
    this.stateService.selectNode(node.id, false);

    const container = this.canvasContainer()?.nativeElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const vp = this.viewport();

    const touch = event.touches[0];
    const canvasX = (touch.clientX - rect.left - vp.x) / vp.zoom;
    const canvasY = (touch.clientY - rect.top - vp.y) / vp.zoom;
    this.dragStartCanvasPos = { x: canvasX, y: canvasY };

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

  // ── Touch Gestures (Canvas Pan & Pinch-to-Zoom) ───────────────────────────

  private isPinching = false;
  private initialPinchDist = 0;
  private initialPinchZoom = 1;
  private pinchMidpoint = { x: 0, y: 0 };

  onCanvasTouchStart(event: TouchEvent): void {
    const touches = event.touches;
    if (touches.length === 1) {
      const target = event.target as HTMLElement | null;
      const isInteractive =
        target?.closest('.workflow-node-positioned') ||
        target?.closest('.workflow-wire-group') ||
        target?.closest('.canvas-navigation-hub') ||
        target?.closest('.workflow-unsaved-banner') ||
        target?.closest('.palette-open-trigger') ||
        target?.closest('.inspector-open-trigger');

      if (!isInteractive) {
        if (this.stateService.isConnecting()) {
          this.clearPortCandidateHighlight();
          this.stateService.cancelConnecting();
        }
        this.isPanning.set(true);
        this.isPinching = false;
        this.panStart = { x: touches[0].clientX, y: touches[0].clientY };
        this.initialViewport = { ...this.viewport() };
        this.stateService.clearSelection();
      }
    } else if (touches.length === 2) {
      this.isPanning.set(false);
      this.isPinching = true;
      const container = this.canvasContainer()?.nativeElement;
      const rect = container?.getBoundingClientRect();
      const t1 = touches[0];
      const t2 = touches[1];
      this.initialPinchDist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
      this.initialPinchZoom = this.viewport().zoom;
      if (rect) {
        this.pinchMidpoint = {
          x: (t1.clientX + t2.clientX) / 2 - rect.left,
          y: (t1.clientY + t2.clientY) / 2 - rect.top,
        };
      }
    }
  }

  onCanvasTouchMove(event: TouchEvent): void {
    const touches = event.touches;

    if (this.isConnecting() && touches.length === 1) {
      event.preventDefault();
      const container = this.canvasContainer()?.nativeElement;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const touch = touches[0];
      this.stateService.updateConnecting(touch.clientX - rect.left, touch.clientY - rect.top);
      this.updatePortCandidateHighlight(touch.clientX, touch.clientY);
      return;
    }

    if (this.isPinching && touches.length === 2) {
      event.preventDefault();
      const t1 = touches[0];
      const t2 = touches[1];
      const dist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
      if (this.initialPinchDist > 0) {
        const scale = dist / this.initialPinchDist;
        this.stateService.setZoom(
          this.initialPinchZoom * scale,
          this.pinchMidpoint.x,
          this.pinchMidpoint.y
        );
      }
      return;
    }

    if (this.isPanning() && touches.length === 1) {
      event.preventDefault();
      const dx = touches[0].clientX - this.panStart.x;
      const dy = touches[0].clientY - this.panStart.y;
      this.stateService.setPan(this.initialViewport.x + dx, this.initialViewport.y + dy);
      return;
    }

    const dragId = this.draggingNodeId();
    if (dragId && touches.length === 1) {
      event.preventDefault();
      this.scheduleDragDelta(touches[0].clientX, touches[0].clientY);
      return;
    }
  }

  onCanvasTouchEnd(event: TouchEvent): void {
    if (this.isConnecting()) {
      const candidateEl = this.highlightedPortEl;
      this.clearPortCandidateHighlight();
      const touch = event.changedTouches?.[0];
      if (touch) {
        const portHandle = this.findPortHandleAt(touch.clientX, touch.clientY) || candidateEl;
        if (portHandle) {
          const targetNodeId = portHandle.getAttribute('data-node-id');
          const targetPortId = portHandle.getAttribute('data-port-id');
          const isOutput = portHandle.getAttribute('data-is-output') === 'true';
          if (targetNodeId && targetPortId) {
            const finished = this.stateService.finishConnecting(
              targetNodeId,
              targetPortId,
              isOutput
            );
            if (finished) return;
          }
        }
        if (this.isNearConnectStart(touch.clientX, touch.clientY)) {
          // Tap-to-connect gesture on start port: keep connection preview active
          return;
        }
      }
      this.stateService.cancelConnecting();
      return;
    }

    if (event.touches.length === 0) {
      this.isPanning.set(false);
      this.isPinching = false;
      if (this.draggingNodeId()) {
        this.flushPendingDrag();
        this.stateService.isDraggingNode.set(false);
        this.draggingNodeId.set(null);
        if (this.hasDraggedNode) {
          this.ignoreNextClick = true;
          setTimeout(() => {
            this.ignoreNextClick = false;
          }, 100);
        }
        this.hasDraggedNode = false;
        this.initialNodePositions.clear();
      }
    } else if (event.touches.length === 1 && this.isPinching) {
      this.isPinching = false;
      this.isPanning.set(true);
      this.panStart = { x: event.touches[0].clientX, y: event.touches[0].clientY };
      this.initialViewport = { ...this.viewport() };
    }
  }

  onStartConnecting(
    sourceNodeId: string,
    portId: string,
    isOutput: boolean,
    event: MouseEvent | PointerEvent
  ): void {
    const container = this.canvasContainer()?.nativeElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    this.connectStartScreen = { x: event.clientX, y: event.clientY };
    this.stateService.startConnecting(
      sourceNodeId,
      portId,
      event.clientX - rect.left,
      event.clientY - rect.top,
      isOutput
    );
  }

  onPortMouseUp(targetNodeId: string, portId: string, isOutput: boolean): void {
    this.clearPortCandidateHighlight();
    this.stateService.finishConnecting(targetNodeId, portId, isOutput);
  }

  onNodeSelected(nodeId: string): void {
    if (this.ignoreNextClick) return;
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

  toggleNavigationAction(): void {
    if (this.isMobile()) {
      this.stateService.isMobileFocusMode.update(v => !v);
    } else {
      this.toggleMinimap();
    }
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
