import { Injectable, computed, inject, signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
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
  toPersistableNode,
  toPersistableWorkflow,
  withRuntimeFields,
} from '../../flow/workflow/utils/workflow-persist.util';
import {
  GRID_SIZE,
  MIN_ZOOM,
  MAX_ZOOM,
  NODE_WIDTH,
  DEFAULT_NODE_HEIGHT,
  DEFAULT_CANVAS_WIDTH,
  DEFAULT_CANVAS_HEIGHT,
} from '../../flow/workflow/constants/workflow.constants';

/** Edits of the same field closer together than this are one undo step. */
const COALESCE_WINDOW_MS = 1000;
const MAX_UNDO_STEPS = 50;

/** Cache of computed content hashes keyed by workflow reference to avoid redundant full-tree serializations */
const contentHashCache = new WeakMap<WorkflowDefinition, string>();

/**
 * Generates a deterministic JSON string representing the persistent, non-transient state
 * of a workflow (nodes, edges, settings, positions, and configurations).
 * Excludes transient execution states (e.g. node.state, errorMessage, lastDurationMs)
 * and interactive camera viewport (x, y, zoom).
 */
function getWorkflowContentHash(wf: WorkflowDefinition | null): string {
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
  private readonly translate = inject(TranslateService);

  readonly currentWorkflow = signal<WorkflowDefinition | null>(null);
  readonly viewport = signal<CanvasViewport>({ x: 0, y: 0, zoom: 1 });
  readonly selectedNodeIds = signal<Set<string>>(new Set());
  readonly selectedEdgeIds = signal<Set<string>>(new Set());
  readonly snapToGrid = signal<boolean>(true);

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

  /** True while a node is being dragged: the workflow is changing, so it is not compared with the saved one on every frame */
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
    // Dragging changes the workflow on every frame; hashing it each time would cost more than it tells.
    if (this.isDraggingNode()) return true;
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
  createNewWorkflow(name = this.translate.instant('flow.workflow.untitled')): WorkflowDefinition {
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
    this.edit(() => patch, `workflow:${Object.keys(patch).join(',')}`);
  }

  setWorkflowName(name: string): void {
    this.updateWorkflowMetadata({ name });
  }

  setWorkflowDescription(description: string): void {
    this.updateWorkflowMetadata({ description });
  }

  /**
   * Changes the workflow on the canvas as one undoable step. Repeated edits sharing a
   * `coalesceKey` in quick succession (typing in a field) are a single step.
   */
  private edit(
    change: (workflow: WorkflowDefinition) => Partial<WorkflowDefinition>,
    coalesceKey?: string
  ): void {
    this.snapshot(coalesceKey);
    this.currentWorkflow.update(wf =>
      wf ? { ...wf, ...change(wf), updatedAt: new Date().toISOString() } : null
    );
  }

  private lastSnapshot = { key: '', at: 0 };

  /** A copy for the undo history: what was edited, without the results of a run. */
  private cloneForHistory(workflow: WorkflowDefinition): WorkflowDefinition {
    return structuredClone(toPersistableWorkflow(workflow));
  }

  /**
   * Records a snapshot into the undo stack before making mutations.
   */
  snapshot(coalesceKey?: string): void {
    const current = this.currentWorkflow();
    if (!current) return;

    const now = Date.now();
    const joinsLastStep =
      coalesceKey !== undefined &&
      this.lastSnapshot.key === coalesceKey &&
      now - this.lastSnapshot.at < COALESCE_WINDOW_MS &&
      this.undoStack.length > 0;
    this.lastSnapshot = { key: coalesceKey ?? '', at: now };

    if (!joinsLastStep) {
      this.undoStack.push(this.cloneForHistory(current));
      this.undoRevisions.push(this.currentRevision());
      if (this.undoStack.length > MAX_UNDO_STEPS) {
        this.undoStack.shift();
        this.undoRevisions.shift();
      }
      this.redoStack.length = 0;
      this.redoRevisions.length = 0;
      this.updateUndoRedoSignals();
    }
    this.currentRevision.update(r => r + 1);
  }

  undo(): void {
    const prev = this.undoStack.pop();
    const prevRev = this.undoRevisions.pop();
    if (!prev || prevRev === undefined) return;
    const current = this.currentWorkflow();
    if (current) {
      this.redoStack.push(this.cloneForHistory(current));
      this.redoRevisions.push(this.currentRevision());
    }
    this.restore(prev, prevRev, current);
  }

  redo(): void {
    const next = this.redoStack.pop();
    const nextRev = this.redoRevisions.pop();
    if (!next || nextRev === undefined) return;
    const current = this.currentWorkflow();
    if (current) {
      this.undoStack.push(this.cloneForHistory(current));
      this.undoRevisions.push(this.currentRevision());
    }
    this.restore(next, nextRev, current);
  }

  /** Puts a history step on the canvas. What the last run left on the nodes stays with them. */
  private restore(
    step: WorkflowDefinition,
    revision: number,
    current: WorkflowDefinition | null
  ): void {
    this.lastSnapshot = { key: '', at: 0 };
    this.currentRevision.set(revision);
    this.currentWorkflow.set(
      current ? { ...step, nodes: withRuntimeFields(step.nodes, current.nodes) } : step
    );
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

    this.currentWorkflow.update(wf =>
      wf ? { ...wf, nodes: [...wf.nodes, newNode], updatedAt: new Date().toISOString() } : null
    );

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

  /** Merges `config` into the node's settings (top-level keys). */
  updateNodeConfig(id: string, config: Record<string, unknown>): void {
    this.edit(
      wf => ({
        nodes: wf.nodes.map(n => (n.id === id ? { ...n, config: { ...n.config, ...config } } : n)),
      }),
      `config:${id}:${Object.keys(config).join(',')}`
    );
  }

  /**
   * Sets settings of a node by dot-notated path (`config.rclone.srcFs`), creating the
   * levels in between. All the paths change as one undoable step.
   */
  updateNodeConfigPaths(id: string, entries: Record<string, unknown>): void {
    this.edit(
      wf => ({
        nodes: wf.nodes.map(n => {
          if (n.id !== id) return n;
          const config = structuredClone(n.config || {});
          for (const [path, value] of Object.entries(entries)) {
            this.setNestedKey(config, path, value);
          }
          return { ...n, config };
        }),
      }),
      `config:${id}:${Object.keys(entries).join(',')}`
    );
  }

  /**
   * Removes a specific field (or dot-notated nested path) from a node's config.
   */
  removeConfigField(nodeId: string, path: string): void {
    this.edit(wf => ({
      nodes: wf.nodes.map(n => {
        if (n.id !== nodeId) return n;
        const config = structuredClone(n.config || {});
        this.deleteNestedKey(config, path);
        return { ...n, config };
      }),
    }));
  }

  private setNestedKey(obj: Record<string, unknown>, path: string, value: unknown): void {
    const keys = path.split('.');
    let current = obj;
    for (const key of keys.slice(0, -1)) {
      const next = current[key];
      if (!next || typeof next !== 'object' || Array.isArray(next)) current[key] = {};
      current = current[key] as Record<string, unknown>;
    }
    current[keys[keys.length - 1]] = value;
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

  /** Changes a node's own fields (title, subtitle, …); `patch.config` is merged into its settings. */
  updateNode(id: string, patch: Partial<WorkflowNode>): void {
    this.edit(
      wf => ({
        nodes: wf.nodes.map(n =>
          n.id === id
            ? {
                ...n,
                ...patch,
                config: patch.config ? { ...n.config, ...patch.config } : n.config,
              }
            : n
        ),
      }),
      `node:${id}:${Object.keys(patch).join(',')}`
    );
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

    const sourceTitle = source.titleKey ? this.translate.instant(source.titleKey) : source.title;
    const duplicated: WorkflowNode = {
      ...structuredClone(toPersistableNode(source)),
      id: generatePrefixedId('node'),
      title: this.translate.instant('flow.workflow.copyName', { name: sourceTitle }),
      titleKey: undefined,
      x: source.x + 32,
      y: source.y + 32,
      state: 'idle',
    };

    this.edit(w => ({ nodes: [...w.nodes, duplicated] }));
    this.selectNode(duplicated.id, false);
    return duplicated;
  }

  removeNode(id: string): void {
    this.edit(wf => ({
      nodes: wf.nodes.filter(n => n.id !== id),
      edges: wf.edges.filter(e => e.sourceNodeId !== id && e.targetNodeId !== id),
    }));
    this.selectedNodeIds.update(set => {
      const next = new Set(set);
      next.delete(id);
      return next;
    });
  }

  addJoinInputPort(nodeId: string): void {
    this.addPort(nodeId, 'inputs', 'in', 'flow.workflow.ports.inN', 'In');
  }

  removeJoinInputPort(nodeId: string, portId?: string): void {
    this.removePort(nodeId, 'inputs', portId);
  }

  addForkOutputPort(nodeId: string): void {
    this.addPort(nodeId, 'outputs', 'branch', 'flow.workflow.ports.branchN', 'Branch');
  }

  removeForkOutputPort(nodeId: string, portId?: string): void {
    this.removePort(nodeId, 'outputs', portId);
  }

  /** Appends the next free `<prefix><n>` port to a node's inputs or outputs. */
  private addPort(
    nodeId: string,
    side: 'inputs' | 'outputs',
    idPrefix: 'in' | 'branch',
    labelKey: string,
    fallbackLabel: string
  ): void {
    this.snapshot();
    this.currentWorkflow.update(wf =>
      updateNodePorts(wf, nodeId, node => {
        const current = node[side] || [];
        let n = current.length + 1;
        while (current.some(p => p.id === `${idPrefix}${n}`)) n++;
        const label = `${fallbackLabel} ${n}`;
        const port: WorkflowPort = {
          id: `${idPrefix}${n}`,
          name: label,
          type: side === 'inputs' ? 'in' : 'out',
          label,
          labelKey,
          labelParams: { n },
        };
        const ports = [...current, port];
        return side === 'inputs' ? { inputs: ports } : { outputs: ports };
      })
    );
  }

  /** Removes a port (the last one by default), and the wires on it. A node keeps at least two. */
  private removePort(nodeId: string, side: 'inputs' | 'outputs', portId?: string): void {
    this.snapshot();
    this.currentWorkflow.update(wf =>
      updateNodePorts(wf, nodeId, node => {
        const current = node[side];
        if (!current || current.length <= 2) return null;
        const removedPortId = portId || current[current.length - 1].id;
        const ports = current.filter(p => p.id !== removedPortId);
        return side === 'inputs'
          ? { inputs: ports, removedPortId, isInput: true }
          : { outputs: ports, removedPortId, isInput: false };
      })
    );
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

    // A run could never start with the wire that closes a loop, so it is not drawn.
    if (this.reaches(wf.edges, targetNodeId, sourceNodeId)) return false;

    const newEdge: WorkflowEdge = {
      id: generatePrefixedId('edge'),
      sourceNodeId,
      sourcePortId,
      targetNodeId,
      targetPortId,
    };

    this.edit(w => ({ edges: [...w.edges, newEdge] }));

    return true;
  }

  /** Whether a path of wires leads from `from` to `to`. */
  private reaches(edges: readonly WorkflowEdge[], from: string, to: string): boolean {
    const next = new Map<string, string[]>();
    for (const edge of edges) {
      next.set(edge.sourceNodeId, [...(next.get(edge.sourceNodeId) ?? []), edge.targetNodeId]);
    }
    const seen = new Set<string>();
    const pending = [from];
    while (pending.length > 0) {
      const node = pending.pop() as string;
      if (node === to) return true;
      if (seen.has(node)) continue;
      seen.add(node);
      pending.push(...(next.get(node) ?? []));
    }
    return false;
  }

  removeEdge(id: string): void {
    this.edit(wf => ({ edges: wf.edges.filter(e => e.id !== id) }));
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

    this.edit(wf => ({
      nodes: wf.nodes.filter(n => !nodeIds.has(n.id)),
      edges: wf.edges.filter(
        e => !edgeIds.has(e.id) && !nodeIds.has(e.sourceNodeId) && !nodeIds.has(e.targetNodeId)
      ),
    }));
    this.clearSelection();
  }

  // ── Canvas Pan & Zoom ────────────────────────────────────────────────────

  setPan(x: number, y: number): void {
    this.viewport.update(v => ({ ...v, x, y }));
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

function updateNodePorts(
  wf: WorkflowDefinition | null,
  nodeId: string,
  transform: (node: WorkflowNode) => {
    inputs?: WorkflowPort[];
    outputs?: WorkflowPort[];
    removedPortId?: string;
    isInput?: boolean;
  } | null
): WorkflowDefinition | null {
  if (!wf) return null;
  const targetNode = wf.nodes.find(n => n.id === nodeId);
  if (!targetNode) return wf;

  const result = transform(targetNode);
  if (!result) return wf;

  const { inputs, outputs, removedPortId, isInput } = result;

  const nodes = wf.nodes.map(n => {
    if (n.id !== nodeId) return n;
    return {
      ...n,
      ...(inputs !== undefined ? { inputs } : {}),
      ...(outputs !== undefined ? { outputs } : {}),
    };
  });

  let edges = wf.edges;
  if (removedPortId) {
    edges = edges.filter(e =>
      isInput
        ? !(e.targetNodeId === nodeId && e.targetPortId === removedPortId)
        : !(e.sourceNodeId === nodeId && e.sourcePortId === removedPortId)
    );
  }

  return {
    ...wf,
    nodes,
    edges,
    updatedAt: new Date().toISOString(),
  };
}
