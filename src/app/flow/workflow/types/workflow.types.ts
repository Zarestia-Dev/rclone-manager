import type { PillTone } from '../../../shared/types/pill';

export type WorkflowNodeCategory = 'trigger' | 'task' | 'logic' | 'action';

type WorkflowPortType = 'in' | 'out' | 'success' | 'failure' | 'true' | 'false';

export interface WorkflowPort {
  id: string;
  name: string;
  type: WorkflowPortType;
  label?: string;
  labelKey?: string;
  /** Values for the placeholders of `labelKey`. */
  labelParams?: Record<string, unknown>;
  description?: string;
}

export type WorkflowNodeExecutionState =
  'idle' | 'queued' | 'running' | 'success' | 'failed' | 'skipped';

export interface WorkflowNode {
  id: string;
  type: string;
  category: WorkflowNodeCategory;
  title: string;
  titleKey?: string;
  subtitle?: string;
  x: number;
  y: number;
  inputs: WorkflowPort[];
  outputs: WorkflowPort[];
  config: Record<string, unknown>;
  state?: WorkflowNodeExecutionState;
  errorMessage?: string;
  lastDurationMs?: number;
  lastOutput?: Record<string, unknown> | unknown;
  startedAt?: string;
  finishedAt?: string;
}

/**
 * A node as the browser laid it out, in canvas units (zoom does not change it): its size and where
 * the centre of each port sits, measured from the node's top-left corner. Keys come from `portKey`.
 */
export interface NodeLayout {
  width: number;
  height: number;
  ports: Record<string, { x: number; y: number }>;
}

export interface WorkflowEdge {
  id: string;
  sourceNodeId: string;
  sourcePortId: string;
  targetNodeId: string;
  targetPortId: string;
  isActive?: boolean;
}

export interface CanvasViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  description?: string;
  showOnTray: boolean;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  viewport: CanvasViewport;
  createdAt?: string;
  updatedAt?: string;
  lastExecutedAt?: string;
}

/** What checking a workflow found: `errors` stop a run, `warnings` are worth a look. Both are shown as is. */
export interface WorkflowChecks {
  errors: string[];
  warnings: string[];
}

/** A node of a template: titled by its key, in the language of whoever opens the template. */
export type TemplateNode = Omit<WorkflowNode, 'title' | 'titleKey'> & { titleKey: string };

/** A built-in workflow to start from. What a user reads is a translation key, never text. */
export interface WorkflowTemplate {
  id: string;
  nameKey: string;
  descriptionKey: string;
  category: 'backup' | 'automation' | 'sync' | 'utility';
  icon: string;
  definition: Omit<
    WorkflowDefinition,
    'id' | 'name' | 'description' | 'nodes' | 'createdAt' | 'updatedAt' | 'showOnTray'
  > & { nodes: TemplateNode[] };
}

export interface NodePaletteItem {
  type: string;
  category: WorkflowNodeCategory;
  titleKey: string;
  descriptionKey: string;
  icon: string;
  tone?: PillTone;
  defaultInputs: WorkflowPort[];
  defaultOutputs: WorkflowPort[];
  defaultConfig: Record<string, unknown>;
  hideOnMobile?: boolean;
}
