export type WorkflowNodeCategory = 'trigger' | 'task' | 'logic' | 'action';

export type WorkflowPortType = 'in' | 'out' | 'success' | 'failure' | 'true' | 'false';

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
  subtitle?: string;
  icon?: string;
  x: number;
  y: number;
  inputs: WorkflowPort[];
  outputs: WorkflowPort[];
  config: Record<string, unknown>;
  state?: WorkflowNodeExecutionState;
  errorMessage?: string;
  lastDurationMs?: number;
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
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  viewport: CanvasViewport;
  autoStart?: boolean;
  cronExpression?: string;
  createdAt?: string;
  updatedAt?: string;
  lastExecutedAt?: string;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  category: 'backup' | 'automation' | 'sync' | 'utility';
  icon: string;
  definition: Omit<WorkflowDefinition, 'id' | 'createdAt' | 'updatedAt'>;
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
  title: string;
  titleKey?: string;
  description: string;
  descriptionKey?: string;
  icon: string;
  cssClass?: string;
  defaultInputs: WorkflowPort[];
  defaultOutputs: WorkflowPort[];
  defaultConfig: Record<string, unknown>;
}

export interface WorkflowValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export type WorkflowNotificationMode = 'action_ref' | 'inline';

export interface WorkflowNotificationConfig {
  mode?: WorkflowNotificationMode;
  actionId?: string;
  overrideTemplate?: boolean;
  title?: string;
  message?: string;
  severity?: 'info' | 'warning' | 'average' | 'high' | 'critical';
  actionKind?: 'whatsapp' | 'telegram' | 'webhook' | 'email' | 'mqtt' | 'script' | 'os_toast';
  // WhatsApp
  phone?: string;
  apikey?: string;
  whatsapp_provider?: 'callmebot' | 'custom_gateway';
  gateway_url?: string;
  // Telegram
  telegram_mode?: 'bot' | 'botless';
  bot_token?: string;
  chat_id?: string;
  // Webhook
  url?: string;
  method?: string;
  headers?: { key: string; value: string }[];
  body_template?: string;
  tls_verify?: boolean;
  // Email
  smtp_server?: string;
  smtp_port?: number;
  username?: string;
  password?: string;
  from?: string;
  to?: string;
  subject_template?: string;
  encryption?: 'none' | 'tls' | 'starttls';
  // MQTT
  host?: string;
  port?: number;
  use_tls?: boolean;
  topic?: string;
  qos?: number;
  retain?: boolean;
  // Script
  command?: string;
  argsRaw?: string;
  // Options
  timeout_secs?: number;
  retry_count?: number;
}

export interface AppStartConfig {
  delaySeconds?: number;
}

export interface JobEventConfig {
  targetProfileId?: string;
  eventState?: 'any' | 'success' | 'failed';
  minDuration?: number;
}

export interface WatcherConfig {
  watchPaths?: string[];
  debounceSeconds?: number;
  globPattern?: string;
  recursive?: boolean;
  eventTypes?: string[];
}

export interface CleanupConfig {
  remote?: string;
  path?: string;
}

export interface CryptCheckConfig {
  remote?: string;
  srcFs?: string;
  dstFs?: string;
}

export interface ExecScriptConfig {
  command?: string;
  args?: string;
  workingDir?: string;
  timeoutSeconds?: number;
  failOnError?: boolean;
}

export interface QuickRunNodeConfig {
  quickRunId?: string;
}

export interface StopNodeConfig {
  status?: 'success' | 'failed';
  message?: string;
}

export interface SystemPowerConfig {
  action?: 'sleep' | 'shutdown' | 'hibernate' | 'lock';
}

export interface LogAuditConfig {
  message?: string;
  severity?: 'info' | 'warn' | 'error';
}

export interface UnmountConfig {
  targetMode?: 'node' | 'custom';
  targetNodeId?: string;
  mountPoint?: string;
}

export interface StopServeConfig {
  targetMode?: 'node' | 'custom';
  targetNodeId?: string;
  serverId?: string;
}
