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

function singleOutput(labelKey: string, name = 'Out'): WorkflowPort[] {
  return [{ id: 'out', name, type: 'out', labelKey }];
}

export const SINGLE_START_OUTPUT = singleOutput('flow.workflow.ports.start', 'Trigger');
export const SINGLE_TRIGGER_OUTPUT = singleOutput('flow.workflow.ports.trigger', 'Trigger');
export const SINGLE_CHANGE_OUTPUT = singleOutput('flow.workflow.ports.onChange', 'Trigger');
export const SINGLE_FINISH_OUTPUT = singleOutput('flow.workflow.ports.onFinish', 'Trigger');
export const SINGLE_DONE_OUTPUT = singleOutput('flow.workflow.ports.done');
export const SINGLE_AFTER_DELAY_OUTPUT = singleOutput('flow.workflow.ports.afterDelay');

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
  defaultInputs: WorkflowPort[],
  defaultOutputs: WorkflowPort[],
  defaultConfig: Record<string, unknown>,
  hideOnMobile?: boolean
): NodePaletteItem {
  const meta = getNodeStyleMeta(type);
  return {
    type,
    category,
    titleKey: meta.titleKey ?? type,
    descriptionKey: meta.descriptionKey ?? '',
    icon: meta.icon,
    cssClass: meta.cssClass,
    defaultInputs,
    defaultOutputs,
    defaultConfig,
    hideOnMobile,
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
      titleKey: meta.titleKey ?? op.typeLabel ?? op.key,
      descriptionKey: meta.descriptionKey ?? op.settingsDescription ?? '',
      icon: meta.icon,
      cssClass: meta.cssClass,
      defaultInputs: STANDARD_TASK_INPUTS,
      defaultOutputs: STANDARD_TASK_OUTPUTS,
      defaultConfig: getOperationDefaultConfig(op.key),
    };
  });

export const PALETTE_ITEMS: NodePaletteItem[] = [
  // ── Triggers ─────────────────────────────────────────────────────────────
  createPaletteItem('manual', 'trigger', [], SINGLE_START_OUTPUT, {}),
  createPaletteItem('app_start', 'trigger', [], SINGLE_START_OUTPUT, { delaySeconds: 0 }),
  createPaletteItem('cron', 'trigger', [], SINGLE_TRIGGER_OUTPUT, { cronExpression: '0 2 * * *' }),
  createPaletteItem('watcher', 'trigger', [], SINGLE_CHANGE_OUTPUT, {
    watchPaths: [],
    debounceSeconds: 5,
    globPattern: '',
    recursive: false,
  }),
  createPaletteItem('job_event', 'trigger', [], SINGLE_FINISH_OUTPUT, {
    targetProfileId: '',
    eventState: 'any',
  }),

  // ── Tasks / Operations (From OPERATION_REGISTRY) ─────────────────────────
  ...OPERATION_PALETTE_ITEMS,

  // ── Extra Tasks ──────────────────────────────────────────────────────────
  createPaletteItem('cleanup', 'task', STANDARD_TASK_INPUTS, STANDARD_TASK_OUTPUTS, {
    remote: '',
    path: '',
  }),
  createPaletteItem('exec_script', 'task', STANDARD_TASK_INPUTS, STANDARD_TASK_OUTPUTS, {
    command: '',
    args: '',
    failOnError: true,
  }),
  createPaletteItem('quick_run', 'task', STANDARD_TASK_INPUTS, STANDARD_TASK_OUTPUTS, {
    quickRunId: '',
  }),
  createPaletteItem('rc_command', 'task', STANDARD_TASK_INPUTS, STANDARD_TASK_OUTPUTS, {
    command: 'core/version',
    params: {},
  }),

  // ── Logic & Flow Control ─────────────────────────────────────────────────
  createPaletteItem('condition', 'logic', STANDARD_TASK_INPUTS, BOOLEAN_BRANCH_OUTPUTS, {
    operator: 'equals',
    leftValue: '',
    rightValue: '',
  }),
  createPaletteItem('delay', 'logic', STANDARD_TASK_INPUTS, SINGLE_AFTER_DELAY_OUTPUT, {
    delaySeconds: 5,
  }),
  createPaletteItem('parallel_fork', 'logic', STANDARD_TASK_INPUTS, FORK_BRANCH_OUTPUTS, {}),
  createPaletteItem('join', 'logic', JOIN_BRANCH_INPUTS, SINGLE_DONE_OUTPUT, {
    joinMode: 'all_success',
  }),
  createPaletteItem('stop', 'logic', STANDARD_TASK_INPUTS, [], {
    status: 'success',
    message: 'Workflow stopped',
  }),

  // ── Actions & Output ─────────────────────────────────────────────────────
  createPaletteItem('notification', 'action', STANDARD_TASK_INPUTS, SINGLE_DONE_OUTPUT, {
    title: 'Notification',
    message: 'Workflow step completed',
    severity: 'info',
  }),
  createPaletteItem('unmount', 'action', STANDARD_TASK_INPUTS, SINGLE_DONE_OUTPUT, {
    targetMode: 'node',
    targetNodeId: '',
    mountPoint: '',
  }),
  createPaletteItem('stop_serve', 'action', STANDARD_TASK_INPUTS, SINGLE_DONE_OUTPUT, {
    targetMode: 'node',
    targetNodeId: '',
    serverId: '',
  }),
  createPaletteItem(
    'system_power',
    'action',
    STANDARD_TASK_INPUTS,
    SINGLE_DONE_OUTPUT,
    { action: 'sleep' },
    true
  ),
  createPaletteItem('log_audit', 'action', STANDARD_TASK_INPUTS, SINGLE_DONE_OUTPUT, {
    message: '',
    severity: 'info',
  }),
];
