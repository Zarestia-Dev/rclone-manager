import { OPERATION_REGISTRY, OperationDefinition } from '@app/types';
import { NodePaletteItem, WorkflowNodeCategory, WorkflowPort } from '../types/workflow.types';
import { getNodeStyleMeta } from '../utils/node-style.util';

// ── Standard Port Templates (Deduplicated) ──────────────────────────────────

export const STANDARD_IN_PORT: WorkflowPort = {
  id: 'in',
  name: 'In',
  type: 'in',
  label: 'In',
  labelKey: 'flow.workflow.ports.in',
};

export const STANDARD_TASK_INPUTS: WorkflowPort[] = [STANDARD_IN_PORT];

export const STANDARD_TASK_OUTPUTS: WorkflowPort[] = [
  {
    id: 'success',
    name: 'Success',
    type: 'success',
    label: 'Success',
    labelKey: 'flow.workflow.ports.success',
  },
  {
    id: 'failure',
    name: 'Failure',
    type: 'failure',
    label: 'Failure',
    labelKey: 'flow.workflow.ports.failure',
  },
];

export const SINGLE_START_OUTPUT: WorkflowPort[] = [
  {
    id: 'out',
    name: 'Trigger',
    type: 'out',
    label: 'Start',
    labelKey: 'flow.workflow.ports.start',
  },
];

export const SINGLE_TRIGGER_OUTPUT: WorkflowPort[] = [
  {
    id: 'out',
    name: 'Trigger',
    type: 'out',
    label: 'Trigger',
    labelKey: 'flow.workflow.ports.trigger',
  },
];

export const SINGLE_CHANGE_OUTPUT: WorkflowPort[] = [
  {
    id: 'out',
    name: 'Trigger',
    type: 'out',
    label: 'On Change',
    labelKey: 'flow.workflow.ports.onChange',
  },
];

export const SINGLE_FINISH_OUTPUT: WorkflowPort[] = [
  {
    id: 'out',
    name: 'Trigger',
    type: 'out',
    label: 'On Finish',
    labelKey: 'flow.workflow.ports.onFinish',
  },
];

export const SINGLE_DONE_OUTPUT: WorkflowPort[] = [
  {
    id: 'out',
    name: 'Out',
    type: 'out',
    label: 'Done',
    labelKey: 'flow.workflow.ports.done',
  },
];

export const SINGLE_AFTER_DELAY_OUTPUT: WorkflowPort[] = [
  {
    id: 'out',
    name: 'Out',
    type: 'out',
    label: 'After Delay',
    labelKey: 'flow.workflow.ports.afterDelay',
  },
];

export const BOOLEAN_BRANCH_OUTPUTS: WorkflowPort[] = [
  {
    id: 'true',
    name: 'True',
    type: 'true',
    label: 'True',
    labelKey: 'flow.workflow.ports.true',
  },
  {
    id: 'false',
    name: 'False',
    type: 'false',
    label: 'False',
    labelKey: 'flow.workflow.ports.false',
  },
];

export const FORK_BRANCH_OUTPUTS: WorkflowPort[] = [
  {
    id: 'branch1',
    name: 'Branch 1',
    type: 'out',
    label: 'Branch 1',
    labelKey: 'flow.workflow.ports.branch1',
  },
  {
    id: 'branch2',
    name: 'Branch 2',
    type: 'out',
    label: 'Branch 2',
    labelKey: 'flow.workflow.ports.branch2',
  },
];

export const JOIN_BRANCH_INPUTS: WorkflowPort[] = [
  { id: 'in1', name: 'In 1', type: 'in', label: 'In 1', labelKey: 'flow.workflow.ports.in1' },
  { id: 'in2', name: 'In 2', type: 'in', label: 'In 2', labelKey: 'flow.workflow.ports.in2' },
];

// ── Default Config Helpers ──────────────────────────────────────────────────

export function getOperationDefaultConfig(opKey: string): Record<string, unknown> {
  const defaultRclone: Record<string, unknown> = {};
  if (opKey === 'bisync') {
    defaultRclone['path1'] = '';
    defaultRclone['path2'] = '';
  } else if (opKey === 'mount') {
    defaultRclone['fs'] = '';
    defaultRclone['mountPoint'] = '';
  } else if (opKey === 'serve') {
    defaultRclone['fs'] = '';
  } else if (opKey === 'delete') {
    defaultRclone['srcFs'] = '';
  } else if (opKey === 'copyurl') {
    defaultRclone['url'] = '';
    defaultRclone['dstFs'] = '';
    defaultRclone['autoFilename'] = true;
  } else if (opKey === 'archivecreate') {
    defaultRclone['srcFs'] = '';
    defaultRclone['dstFs'] = '';
    defaultRclone['format'] = 'zip';
    defaultRclone['prefix'] = '';
  } else {
    defaultRclone['srcFs'] = '';
    defaultRclone['dstFs'] = '';
  }

  return {
    remoteName: '',
    config: {
      app: {
        autoStart: false,
        showOnTray: true,
        cronEnabled: false,
        cronExpression: null,
        watchEnabled: false,
        watchDelay: 5,
        watchChangedOnly: false,
      },
      rclone: defaultRclone,
    },
  };
}

export function createPaletteItem(
  type: string,
  category: WorkflowNodeCategory,
  title: string,
  description: string,
  defaultInputs: WorkflowPort[],
  defaultOutputs: WorkflowPort[],
  defaultConfig: Record<string, unknown>
): NodePaletteItem {
  const meta = getNodeStyleMeta(type);
  return {
    type,
    category,
    title,
    titleKey: meta.titleKey,
    description,
    descriptionKey: meta.descriptionKey,
    icon: meta.icon,
    cssClass: meta.cssClass,
    defaultInputs,
    defaultOutputs,
    defaultConfig,
  };
}

const OPERATION_PALETTE_ITEMS: NodePaletteItem[] = (
  OPERATION_REGISTRY as readonly OperationDefinition[]
)
  .filter(op => op.isPrimary)
  .map(op => {
    const meta = getNodeStyleMeta(op.key);
    return {
      type: op.key,
      category: 'task' as WorkflowNodeCategory,
      title: op.apiLabel || op.key,
      titleKey: meta.titleKey || op.typeLabel,
      description: op.settingsDescription ?? '',
      descriptionKey: meta.descriptionKey || op.settingsDescription,
      icon: meta.icon,
      cssClass: meta.cssClass,
      defaultInputs: STANDARD_TASK_INPUTS,
      defaultOutputs: STANDARD_TASK_OUTPUTS,
      defaultConfig: getOperationDefaultConfig(op.key),
    };
  });

export const PALETTE_ITEMS: NodePaletteItem[] = [
  // ── Triggers ─────────────────────────────────────────────────────────────
  createPaletteItem(
    'manual',
    'trigger',
    'Manual Trigger',
    'Start workflow manually on demand',
    [],
    SINGLE_START_OUTPUT,
    {}
  ),
  createPaletteItem(
    'app_start',
    'trigger',
    'On App Launch',
    'Trigger automatically when Rclone Manager starts',
    [],
    SINGLE_START_OUTPUT,
    { delaySeconds: 0 }
  ),
  createPaletteItem(
    'cron',
    'trigger',
    'Cron Schedule',
    'Trigger on a recurring cron timetable',
    [],
    SINGLE_TRIGGER_OUTPUT,
    { cronExpression: '0 2 * * *' }
  ),
  createPaletteItem(
    'watcher',
    'trigger',
    'Folder Watcher',
    'Trigger when files in local directory change',
    [],
    SINGLE_CHANGE_OUTPUT,
    { watchPaths: [], debounceSeconds: 5, globPattern: '', recursive: false }
  ),
  createPaletteItem(
    'job_event',
    'trigger',
    'Job Finish Event',
    'Trigger when another profile or quick run finishes',
    [],
    SINGLE_FINISH_OUTPUT,
    { targetProfileId: '', eventState: 'any' }
  ),

  // ── Tasks / Operations (From OPERATION_REGISTRY) ─────────────────────────
  ...OPERATION_PALETTE_ITEMS,

  // ── Extra Tasks ──────────────────────────────────────────────────────────
  createPaletteItem(
    'cleanup',
    'task',
    'Cleanup Trash',
    'Empty remote trash or recycle bin',
    STANDARD_TASK_INPUTS,
    STANDARD_TASK_OUTPUTS,
    { remote: '', path: '' }
  ),
  createPaletteItem(
    'exec_script',
    'task',
    'Execute Script',
    'Run local shell command or script',
    STANDARD_TASK_INPUTS,
    STANDARD_TASK_OUTPUTS,
    { command: '', args: '', failOnError: true }
  ),
  createPaletteItem(
    'quick_run',
    'task',
    'Quick Run',
    'Execute a saved Quick Run profile',
    STANDARD_TASK_INPUTS,
    STANDARD_TASK_OUTPUTS,
    { quickRunId: '' }
  ),
  createPaletteItem(
    'rc_command',
    'task',
    'Rclone RC Command',
    'Invoke arbitrary RC API endpoint',
    STANDARD_TASK_INPUTS,
    STANDARD_TASK_OUTPUTS,
    { command: 'core/version', params: {} }
  ),

  // ── Logic & Flow Control ─────────────────────────────────────────────────
  createPaletteItem(
    'condition',
    'logic',
    'Condition Branch',
    'Branch flow based on condition test',
    STANDARD_TASK_INPUTS,
    BOOLEAN_BRANCH_OUTPUTS,
    { operator: 'equals', leftValue: '', rightValue: '' }
  ),
  createPaletteItem(
    'delay',
    'logic',
    'Delay Timer',
    'Pause execution for specified duration',
    STANDARD_TASK_INPUTS,
    SINGLE_AFTER_DELAY_OUTPUT,
    { seconds: 5 }
  ),
  createPaletteItem(
    'parallel_fork',
    'logic',
    'Parallel Split',
    'Execute multiple downstream branches concurrently',
    STANDARD_TASK_INPUTS,
    FORK_BRANCH_OUTPUTS,
    {}
  ),
  createPaletteItem(
    'join',
    'logic',
    'Join Branches',
    'Wait for all parallel branches to finish',
    JOIN_BRANCH_INPUTS,
    SINGLE_DONE_OUTPUT,
    { joinMode: 'all_success' }
  ),
  createPaletteItem(
    'stop',
    'logic',
    'Stop Workflow',
    'Halt workflow execution',
    STANDARD_TASK_INPUTS,
    [],
    { status: 'success', message: 'Workflow stopped' }
  ),

  // ── Actions & Output ─────────────────────────────────────────────────────
  createPaletteItem(
    'notification',
    'action',
    'Send Notification',
    'Send notification via WhatsApp, Telegram, Webhook, Email, MQTT, or Desktop',
    STANDARD_TASK_INPUTS,
    SINGLE_DONE_OUTPUT,
    { title: 'Notification', message: 'Workflow step completed', severity: 'info' }
  ),
  createPaletteItem(
    'unmount',
    'action',
    'Unmount Remote',
    'Safely unmount active local filesystem',
    STANDARD_TASK_INPUTS,
    SINGLE_DONE_OUTPUT,
    { targetMode: 'node', targetNodeId: '', mountPoint: '' }
  ),
  createPaletteItem(
    'stop_serve',
    'action',
    'Stop Serve',
    'Stop active network serve instances for a remote',
    STANDARD_TASK_INPUTS,
    SINGLE_DONE_OUTPUT,
    { targetMode: 'node', targetNodeId: '', serverId: '' }
  ),
  createPaletteItem(
    'system_power',
    'action',
    'System Power',
    'Sleep, lock or shutdown host system',
    STANDARD_TASK_INPUTS,
    SINGLE_DONE_OUTPUT,
    { action: 'sleep' }
  ),
  createPaletteItem(
    'log_audit',
    'action',
    'Audit Log',
    'Write entry to workflow execution log',
    STANDARD_TASK_INPUTS,
    SINGLE_DONE_OUTPUT,
    { message: '', severity: 'info' }
  ),
];
