/** Detail item structure for repair UI */
export interface RepairDetailItem {
  icon: string;
  labelKey: string;
  valueKey: string;
}

export interface RepairUiItem {
  titleKey: string;
  messageKey: string;
  progressKey: string;
  buttonTextKey: string;
  icon: string;
  details: readonly RepairDetailItem[] | null;
}

export const REPAIR_UI_CONFIG = {
  rclone_binary: {
    titleKey: 'repairSheet.titles.missingRclone',
    messageKey: 'repairSheet.messages.missingRclone',
    progressKey: 'repairSheet.progress.installingRclone',
    buttonTextKey: 'repairSheet.actions.installRclone',
    icon: 'download',
    details: [
      {
        icon: 'circle-info',
        labelKey: 'repairSheet.details.issueLabel',
        valueKey: 'repairSheet.details.rclonePath.issue',
      },
      {
        icon: 'download',
        labelKey: 'repairSheet.details.actionLabel',
        valueKey: 'repairSheet.details.rclonePath.action',
      },
    ],
  },
  rclone_version: {
    titleKey: 'repairSheet.titles.versionTooOld',
    messageKey: 'repairSheet.messages.versionTooOld',
    progressKey: 'repairSheet.progress.installingRclone',
    buttonTextKey: 'repairSheet.actions.installRclone',
    icon: 'download',
    details: [
      {
        icon: 'circle-info',
        labelKey: 'repairSheet.details.issueLabel',
        valueKey: 'repairSheet.details.rcloneVersion.issue',
      },
      {
        icon: 'download',
        labelKey: 'repairSheet.details.actionLabel',
        valueKey: 'repairSheet.details.rcloneVersion.action',
      },
    ],
  },
  mount_plugin: {
    titleKey: 'repairSheet.titles.missingMountPlugin',
    messageKey: 'repairSheet.messages.missingMountPlugin',
    progressKey: 'repairSheet.progress.installingPlugin',
    buttonTextKey: 'repairSheet.actions.installPlugin',
    icon: 'core',
    details: [
      {
        icon: 'circle-info',
        labelKey: 'repairSheet.details.issueLabel',
        valueKey: 'repairSheet.details.mountPlugin.issue',
      },
      {
        icon: 'core',
        labelKey: 'repairSheet.details.actionLabel',
        valueKey: 'repairSheet.details.mountPlugin.action',
      },
    ],
  },
  config_corrupt: {
    titleKey: 'repairSheet.titles.corruptConfig',
    messageKey: 'repairSheet.messages.corruptConfig',
    progressKey: 'repairSheet.progress.restoringBackup',
    buttonTextKey: 'repairSheet.actions.restoreBackup',
    icon: 'rotate-right',
    details: [
      {
        icon: 'circle-info',
        labelKey: 'repairSheet.details.issueLabel',
        valueKey: 'repairSheet.details.configCorrupt.issue',
      },
      {
        icon: 'rotate-right',
        labelKey: 'repairSheet.details.actionLabel',
        valueKey: 'repairSheet.details.configCorrupt.action',
      },
    ],
  },
  backend_unreachable: {
    titleKey: 'repairSheet.titles.backendError',
    messageKey: 'repairSheet.messages.backendError',
    progressKey: 'repairSheet.progress.restartingEngine',
    buttonTextKey: 'repairSheet.actions.restartEngine',
    icon: 'refresh',
    details: [
      {
        icon: 'circle-info',
        labelKey: 'repairSheet.details.issueLabel',
        valueKey: 'repairSheet.details.backendUnreachable.issue',
      },
      {
        icon: 'refresh',
        labelKey: 'repairSheet.details.actionLabel',
        valueKey: 'repairSheet.details.backendUnreachable.action',
      },
    ],
  },
  rclone_password: {
    titleKey: 'repairSheet.titles.passwordRequired',
    messageKey: 'repairSheet.messages.passwordRequired',
    progressKey: 'repairSheet.progress.applyingPassword',
    buttonTextKey: 'repairSheet.actions.submitPassword',
    icon: 'key',
    details: [
      {
        icon: 'circle-info',
        labelKey: 'repairSheet.details.issueLabel',
        valueKey: 'repairSheet.details.rclonePassword.issue',
      },
      {
        icon: 'key',
        labelKey: 'repairSheet.details.actionLabel',
        valueKey: 'repairSheet.details.rclonePassword.action',
      },
    ],
  },
  rclone_auth: {
    titleKey: 'repairSheet.titles.authRequired',
    messageKey: 'repairSheet.messages.authRequired',
    progressKey: 'repairSheet.progress.restartingEngine',
    buttonTextKey: 'repairSheet.actions.restartEngine',
    icon: 'skull',
    details: [
      {
        icon: 'circle-info',
        labelKey: 'repairSheet.details.issueLabel',
        valueKey: 'repairSheet.details.rcloneAuth.issue',
      },
      {
        icon: 'skull',
        labelKey: 'repairSheet.details.actionLabel',
        valueKey: 'repairSheet.details.rcloneAuth.action',
      },
    ],
  },
  rclone_auth_remote: {
    titleKey: 'repairSheet.titles.authRequired',
    messageKey: 'repairSheet.messages.remoteAuthRequired',
    progressKey: 'repairSheet.progress.restartingEngine',
    buttonTextKey: 'repairSheet.actions.configureBackend',
    icon: 'lock',
    details: [
      {
        icon: 'circle-info',
        labelKey: 'repairSheet.details.issueLabel',
        valueKey: 'repairSheet.details.rcloneAuthRemote.issue',
      },
      {
        icon: 'lock',
        labelKey: 'repairSheet.details.actionLabel',
        valueKey: 'repairSheet.details.rcloneAuthRemote.action',
      },
    ],
  },
  rclone_port: {
    titleKey: 'repairSheet.titles.portInUse',
    messageKey: 'repairSheet.messages.portInUse',
    progressKey: 'repairSheet.progress.restartingEngine',
    buttonTextKey: 'repairSheet.actions.changePort',
    icon: 'server',
    details: [
      {
        icon: 'circle-info',
        labelKey: 'repairSheet.details.issueLabel',
        valueKey: 'repairSheet.details.rclonePort.issue',
      },
      {
        icon: 'rotate-right',
        labelKey: 'repairSheet.details.actionLabel',
        valueKey: 'repairSheet.details.rclonePort.action',
      },
    ],
  },
} as const;

export const DEFAULT_REPAIR_UI_CONFIG: RepairUiItem = {
  titleKey: 'repairSheet.titles.systemIssue',
  messageKey: 'repairSheet.messages.defaultParams',
  progressKey: 'repairSheet.progress.repairing',
  buttonTextKey: 'repairSheet.actions.repair',
  icon: 'wrench',
  details: null,
};
