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
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { WorkflowStateService } from '../../../../services/flow/workflow-state.service';
import { WorkflowEngineService } from '../../../../services/flow/workflow-engine.service';
import { WorkflowNodeComponent } from './workflow-node/workflow-node.component';
import { WorkflowWireComponent } from './workflow-wire/workflow-wire.component';
import { WorkflowMinimapComponent } from './workflow-minimap/workflow-minimap.component';
import { generateCubicBezierPath } from '../../utils/bezier.util';
import { WorkflowNode } from '../../types/workflow.types';
import { ModalService } from '../../../../services/ui/modal.service';
import { WorkflowDragDropService } from '../../../../services/flow/workflow-drag-drop.service';
import { NODE_WIDTH, PORT_ROW_START_Y, PORT_ROW_HEIGHT } from '../../constants/workflow.constants';
import { hasDetailedConfig } from '../../utils/node-style.util';
import { isInputFocused, matchesShortcut } from '../../../../shared/utils/keyboard-utils';

@Component({
  selector: 'app-workflow-canvas',
  imports: [CommonModule, WorkflowNodeComponent, WorkflowWireComponent, WorkflowMinimapComponent],
  templateUrl: './workflow-canvas.component.html',
  styleUrl: './workflow-canvas.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkflowCanvasComponent {
  readonly stateService = inject(WorkflowStateService);
  readonly dragDropService = inject(WorkflowDragDropService);
  readonly engineService = inject(WorkflowEngineService);
  private readonly modalService = inject(ModalService);

  readonly canvasContainer = viewChild<ElementRef<HTMLElement>>('canvasContainer');

  readonly containerWidth = signal<number>(1000);
  readonly containerHeight = signal<number>(700);

  readonly isPanning = signal<boolean>(false);
  private panStart = { x: 0, y: 0 };
  private initialViewport = { x: 0, y: 0 };

  // Node Dragging State
  readonly draggingNodeId = signal<string | null>(null);
  private dragOffset = { x: 0, y: 0 };

  // Wire Connection State
  readonly isConnecting = this.stateService.isConnecting;

  readonly activeWorkflow = this.stateService.currentWorkflow;
  readonly viewport = this.stateService.viewport;

  readonly canvasTransform = computed(() => {
    const vp = this.viewport();
    return `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`;
  });

  constructor() {
    afterNextRender(() => {
      this.updateContainerDimensions();
    });
  }

  @HostListener('window:resize')
  onResize(): void {
    this.updateContainerDimensions();
  }

  private updateContainerDimensions(): void {
    const el = this.canvasContainer()?.nativeElement;
    if (el) {
      this.containerWidth.set(el.clientWidth || 1000);
      this.containerHeight.set(el.clientHeight || 700);
    }
  }

  readonly connectingPath = computed(() => {
    const conn = this.isConnecting();
    if (!conn) return '';

    const { x: sourceX, y: sourceY } = this.getPortCoordinate(
      conn.sourceNodeId,
      conn.sourcePortId,
      true
    );

    const vp = this.viewport();
    const targetX = (conn.currentX - vp.x) / vp.zoom;
    const targetY = (conn.currentY - vp.y) / vp.zoom;

    return generateCubicBezierPath(sourceX, sourceY, targetX, targetY);
  });

  // Calculate socket coordinates for rendering edges
  getPortCoordinate(nodeId: string, portId: string, isOutput: boolean): { x: number; y: number } {
    const wf = this.activeWorkflow();
    const node = wf?.nodes.find(n => n.id === nodeId);
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
      const container = this.canvasContainer()?.nativeElement;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const vp = this.viewport();

      const canvasX = (event.clientX - rect.left - vp.x) / vp.zoom;
      const canvasY = (event.clientY - rect.top - vp.y) / vp.zoom;

      this.stateService.updateNodePosition(
        dragId,
        canvasX - this.dragOffset.x,
        canvasY - this.dragOffset.y
      );
      return;
    }

    if (this.isConnecting()) {
      const container = this.canvasContainer()?.nativeElement;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      this.stateService.updateConnecting(event.clientX - rect.left, event.clientY - rect.top);
    }
  }

  @HostListener('window:mouseup')
  onWindowMouseUp(): void {
    if (this.isPanning()) {
      this.isPanning.set(false);
    }
    if (this.draggingNodeId()) {
      this.draggingNodeId.set(null);
    }
    if (this.isConnecting()) {
      this.stateService.cancelConnecting();
    }
  }

  @HostListener('window:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent): void {
    if (isInputFocused(event)) return;

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

  onNodeMouseDown(node: WorkflowNode, event: MouseEvent): void {
    if (event.button !== 0) return;
    event.stopPropagation();

    this.draggingNodeId.set(node.id);
    this.stateService.selectNode(node.id, event.shiftKey || event.ctrlKey);

    const container = this.canvasContainer()?.nativeElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const vp = this.viewport();

    const canvasX = (event.clientX - rect.left - vp.x) / vp.zoom;
    const canvasY = (event.clientY - rect.top - vp.y) / vp.zoom;

    this.dragOffset = {
      x: canvasX - node.x,
      y: canvasY - node.y,
    };
  }

  onNodeTouchStart(node: WorkflowNode, event: TouchEvent): void {
    if (event.touches.length !== 1) return;
    event.stopPropagation();

    this.draggingNodeId.set(node.id);
    this.stateService.selectNode(node.id, false);

    const container = this.canvasContainer()?.nativeElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const vp = this.viewport();

    const touch = event.touches[0];
    const canvasX = (touch.clientX - rect.left - vp.x) / vp.zoom;
    const canvasY = (touch.clientY - rect.top - vp.y) / vp.zoom;

    this.dragOffset = {
      x: canvasX - node.x,
      y: canvasY - node.y,
    };
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
      const isNode = target?.closest('.workflow-node-positioned');
      if (!isNode) {
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
      const container = this.canvasContainer()?.nativeElement;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const vp = this.viewport();

      const canvasX = (touches[0].clientX - rect.left - vp.x) / vp.zoom;
      const canvasY = (touches[0].clientY - rect.top - vp.y) / vp.zoom;

      this.stateService.updateNodePosition(
        dragId,
        canvasX - this.dragOffset.x,
        canvasY - this.dragOffset.y
      );
      return;
    }
  }

  onCanvasTouchEnd(event: TouchEvent): void {
    if (event.touches.length === 0) {
      this.isPanning.set(false);
      this.isPinching = false;
      this.draggingNodeId.set(null);
    } else if (event.touches.length === 1 && this.isPinching) {
      this.isPinching = false;
      this.isPanning.set(true);
      this.panStart = { x: event.touches[0].clientX, y: event.touches[0].clientY };
      this.initialViewport = { ...this.viewport() };
    }
  }

  onStartConnecting(sourceNodeId: string, portId: string, event: MouseEvent): void {
    const container = this.canvasContainer()?.nativeElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    this.stateService.startConnecting(
      sourceNodeId,
      portId,
      event.clientX - rect.left,
      event.clientY - rect.top
    );
  }

  onPortMouseUp(targetNodeId: string, portId: string): void {
    this.stateService.finishConnecting(targetNodeId, portId);
  }

  onMinimapPanTo(pos: { x: number; y: number }): void {
    this.stateService.setPan(pos.x, pos.y);
  }

  onInspectNode(nodeId: string): void {
    const node = this.activeWorkflow()?.nodes.find(n => n.id === nodeId);
    if (!node) return;

    if (hasDetailedConfig(node.type)) {
      this.modalService.openWorkflowNodeEditor(node);
    } else {
      this.stateService.selectNode(nodeId);
    }
  }
}
