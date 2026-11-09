import { OPERATION_REGISTRY, PillTone } from '@app/types';

export interface NodeStyleMeta {
  icon: string;
  tone: PillTone;
  titleKey?: string;
  descriptionKey?: string;
}

interface RawNodeStyleMeta {
  icon: string;
  tone: PillTone;
  titleKey: string;
  descriptionKey: string;
}

const CUSTOM_NODE_META: Record<string, RawNodeStyleMeta> = {
  // Triggers
  manual: {
    icon: 'play',
    tone: 'primary',
    titleKey: 'flow.workflow.nodes.manualTrigger',
    descriptionKey: 'flow.workflow.nodes.manualTriggerDesc',
  },
  app_start: {
    icon: 'bolt',
    tone: 'yellow',
    titleKey: 'flow.workflow.nodes.appStart',
    descriptionKey: 'flow.workflow.nodes.appStartDesc',
  },
  cron: {
    icon: 'clock',
    tone: 'purple',
    titleKey: 'flow.workflow.nodes.cronSchedule',
    descriptionKey: 'flow.workflow.nodes.cronScheduleDesc',
  },
  watcher: {
    icon: 'sync',
    tone: 'orange',
    titleKey: 'flow.workflow.nodes.folderWatcher',
    descriptionKey: 'flow.workflow.nodes.folderWatcherDesc',
  },
  job_event: {
    icon: 'done-all',
    tone: 'accent',
    titleKey: 'flow.workflow.nodes.jobEvent',
    descriptionKey: 'flow.workflow.nodes.jobEventDesc',
  },

  // Tasks
  cleanup: {
    icon: 'broom',
    tone: 'warn',
    titleKey: 'flow.workflow.nodes.cleanup',
    descriptionKey: 'flow.workflow.nodes.cleanupDesc',
  },
  cryptcheck: {
    icon: 'shield',
    tone: 'accent',
    titleKey: 'flow.workflow.nodes.cryptcheck',
    descriptionKey: 'flow.workflow.nodes.cryptcheckDesc',
  },
  exec_script: {
    icon: 'terminal',
    tone: 'purple',
    titleKey: 'flow.workflow.nodes.execScript',
    descriptionKey: 'flow.workflow.nodes.execScriptDesc',
  },
  quick_run: {
    icon: 'quick-run',
    tone: 'orange',
    titleKey: 'flow.workflow.nodes.quickRun',
    descriptionKey: 'flow.workflow.nodes.quickRunDesc',
  },
  rc_command: {
    icon: 'terminal',
    tone: 'accent',
    titleKey: 'flow.workflow.nodes.rcCommand',
    descriptionKey: 'flow.workflow.nodes.rcCommandDesc',
  },

  // Logic
  condition: {
    icon: 'flow',
    tone: 'yellow',
    titleKey: 'flow.workflow.nodes.condition',
    descriptionKey: 'flow.workflow.nodes.conditionDesc',
  },
  delay: {
    icon: 'clock',
    tone: 'purple',
    titleKey: 'flow.workflow.nodes.delay',
    descriptionKey: 'flow.workflow.nodes.delayDesc',
  },
  schedule_wait: {
    icon: 'clock',
    tone: 'purple',
    titleKey: 'flow.workflow.nodes.scheduleWait',
    descriptionKey: 'flow.workflow.nodes.scheduleWaitDesc',
  },
  parallel_fork: {
    icon: 'flow',
    tone: 'yellow',
    titleKey: 'flow.workflow.nodes.parallelFork',
    descriptionKey: 'flow.workflow.nodes.parallelForkDesc',
  },
  join: {
    icon: 'done-all',
    tone: 'accent',
    titleKey: 'flow.workflow.nodes.join',
    descriptionKey: 'flow.workflow.nodes.joinDesc',
  },
  stop: {
    icon: 'stop',
    tone: 'warn',
    titleKey: 'flow.workflow.nodes.stop',
    descriptionKey: 'flow.workflow.nodes.stopDesc',
  },

  // Actions
  notification: {
    icon: 'bell',
    tone: 'primary',
    titleKey: 'flow.workflow.nodes.notification',
    descriptionKey: 'flow.workflow.nodes.notificationDesc',
  },
  unmount: {
    icon: 'eject',
    tone: 'warn',
    titleKey: 'flow.workflow.nodes.unmount',
    descriptionKey: 'flow.workflow.nodes.unmountDesc',
  },
  stop_serve: {
    icon: 'stop',
    tone: 'warn',
    titleKey: 'flow.workflow.nodes.stopServe',
    descriptionKey: 'flow.workflow.nodes.stopServeDesc',
  },
  system_power: {
    icon: 'power-off',
    tone: 'yellow',
    titleKey: 'flow.workflow.nodes.systemPower',
    descriptionKey: 'flow.workflow.nodes.systemPowerDesc',
  },
  log_audit: {
    icon: 'file-lines',
    tone: 'dim',
    titleKey: 'flow.workflow.nodes.logAudit',
    descriptionKey: 'flow.workflow.nodes.logAuditDesc',
  },
};

export function getNodeStyleMeta(type: string): NodeStyleMeta {
  const opDef = OPERATION_REGISTRY.find(op => op.key === type);
  if (opDef) {
    return {
      icon: opDef.icon,
      tone: opDef.tone,
      titleKey: opDef.typeLabel,
      descriptionKey: opDef.settingsDescription,
    };
  }

  const meta = CUSTOM_NODE_META[type];
  if (meta) {
    return {
      icon: meta.icon,
      tone: meta.tone,
      titleKey: meta.titleKey,
      descriptionKey: meta.descriptionKey,
    };
  }

  return {
    icon: 'workflow',
    tone: 'dim',
  };
}

export function getNotificationIcon(kind?: string): string {
  switch (kind) {
    case 'whatsapp':
      return 'whatsapp';
    case 'telegram':
      return 'telegram';
    case 'webhook':
      return 'link';
    case 'email':
      return 'envelope';
    case 'mqtt':
      return 'message';
    case 'script':
      return 'terminal';
    case 'os_toast':
      return 'desktop';
    default:
      return 'bell';
  }
}

const NODES_WITH_DETAILED_CONFIG = new Set<string>([
  'sync',
  'copy',
  'move',
  'bisync',
  'check',
  'delete',
  'copyurl',
  'archivecreate',
  'cryptcheck',
  'mount',
  'serve',
  'cron',
  'schedule_wait',
  'rc_command',
]);

export function hasDetailedConfig(nodeType?: string): boolean {
  return !!nodeType && NODES_WITH_DETAILED_CONFIG.has(nodeType);
}
