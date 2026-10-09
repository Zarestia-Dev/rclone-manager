export type WorkflowNodeCategory = 'trigger' | 'task' | 'logic' | 'action';

type WorkflowPortType = 'in' | 'out' | 'success' | 'failure' | 'true' | 'false';

export interface WorkflowPort {
  id: string;
  name: string;
  type: WorkflowPortType;
  label?: string;
  labelKey?: string;
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

export interface WorkflowTemplate {
  id: string;
  name: string;
  nameKey?: string;
  description: string;
  descriptionKey?: string;
  category: 'backup' | 'automation' | 'sync' | 'utility';
  icon: string;
  definition: Omit<WorkflowDefinition, 'id' | 'createdAt' | 'updatedAt' | 'showOnTray'>;
}

export type WorkflowLogSeverity = 'info' | 'success' | 'warn' | 'error';

export interface WorkflowLogEntry {
  id: string;
  workflowId: string;
  nodeId?: string;
  nodeTitle?: string;
  timestamp: Date;
  severity: WorkflowLogSeverity;
  message: string;
  details?: unknown;
}

export interface NodePaletteItem {
  type: string;
  category: WorkflowNodeCategory;
  titleKey: string;
  descriptionKey: string;
  icon: string;
  cssClass?: string;
  defaultInputs: WorkflowPort[];
  defaultOutputs: WorkflowPort[];
  defaultConfig: Record<string, unknown>;
  hideOnMobile?: boolean;
}

export interface WorkflowValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}
