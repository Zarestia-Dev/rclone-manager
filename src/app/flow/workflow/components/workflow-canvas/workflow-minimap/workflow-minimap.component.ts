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
  inject,
} from '@angular/core';
import { CanvasViewport, WorkflowEdge, WorkflowNode } from '../../../types/workflow.types';
import { getNodeStyleMeta } from '../../../utils/node-style.util';
import { WorkflowNodeLayoutService } from '../../../../../services/flow/workflow-node-layout.service';

/** The part of the canvas the map shows, in canvas units. */
interface MapBounds {
  minX: number;
  minY: number;
  width: number;
  height: number;
}

@Component({
  selector: 'app-workflow-minimap',
  imports: [],
  templateUrl: './workflow-minimap.component.html',
  styleUrl: './workflow-minimap.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkflowMinimapComponent {
  private readonly layoutService = inject(WorkflowNodeLayoutService);
  readonly minimapCard = viewChild<ElementRef<HTMLElement>>('minimapCard');

  readonly nodes = input<WorkflowNode[]>([]);
  readonly edges = input<WorkflowEdge[]>([]);
  readonly selectedNodeIds = input<Set<string>>(new Set());
  readonly viewport = input<CanvasViewport>({ x: 0, y: 0, zoom: 1 });
  readonly containerWidth = input<number>(800);
  readonly containerHeight = input<number>(600);

  readonly panTo = output<{ x: number; y: number }>();

  readonly isDragging = signal<boolean>(false);
  private dragPointerId: number | null = null;

  readonly mapWidth = 160;
  readonly mapHeight = 110;

  /** The part of the canvas the view shows, in canvas units. */
  private readonly visibleArea = computed(() => {
    const vp = this.viewport();
    return {
      left: -vp.x / vp.zoom,
      top: -vp.y / vp.zoom,
      width: this.containerWidth() / vp.zoom,
      height: this.containerHeight() / vp.zoom,
    };
  });

  /**
   * The bounds while the view is being dragged from the map. The map follows the view, so
   * without this the point under the pointer would change as the view moves, and it would run away.
   */
  private readonly frozenBounds = signal<MapBounds | null>(null);

  readonly bounds = computed(() => this.frozenBounds() ?? this.computeBounds());

  private computeBounds(): MapBounds {
    const nodes = this.nodes();
    if (nodes.length === 0) {
      return { minX: -200, minY: -200, width: 1400, height: 1000 };
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const n of nodes) {
      const { width, height } = this.layoutService.sizeOf(n.id);
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + width);
      maxY = Math.max(maxY, n.y + height);
    }

    // The view is part of the map, so its box does not leave it when the canvas is panned away.
    const view = this.visibleArea();
    minX = Math.min(minX, view.left);
    minY = Math.min(minY, view.top);
    maxX = Math.max(maxX, view.left + view.width);
    maxY = Math.max(maxY, view.top + view.height);

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
  }

  readonly scale = computed(() => {
    const b = this.bounds();
    return Math.min(this.mapWidth / b.width, this.mapHeight / b.height);
  });

  readonly scaledNodes = computed(() => {
    const b = this.bounds();
    const s = this.scale();
    return this.nodes().map(n => {
      const meta = getNodeStyleMeta(n.type);
      const size = this.layoutService.sizeOf(n.id);
      return {
        id: n.id,
        title: n.title,
        category: n.category,
        tone: meta.tone,
        state: n.state || 'idle',
        x: (n.x - b.minX) * s,
        y: (n.y - b.minY) * s,
        width: Math.max(8, size.width * s),
        height: Math.max(4, size.height * s),
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

        // A node that is not measured yet has no wire, as on the canvas.
        const from = this.layoutService.portPosition(src, edge.sourcePortId, true);
        const to = this.layoutService.portPosition(tgt, edge.targetPortId, false);
        if (!from || !to) return null;
        return {
          id: edge.id,
          x1: (from.x - b.minX) * s,
          y1: (from.y - b.minY) * s,
          x2: (to.x - b.minX) * s,
          y2: (to.y - b.minY) * s,
        };
      })
      .filter((e): e is { id: string; x1: number; y1: number; x2: number; y2: number } => !!e);
  });

  readonly viewportRect = computed(() => {
    const view = this.visibleArea();
    const b = this.bounds();
    const s = this.scale();

    return {
      x: (view.left - b.minX) * s,
      y: (view.top - b.minY) * s,
      width: Math.max(10, view.width * s),
      height: Math.max(8, view.height * s),
    };
  });

  onMinimapPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    this.dragPointerId = event.pointerId;
    this.frozenBounds.set(this.bounds());
    this.isDragging.set(true);
    this.handleMinimapNavigation(event);
  }

  @HostListener('window:pointermove', ['$event'])
  onWindowPointerMove(event: PointerEvent): void {
    if (this.isDragging() && event.pointerId === this.dragPointerId) {
      this.handleMinimapNavigation(event);
    }
  }

  @HostListener('window:pointerup', ['$event'])
  @HostListener('window:pointercancel', ['$event'])
  onWindowPointerEnd(event: PointerEvent): void {
    if (this.isDragging() && event.pointerId === this.dragPointerId) {
      this.isDragging.set(false);
      this.frozenBounds.set(null);
    }
  }

  private handleMinimapNavigation(event: PointerEvent): void {
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
