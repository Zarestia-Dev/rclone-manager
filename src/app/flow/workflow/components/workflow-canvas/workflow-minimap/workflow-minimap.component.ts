import {
  Component,
  ChangeDetectionStrategy,
  input,
  output,
  computed,
  signal,
  viewChild,
  ElementRef,
  HostListener,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { CanvasViewport, WorkflowEdge, WorkflowNode } from '../../../types/workflow.types';
import { getNodeStyleMeta } from '../../../utils/node-style.util';
import { NODE_WIDTH, DEFAULT_NODE_HEIGHT } from '../../../constants/workflow.constants';

@Component({
  selector: 'app-workflow-minimap',
  imports: [CommonModule],
  templateUrl: './workflow-minimap.component.html',
  styleUrl: './workflow-minimap.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkflowMinimapComponent {
  readonly minimapCard = viewChild<ElementRef<HTMLElement>>('minimapCard');

  readonly nodes = input<WorkflowNode[]>([]);
  readonly edges = input<WorkflowEdge[]>([]);
  readonly selectedNodeIds = input<Set<string>>(new Set());
  readonly viewport = input<CanvasViewport>({ x: 0, y: 0, zoom: 1 });
  readonly containerWidth = input<number>(800);
  readonly containerHeight = input<number>(600);

  readonly panTo = output<{ x: number; y: number }>();

  readonly isDragging = signal<boolean>(false);

  readonly mapWidth = 160;
  readonly mapHeight = 110;

  readonly bounds = computed(() => {
    const nodes = this.nodes();
    if (nodes.length === 0) {
      return { minX: -200, minY: -200, width: 1400, height: 1000 };
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const n of nodes) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + NODE_WIDTH);
      maxY = Math.max(maxY, n.y + DEFAULT_NODE_HEIGHT);
    }

    const padding = 200;
    minX -= padding;
    minY -= padding;
    maxX += padding;
    maxY += padding;

    return {
      minX,
      minY,
      width: Math.max(800, maxX - minX),
      height: Math.max(600, maxY - minY),
    };
  });

  readonly scale = computed(() => {
    const b = this.bounds();
    return Math.min(this.mapWidth / b.width, this.mapHeight / b.height);
  });

  readonly scaledNodes = computed(() => {
    const b = this.bounds();
    const s = this.scale();
    return this.nodes().map(n => {
      const meta = getNodeStyleMeta(n.type);
      return {
        id: n.id,
        title: n.title,
        category: n.category,
        colorClass: meta.cssClass,
        state: n.state || 'idle',
        x: (n.x - b.minX) * s,
        y: (n.y - b.minY) * s,
        width: Math.max(8, NODE_WIDTH * s),
        height: Math.max(4, 90 * s),
      };
    });
  });

  readonly scaledEdges = computed(() => {
    const b = this.bounds();
    const s = this.scale();
    const nodeMap = new Map(this.nodes().map(n => [n.id, n]));

    return this.edges()
      .map(edge => {
        const src = nodeMap.get(edge.sourceNodeId);
        const tgt = nodeMap.get(edge.targetNodeId);
        if (!src || !tgt) return null;

        const midY = DEFAULT_NODE_HEIGHT / 2;
        return {
          id: edge.id,
          x1: (src.x + NODE_WIDTH - b.minX) * s,
          y1: (src.y + midY - b.minY) * s,
          x2: (tgt.x - b.minX) * s,
          y2: (tgt.y + midY - b.minY) * s,
        };
      })
      .filter((e): e is { id: string; x1: number; y1: number; x2: number; y2: number } => !!e);
  });

  readonly viewportRect = computed(() => {
    const vp = this.viewport();
    const b = this.bounds();
    const s = this.scale();

    const visibleLeft = -vp.x / vp.zoom;
    const visibleTop = -vp.y / vp.zoom;
    const visibleWidth = this.containerWidth() / vp.zoom;
    const visibleHeight = this.containerHeight() / vp.zoom;

    return {
      x: (visibleLeft - b.minX) * s,
      y: (visibleTop - b.minY) * s,
      width: Math.max(10, visibleWidth * s),
      height: Math.max(8, visibleHeight * s),
    };
  });

  onMinimapMouseDown(event: MouseEvent): void {
    if (event.button !== 0) return;
    event.stopPropagation();
    this.isDragging.set(true);
    this.handleMinimapNavigation(event);
  }

  @HostListener('window:mousemove', ['$event'])
  onWindowMouseMove(event: MouseEvent): void {
    if (this.isDragging()) {
      this.handleMinimapNavigation(event);
    }
  }

  @HostListener('window:mouseup')
  onWindowMouseUp(): void {
    if (this.isDragging()) {
      this.isDragging.set(false);
    }
  }

  onMinimapClick(event?: Event): void {
    if (event && 'clientX' in event) {
      this.handleMinimapNavigation(event as MouseEvent);
    }
  }

  private handleMinimapNavigation(event: MouseEvent): void {
    const rect = this.minimapCard()?.nativeElement.getBoundingClientRect();
    if (!rect) return;

    const clickX = Math.max(0, Math.min(this.mapWidth, event.clientX - rect.left));
    const clickY = Math.max(0, Math.min(this.mapHeight, event.clientY - rect.top));

    const b = this.bounds();
    const s = this.scale();

    const worldX = clickX / s + b.minX;
    const worldY = clickY / s + b.minY;

    const vp = this.viewport();
    const newPanX = -(worldX * vp.zoom - this.containerWidth() / 2);
    const newPanY = -(worldY * vp.zoom - this.containerHeight() / 2);

    this.panTo.emit({ x: newPanX, y: newPanY });
  }
}
