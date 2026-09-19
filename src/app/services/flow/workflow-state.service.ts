import { Injectable, computed, signal } from '@angular/core';
import { FlowSubMode } from '@app/types';
import {
  CanvasViewport,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeCategory,
  WorkflowPort,
} from '../../flow/workflow/types/workflow.types';
import {
  STANDARD_IN_PORT,
  STANDARD_TASK_OUTPUTS,
  JOIN_BRANCH_INPUTS,
  FORK_BRANCH_OUTPUTS,
  BOOLEAN_BRANCH_OUTPUTS,
} from '../../flow/workflow/constants/palette.registry';
import { generatePrefixedId } from '../../shared/utils';
import {
  GRID_SIZE,
  MIN_ZOOM,
  MAX_ZOOM,
  NODE_WIDTH,
  DEFAULT_NODE_HEIGHT,
  DEFAULT_CANVAS_WIDTH,
  DEFAULT_CANVAS_HEIGHT,
} from '../../flow/workflow/constants/workflow.constants';

export { GRID_SIZE, MIN_ZOOM, MAX_ZOOM, DEFAULT_CANVAS_WIDTH, DEFAULT_CANVAS_HEIGHT };

/** Cache of computed content hashes keyed by workflow reference to avoid redundant full-tree serializations */
const contentHashCache = new WeakMap<WorkflowDefinition, string>();

/**
 * Generates a deterministic JSON string representing the persistent, non-transient state
 * of a workflow (nodes, edges, settings, positions, and configurations).
 * Excludes transient execution states (e.g. node.state, errorMessage, lastDurationMs)
 * and interactive camera viewport (x, y, zoom).
 */
export function getWorkflowContentHash(wf: WorkflowDefinition | null): string {
  if (!wf) return '';
  const cached = contentHashCache.get(wf);
  if (cached !== undefined) return cached;
  const nodeData = (wf.nodes || []).map(n => ({
    id: n.id,
    type: n.type,
    category: n.category,
    title: n.title,
    titleKey: n.titleKey ?? '',
    subtitle: n.subtitle ?? '',
    x: n.x,
    y: n.y,
    inputs: n.inputs ?? [],
    outputs: n.outputs ?? [],
    config: n.config ?? {},
  }));
  nodeData.sort((a, b) => a.id.localeCompare(b.id));

  const edgeData = (wf.edges || []).map(e => ({
    id: e.id,
    sourceNodeId: e.sourceNodeId,
    sourcePortId: e.sourcePortId,
    targetNodeId: e.targetNodeId,
    targetPortId: e.targetPortId,
  }));
  edgeData.sort((a, b) => a.id.localeCompare(b.id));

  const hash = JSON.stringify({
    name: wf.name || '',
    description: wf.description || '',
    nodes: nodeData,
    edges: edgeData,
  });
  contentHashCache.set(wf, hash);
  return hash;
}

@Injectable({ providedIn: 'root' })
export class WorkflowStateService {
  readonly currentWorkflow = signal<WorkflowDefinition | null>(null);
  readonly viewport = signal<CanvasViewport>({ x: 0, y: 0, zoom: 1 });
  readonly selectedNodeIds = signal<Set<string>>(new Set());
  readonly selectedEdgeIds = signal<Set<string>>(new Set());
  readonly snapToGrid = signal<boolean>(true);
  readonly requestedSubMode = signal<FlowSubMode | null>(null);

  /** Whether a mobile drawer (palette, inspector, or log) is currently open in overlay mode */
  readonly isWorkspaceDrawerOpen = signal<boolean>(false);

  /** Whether the user activated mobile canvas focus mode (hides bottom tabs for full canvas space) */
  readonly isMobileFocusMode = signal<boolean>(false);

  /** Clean reset for mobile-specific drawer and focus UI states */
  resetMobileUiState(): void {
    this.isWorkspaceDrawerOpen.set(false);
    this.isMobileFocusMode.set(false);
  }

  /** Real canvas container dimensions for pixel-perfect fitToView */
  readonly canvasDimensions = signal<{ width: number; height: number }>({
    width: DEFAULT_CANVAS_WIDTH,
    height: DEFAULT_CANVAS_HEIGHT,
  });

  /** Set to true while any node is actively dragging to suppress expensive full serialization */
  readonly isDraggingNode = signal<boolean>(false);

  /** Monotonic revision counters for O(1) dirty state tracking */
  private readonly currentRevision = signal<number>(0);
  private readonly savedRevision = signal<number>(0);

  /** Hash of the workflow as last loaded or saved */
  readonly lastSavedHash = signal<string>('');

  /** Indicates whether the current workflow has unsaved changes compared to last saved state */
  readonly hasUnsavedChanges = computed<boolean>(() => {
    const current = this.currentWorkflow();
    if (!current) return false;
    const baseline = this.lastSavedHash();
    if (!baseline) return false;
    // O(1) fast-path: matching revisions guarantee clean state (e.g. undo back to baseline or transient state updates)
    if (this.currentRevision() === this.savedRevision()) return false;
    return getWorkflowContentHash(current) !== baseline;
  });

  /** Active wire dragging state */
  readonly isConnecting = signal<{
    sourceNodeId: string;
    sourcePortId: string;
    isSourceOutput: boolean;
    currentX: number;
    currentY: number;
  } | null>(null);

  /** Undo / Redo history stacks */
  private readonly undoStack: WorkflowDefinition[] = [];
  private readonly undoRevisions: number[] = [];
  private readonly redoStack: WorkflowDefinition[] = [];
  private readonly redoRevisions: number[] = [];
  readonly canUndo = signal(false);
  readonly canRedo = signal(false);

  /** Currently selected single node (if exactly one is selected) */
  readonly selectedNode = computed<WorkflowNode | null>(() => {
    const ids = this.selectedNodeIds();
    const wf = this.currentWorkflow();
    if (!wf || ids.size !== 1) return null;
    const [firstId] = ids;
    return wf.nodes.find(n => n.id === firstId) ?? null;
  });

  /** Currently selected single edge (if exactly one is selected) */
  readonly selectedEdge = computed<WorkflowEdge | null>(() => {
    const ids = this.selectedEdgeIds();
    const wf = this.currentWorkflow();
    if (!wf || ids.size !== 1) return null;
    const [firstId] = ids;
    return wf.edges.find(e => e.id === firstId) ?? null;
  });

  /**
   * Loads a workflow definition into the active canvas state.
   */
  loadWorkflow(workflow: WorkflowDefinition): void {
    this.currentWorkflow.set(structuredClone(workflow));
    this.viewport.set(workflow.viewport ?? { x: 0, y: 0, zoom: 1 });
    this.clearSelection();
    this.undoStack.length = 0;
    this.undoRevisions.length = 0;
    this.redoStack.length = 0;
    this.redoRevisions.length = 0;
    this.currentRevision.set(0);
    this.savedRevision.set(0);
    this.updateUndoRedoSignals();
    this.lastSavedHash.set(getWorkflowContentHash(workflow));
  }

  /**
   * Marks the current active workflow state as saved, resetting the dirty flag.
   */
  markSaved(wf?: WorkflowDefinition): void {
    const target = wf ?? this.currentWorkflow();
    if (target) {
      this.lastSavedHash.set(getWorkflowContentHash(target));
      this.savedRevision.set(this.currentRevision());
    }
  }

  /**
   * Creates a blank new workflow on the canvas.
   */
  createNewWorkflow(name = 'New Workflow'): WorkflowDefinition {
    const newWf: WorkflowDefinition = {
      id: generatePrefixedId('wf'),
      name,
      description: '',
      showOnTray: false,
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.loadWorkflow(newWf);
    return newWf;
  }

  /**
   * Updates top-level metadata of the active workflow (name, description, auto_start, cron_expression).
   */
  updateWorkflowMetadata(patch: Partial<WorkflowDefinition>): void {
    this.snapshot();
    this.currentWorkflow.update(wf => {
      if (!wf) return null;
      return {
        ...wf,
        ...patch,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  setWorkflowName(name: string): void {
    this.updateWorkflowMetadata({ name });
  }

  setWorkflowDescription(description: string): void {
    this.updateWorkflowMetadata({ description });
  }

  /**
   * Records a snapshot into the undo stack before making mutations.
   */
  snapshot(): void {
    const current = this.currentWorkflow();
    if (current) {
      this.undoStack.push(structuredClone(current));
      this.undoRevisions.push(this.currentRevision());
      if (this.undoStack.length > 50) {
        this.undoStack.shift();
        this.undoRevisions.shift();
      }
      this.redoStack.length = 0;
      this.redoRevisions.length = 0;
      this.updateUndoRedoSignals();
      this.currentRevision.update(r => r + 1);
    }
  }

  undo(): void {
    const prev = this.undoStack.pop();
    const prevRev = this.undoRevisions.pop();
    if (!prev || prevRev === undefined) return;
    const current = this.currentWorkflow();
    if (current) {
      this.redoStack.push(structuredClone(current));
      this.redoRevisions.push(this.currentRevision());
    }
    this.currentRevision.set(prevRev);
    this.currentWorkflow.set(prev);
    this.updateUndoRedoSignals();
  }

  redo(): void {
    const next = this.redoStack.pop();
    const nextRev = this.redoRevisions.pop();
    if (!next || nextRev === undefined) return;
    const current = this.currentWorkflow();
    if (current) {
      this.undoStack.push(structuredClone(current));
      this.undoRevisions.push(this.currentRevision());
    }
    this.currentRevision.set(nextRev);
    this.currentWorkflow.set(next);
    this.updateUndoRedoSignals();
  }

  private updateUndoRedoSignals(): void {
    this.canUndo.set(this.undoStack.length > 0);
    this.canRedo.set(this.redoStack.length > 0);
  }

  // ── Node Management ──────────────────────────────────────────────────────

  addNode(
    type: string,
    category: WorkflowNodeCategory,
    title: string,
    x: number,
    y: number,
    options?: {
      inputs?: WorkflowPort[];
      outputs?: WorkflowPort[];
      config?: Record<string, unknown>;
      titleKey?: string;
    }
  ): WorkflowNode {
    this.snapshot();
    const posX = this.snapToGrid() ? Math.round(x / GRID_SIZE) * GRID_SIZE : x;
    const posY = this.snapToGrid() ? Math.round(y / GRID_SIZE) * GRID_SIZE : y;

    let defaultInputs: WorkflowPort[];
    if (options?.inputs) {
      defaultInputs = options.inputs;
    } else if (category === 'trigger') {
      defaultInputs = [];
    } else if (type === 'join') {
      defaultInputs = JOIN_BRANCH_INPUTS;
    } else {
      defaultInputs = [STANDARD_IN_PORT];
    }

    let defaultOutputs: WorkflowPort[];
    if (options?.outputs) {
      defaultOutputs = options.outputs;
    } else if (type === 'parallel_fork') {
      defaultOutputs = FORK_BRANCH_OUTPUTS;
    } else if (type === 'condition') {
      defaultOutputs = BOOLEAN_BRANCH_OUTPUTS;
    } else if (category === 'task') {
      defaultOutputs = STANDARD_TASK_OUTPUTS;
    } else {
      defaultOutputs = [
        { id: 'out', name: 'Out', type: 'out', labelKey: 'flow.workflow.ports.out' },
      ];
    }

    const newNode: WorkflowNode = {
      id: generatePrefixedId('node'),
      type,
      category,
      title,
      titleKey: options?.titleKey,
      x: posX,
      y: posY,
      inputs: defaultInputs,
      outputs: defaultOutputs,
      config: options?.config ?? {},
      state: 'idle',
    };

    this.currentWorkflow.update(wf => {
      if (!wf) return null;
      return {
        ...wf,
        nodes: [...wf.nodes, newNode],
        updatedAt: new Date().toISOString(),
      };
    });

    this.selectNode(newNode.id, false);
    return newNode;
  }

  updateNodePosition(id: string, x: number, y: number): void {
    const finalX = this.snapToGrid() ? Math.round(x / GRID_SIZE) * GRID_SIZE : x;
    const finalY = this.snapToGrid() ? Math.round(y / GRID_SIZE) * GRID_SIZE : y;

    this.currentRevision.update(r => r + 1);
    this.currentWorkflow.update(wf => {
      if (!wf) return null;
      return {
        ...wf,
        nodes: wf.nodes.map(n => (n.id === id ? { ...n, x: finalX, y: finalY } : n)),
      };
    });
  }

  updateNodesPositions(updates: Map<string, { x: number; y: number }>): void {
    const snap = this.snapToGrid();
    this.currentRevision.update(r => r + 1);
    this.currentWorkflow.update(wf => {
      if (!wf) return null;
      return {
        ...wf,
        nodes: wf.nodes.map(n => {
          const pos = updates.get(n.id);
          if (!pos) return n;
          const finalX = snap ? Math.round(pos.x / GRID_SIZE) * GRID_SIZE : pos.x;
          const finalY = snap ? Math.round(pos.y / GRID_SIZE) * GRID_SIZE : pos.y;
          return { ...n, x: finalX, y: finalY };
        }),
      };
    });
  }

  updateNodeConfig(id: string, config: Record<string, unknown>): void {
    this.snapshot();
    this.currentWorkflow.update(wf => {
      if (!wf) return null;
      return {
        ...wf,
        nodes: wf.nodes.map(n => (n.id === id ? { ...n, config: { ...n.config, ...config } } : n)),
        updatedAt: new Date().toISOString(),
      };
    });
  }

  /**
   * Removes a specific field (or dot-notated nested path) from a node's config.
   */
  removeConfigField(nodeId: string, path: string): void {
    this.snapshot();
    this.currentWorkflow.update(wf => {
      if (!wf) return null;
      return {
        ...wf,
        nodes: wf.nodes.map(n => {
          if (n.id !== nodeId) return n;
          const config = structuredClone(n.config || {});
          this.deleteNestedKey(config, path);
          return { ...n, config };
        }),
        updatedAt: new Date().toISOString(),
      };
    });
  }

  private deleteNestedKey(obj: Record<string, unknown>, path: string): void {
    const keys = path.split('.');
    let current: unknown = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      if (current && typeof current === 'object' && keys[i] in current) {
        current = (current as Record<string, unknown>)[keys[i]];
      } else {
        return;
      }
    }
    const lastKey = keys[keys.length - 1];
    if (current && typeof current === 'object' && lastKey in current) {
      delete (current as Record<string, unknown>)[lastKey];
    }
  }

  updateNodeMetadata(id: string, patch: Partial<WorkflowNode>): void {
    this.snapshot();
    this.currentWorkflow.update(wf => {
      if (!wf) return null;
      return {
        ...wf,
        nodes: wf.nodes.map(n => (n.id === id ? { ...n, ...patch } : n)),
        updatedAt: new Date().toISOString(),
      };
    });
  }

  updateNode(id: string, patch: Partial<WorkflowNode>): void {
    this.snapshot();
    this.currentWorkflow.update(wf => {
      if (!wf) return null;
      return {
        ...wf,
        nodes: wf.nodes.map(n => {
          if (n.id !== id) return n;
          return {
            ...n,
            ...patch,
            config: patch.config ? { ...n.config, ...patch.config } : n.config,
          };
        }),
        updatedAt: new Date().toISOString(),
      };
    });
  }

  updateNodeExecutionState(
    id: string,
    state: WorkflowNode['state'],
    errorMessage?: string,
    durationMs?: number,
    output?: unknown
  ): void {
    this.currentWorkflow.update(wf => {
      if (!wf) return null;
      return {
        ...wf,
        nodes: wf.nodes.map(n =>
          n.id === id
            ? {
                ...n,
                state,
                errorMessage,
                lastDurationMs: durationMs ?? n.lastDurationMs,
                lastOutput: output !== undefined ? output : n.lastOutput,
              }
            : n
        ),
      };
    });
  }

  duplicateNode(id: string): WorkflowNode | null {
    const wf = this.currentWorkflow();
    if (!wf) return null;
    const source = wf.nodes.find(n => n.id === id);
    if (!source) return null;

    this.snapshot();
    const duplicated: WorkflowNode = {
      ...structuredClone(source),
      id: generatePrefixedId('node'),
      title: `${source.title} (Copy)`,
      titleKey: undefined,
      x: source.x + 32,
      y: source.y + 32,
      state: 'idle',
    };

    this.currentWorkflow.update(w => {
      if (!w) return null;
      return { ...w, nodes: [...w.nodes, duplicated], updatedAt: new Date().toISOString() };
    });

    this.selectNode(duplicated.id, false);
    return duplicated;
  }

  removeNode(id: string): void {
    this.snapshot();
    this.currentWorkflow.update(wf => {
      if (!wf) return null;
      return {
        ...wf,
        nodes: wf.nodes.filter(n => n.id !== id),
        edges: wf.edges.filter(e => e.sourceNodeId !== id && e.targetNodeId !== id),
        updatedAt: new Date().toISOString(),
      };
    });
    this.selectedNodeIds.update(set => {
      const next = new Set(set);
      next.delete(id);
      return next;
    });
  }

  addJoinInputPort(nodeId: string): void {
    this.snapshot();
    this.currentWorkflow.update(wf => {
      if (!wf) return null;
      return {
        ...wf,
        nodes: wf.nodes.map(n => {
          if (n.id !== nodeId) return n;
          const currentInputs = n.inputs || [];
          const nextIndex = currentInputs.length + 1;
          const newPort: WorkflowPort = {
            id: `in${nextIndex}`,
            name: `In ${nextIndex}`,
            type: 'in',
            label: `In ${nextIndex}`,
          };
          return {
            ...n,
            inputs: [...currentInputs, newPort],
          };
        }),
        updatedAt: new Date().toISOString(),
      };
    });
  }

  removeJoinInputPort(nodeId: string, portId?: string): void {
    this.snapshot();
    this.currentWorkflow.update(wf => {
      if (!wf) return null;
      const targetNode = wf.nodes.find(n => n.id === nodeId);
      if (!targetNode || (targetNode.inputs && targetNode.inputs.length <= 2)) {
        return wf;
      }
      const portToRemove = portId || targetNode.inputs[targetNode.inputs.length - 1].id;
      return {
        ...wf,
        nodes: wf.nodes.map(n => {
          if (n.id !== nodeId) return n;
          return {
            ...n,
            inputs: n.inputs.filter(p => p.id !== portToRemove),
          };
        }),
        edges: wf.edges.filter(
          e => !(e.targetNodeId === nodeId && e.targetPortId === portToRemove)
        ),
        updatedAt: new Date().toISOString(),
      };
    });
  }

  addForkOutputPort(nodeId: string): void {
    this.snapshot();
    this.currentWorkflow.update(wf => {
      if (!wf) return null;
      return {
        ...wf,
        nodes: wf.nodes.map(n => {
          if (n.id !== nodeId) return n;
          const currentOutputs = n.outputs || [];
          let nextIndex = currentOutputs.length + 1;
          while (currentOutputs.some(p => p.id === `branch${nextIndex}`)) {
            nextIndex++;
          }
          const newPort: WorkflowPort = {
            id: `branch${nextIndex}`,
            name: `Branch ${nextIndex}`,
            type: 'out',
            label: `Branch ${nextIndex}`,
          };
          return {
            ...n,
            outputs: [...currentOutputs, newPort],
          };
        }),
        updatedAt: new Date().toISOString(),
      };
    });
  }

  removeForkOutputPort(nodeId: string, portId?: string): void {
    this.snapshot();
    this.currentWorkflow.update(wf => {
      if (!wf) return null;
      const targetNode = wf.nodes.find(n => n.id === nodeId);
      if (!targetNode || (targetNode.outputs && targetNode.outputs.length <= 2)) {
        return wf;
      }
      const portToRemove = portId || targetNode.outputs[targetNode.outputs.length - 1].id;
      return {
        ...wf,
        nodes: wf.nodes.map(n => {
          if (n.id !== nodeId) return n;
          return {
            ...n,
            outputs: n.outputs.filter(p => p.id !== portToRemove),
          };
        }),
        edges: wf.edges.filter(
          e => !(e.sourceNodeId === nodeId && e.sourcePortId === portToRemove)
        ),
        updatedAt: new Date().toISOString(),
      };
    });
  }

  // ── Edge / Connection Management ─────────────────────────────────────────

  connectPorts(
    sourceNodeId: string,
    sourcePortId: string,
    targetNodeId: string,
    targetPortId: string
  ): boolean {
    if (sourceNodeId === targetNodeId) return false;

    const wf = this.currentWorkflow();
    if (!wf) return false;

    // Check if edge already exists
    const exists = wf.edges.some(
      e =>
        e.sourceNodeId === sourceNodeId &&
        e.sourcePortId === sourcePortId &&
        e.targetNodeId === targetNodeId &&
        e.targetPortId === targetPortId
    );
    if (exists) return false;

    this.snapshot();
    const newEdge: WorkflowEdge = {
      id: generatePrefixedId('edge'),
      sourceNodeId,
      sourcePortId,
      targetNodeId,
      targetPortId,
    };

    this.currentWorkflow.update(w => {
      if (!w) return null;
      return {
        ...w,
        edges: [...w.edges, newEdge],
        updatedAt: new Date().toISOString(),
      };
    });

    return true;
  }

  removeEdge(id: string): void {
    this.snapshot();
    this.currentWorkflow.update(wf => {
      if (!wf) return null;
      return {
        ...wf,
        edges: wf.edges.filter(e => e.id !== id),
        updatedAt: new Date().toISOString(),
      };
    });
    this.selectedEdgeIds.update(set => {
      const next = new Set(set);
      next.delete(id);
      return next;
    });
  }

  startConnecting(
    sourceNodeId: string,
    sourcePortId: string,
    currentX: number,
    currentY: number,
    isSourceOutput = true
  ): void {
    this.isConnecting.set({ sourceNodeId, sourcePortId, isSourceOutput, currentX, currentY });
  }

  updateConnecting(currentX: number, currentY: number): void {
    this.isConnecting.update(val => (val ? { ...val, currentX, currentY } : null));
  }

  cancelConnecting(): void {
    this.isConnecting.set(null);
  }

  finishConnecting(targetNodeId: string, targetPortId: string, isTargetOutput = false): boolean {
    const conn = this.isConnecting();
    if (!conn) return false;
    this.isConnecting.set(null);

    // Disallow connecting output-to-output or input-to-input
    if (conn.isSourceOutput === isTargetOutput) return false;

    if (conn.isSourceOutput) {
      return this.connectPorts(conn.sourceNodeId, conn.sourcePortId, targetNodeId, targetPortId);
    } else {
      // Started from input, dropped on output -> target is output source, conn is input target
      return this.connectPorts(targetNodeId, targetPortId, conn.sourceNodeId, conn.sourcePortId);
    }
  }

  // ── Selection ────────────────────────────────────────────────────────────

  selectNode(id: string, multi = false): void {
    this.selectedEdgeIds.set(new Set());
    if (multi) {
      this.selectedNodeIds.update(set => {
        const next = new Set(set);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    } else {
      this.selectedNodeIds.set(new Set([id]));
    }
  }

  selectEdge(id: string, multi = false): void {
    this.selectedNodeIds.set(new Set());
    if (multi) {
      this.selectedEdgeIds.update(set => {
        const next = new Set(set);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    } else {
      this.selectedEdgeIds.set(new Set([id]));
    }
  }

  clearSelection(): void {
    this.selectedNodeIds.set(new Set());
    this.selectedEdgeIds.set(new Set());
  }

  removeSelected(): void {
    const nodeIds = this.selectedNodeIds();
    const edgeIds = this.selectedEdgeIds();
    if (nodeIds.size === 0 && edgeIds.size === 0) return;

    this.snapshot();
    this.currentWorkflow.update(wf => {
      if (!wf) return null;
      return {
        ...wf,
        nodes: wf.nodes.filter(n => !nodeIds.has(n.id)),
        edges: wf.edges.filter(
          e => !edgeIds.has(e.id) && !nodeIds.has(e.sourceNodeId) && !nodeIds.has(e.targetNodeId)
        ),
        updatedAt: new Date().toISOString(),
      };
    });
    this.clearSelection();
  }

  // ── Canvas Pan & Zoom ────────────────────────────────────────────────────

  setPan(x: number, y: number): void {
    this.viewport.update(v => ({ ...v, x, y }));
  }

  panBy(dx: number, dy: number): void {
    this.viewport.update(v => ({ ...v, x: v.x + dx, y: v.y + dy }));
  }

  setZoom(zoom: number, centerX = 0, centerY = 0): void {
    const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
    this.viewport.update(v => {
      const zoomRatio = clamped / v.zoom;
      return {
        x: centerX - (centerX - v.x) * zoomRatio,
        y: centerY - (centerY - v.y) * zoomRatio,
        zoom: clamped,
      };
    });
  }

  zoomIn(): void {
    this.setZoom(this.viewport().zoom * 1.2);
  }

  zoomOut(): void {
    this.setZoom(this.viewport().zoom / 1.2);
  }

  resetZoom(): void {
    this.viewport.set({ x: 0, y: 0, zoom: 1 });
  }

  fitToView(containerWidth?: number, containerHeight?: number): void {
    const dims = this.canvasDimensions();
    const width = containerWidth ?? dims.width;
    const height = containerHeight ?? dims.height;

    const wf = this.currentWorkflow();
    if (!wf || wf.nodes.length === 0) {
      this.resetZoom();
      return;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const n of wf.nodes) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + NODE_WIDTH);
      maxY = Math.max(maxY, n.y + DEFAULT_NODE_HEIGHT);
    }

    const contentWidth = maxX - minX + 100;
    const contentHeight = maxY - minY + 100;

    const zoomX = width / contentWidth;
    const zoomY = height / contentHeight;
    const zoom = Math.max(MIN_ZOOM, Math.min(1.2, Math.min(zoomX, zoomY)));

    const x = (width - contentWidth * zoom) / 2 - minX * zoom;
    const y = (height - contentHeight * zoom) / 2 - minY * zoom;

    this.viewport.set({ x, y, zoom });
  }
}
