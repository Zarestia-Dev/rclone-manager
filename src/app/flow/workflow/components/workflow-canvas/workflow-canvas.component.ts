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
import { NODE_WIDTH, PORT_ROW_START_Y, PORT_ROW_HEIGHT } from '../../constants/workflow.constants';
import { hasDetailedConfig } from '../../utils/node-style.util';

@Component({
  selector: 'app-workflow-canvas',
  imports: [CommonModule, WorkflowNodeComponent, WorkflowWireComponent, WorkflowMinimapComponent],
  templateUrl: './workflow-canvas.component.html',
  styleUrl: './workflow-canvas.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkflowCanvasComponent {
  readonly stateService = inject(WorkflowStateService);
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
    const activeEl = document.activeElement as HTMLElement | null;
    const isEditing =
      activeEl &&
      (activeEl.tagName === 'INPUT' ||
        activeEl.tagName === 'TEXTAREA' ||
        activeEl.tagName === 'SELECT' ||
        activeEl.isContentEditable);

    if (isEditing) return;

    if (event.key === 'Delete' || event.key === 'Backspace') {
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

  // ── HTML5 Drag & Drop from Palette ───────────────────────────────────────

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    const dataStr = event.dataTransfer?.getData('application/json');
    if (!dataStr) return;

    try {
      const paletteItem = JSON.parse(dataStr);
      const container = this.canvasContainer()?.nativeElement;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const vp = this.viewport();

      const canvasX = (event.clientX - rect.left - vp.x) / vp.zoom;
      const canvasY = (event.clientY - rect.top - vp.y) / vp.zoom;

      this.stateService.addNode(
        paletteItem.type,
        paletteItem.category,
        paletteItem.title,
        canvasX,
        canvasY,
        {
          icon: paletteItem.icon,
          inputs: paletteItem.defaultInputs,
          outputs: paletteItem.defaultOutputs,
          config: paletteItem.defaultConfig,
        }
      );
    } catch (err) {
      console.warn('[WorkflowCanvas] Failed to parse dropped palette item:', err);
    }
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
