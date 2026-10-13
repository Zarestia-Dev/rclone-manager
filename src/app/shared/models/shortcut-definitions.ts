export interface ShortcutDefinition {
  keys: string;
  descriptionKey: string;
  categoryKey: string;
  actionId: string;
}

export type ShortcutContext = 'main' | 'nautilus' | 'flow';

export const MAIN_SHORTCUTS: ShortcutDefinition[] = [
  {
    actionId: 'app.quit',
    keys: 'Ctrl + Q',
    descriptionKey: 'shortcuts.actions.quit',
    categoryKey: 'shortcuts.categories.global',
  },
  {
    actionId: 'app.showShortcuts',
    keys: 'Ctrl + ?',
    descriptionKey: 'shortcuts.actions.showShortcuts',
    categoryKey: 'shortcuts.categories.application',
  },
  {
    actionId: 'app.openPreferences',
    keys: 'Ctrl + ,',
    descriptionKey: 'shortcuts.actions.openPreferences',
    categoryKey: 'shortcuts.categories.application',
  },
  {
    actionId: 'app.openFlags',
    keys: 'Ctrl + .',
    descriptionKey: 'shortcuts.actions.openFlags',
    categoryKey: 'shortcuts.categories.application',
  },
  {
    actionId: 'app.openAlerts',
    keys: 'Ctrl + Alt + A',
    descriptionKey: 'alerts.title',
    categoryKey: 'shortcuts.categories.application',
  },
  {
    actionId: 'app.forceRefreshMountedRemotes',
    keys: 'Ctrl + Shift + M',
    descriptionKey: 'shortcuts.actions.forceCheck',
    categoryKey: 'shortcuts.categories.remoteManagement',
  },
  {
    actionId: 'app.forceRefreshServes',
    keys: 'Ctrl + Shift + S',
    descriptionKey: 'shortcuts.actions.forceCheckServes',
    categoryKey: 'shortcuts.categories.remoteManagement',
  },
  {
    actionId: 'app.createNewRemoteDetailed',
    keys: 'Ctrl + N',
    descriptionKey: 'shortcuts.actions.newRemoteDetailed',
    categoryKey: 'shortcuts.categories.remoteManagement',
  },
  {
    actionId: 'app.createNewRemoteQuick',
    keys: 'Ctrl + R',
    descriptionKey: 'shortcuts.actions.newRemoteQuick',
    categoryKey: 'shortcuts.categories.remoteManagement',
  },
  {
    actionId: 'app.loadConfiguration',
    keys: 'Ctrl + I',
    descriptionKey: 'shortcuts.actions.loadConfig',
    categoryKey: 'shortcuts.categories.fileOperations',
  },
  {
    actionId: 'app.exportConfiguration',
    keys: 'Ctrl + E',
    descriptionKey: 'shortcuts.actions.exportConfig',
    categoryKey: 'shortcuts.categories.fileOperations',
  },
  {
    actionId: 'app.toggleFileBrowser',
    keys: 'Ctrl + B',
    descriptionKey: 'shortcuts.actions.toggleBrowser',
    categoryKey: 'shortcuts.categories.fileBrowser',
  },
  {
    actionId: 'app.toggleFlowOverlay',
    keys: 'Ctrl + Alt + F',
    descriptionKey: 'shortcuts.actions.openFlowOverlay',
    categoryKey: 'shortcuts.categories.application',
  },
  {
    actionId: 'app.closeDialog',
    keys: 'Escape',
    descriptionKey: 'shortcuts.actions.closeDialog',
    categoryKey: 'shortcuts.categories.navigation',
  },
];

export const NAUTILUS_SHORTCUTS: ShortcutDefinition[] = [
  {
    actionId: 'nautilus.copy',
    keys: 'Ctrl + C',
    descriptionKey: 'nautilus.contextMenu.copy',
    categoryKey: 'shortcuts.categories.fileBrowserNautilus',
  },
  {
    actionId: 'nautilus.cut',
    keys: 'Ctrl + X',
    descriptionKey: 'nautilus.contextMenu.cut',
    categoryKey: 'shortcuts.categories.fileBrowserNautilus',
  },
  {
    actionId: 'nautilus.paste',
    keys: 'Ctrl + V',
    descriptionKey: 'nautilus.contextMenu.paste',
    categoryKey: 'shortcuts.categories.fileBrowserNautilus',
  },
  {
    actionId: 'nautilus.delete',
    keys: 'Delete',
    descriptionKey: 'nautilus.contextMenu.delete',
    categoryKey: 'shortcuts.categories.fileBrowserNautilus',
  },
  {
    actionId: 'nautilus.selectAll',
    keys: 'Ctrl + A',
    descriptionKey: 'nautilus.contextMenu.selectAll',
    categoryKey: 'shortcuts.categories.fileBrowserNautilus',
  },
  {
    actionId: 'nautilus.refresh',
    keys: 'F5 / Ctrl + R',
    descriptionKey: 'nautilus.contextMenu.refresh',
    categoryKey: 'shortcuts.categories.fileBrowserNautilus',
  },
  {
    actionId: 'nautilus.newFolder',
    keys: 'Ctrl + Shift + N',
    descriptionKey: 'nautilus.contextMenu.newFolder',
    categoryKey: 'shortcuts.categories.fileBrowserNautilus',
  },
  {
    actionId: 'nautilus.search',
    keys: 'Ctrl + F',
    descriptionKey: 'nautilus.contextMenu.search',
    categoryKey: 'shortcuts.categories.fileBrowserNautilus',
  },
  {
    actionId: 'nautilus.showHidden',
    keys: 'Ctrl + H',
    descriptionKey: 'nautilus.view.showHidden',
    categoryKey: 'shortcuts.categories.fileBrowserNautilus',
  },
  {
    actionId: 'nautilus.properties',
    keys: 'Alt + Enter',
    descriptionKey: 'nautilus.contextMenu.properties',
    categoryKey: 'shortcuts.categories.fileBrowserNautilus',
  },
  {
    actionId: 'nautilus.goUp',
    keys: 'Backspace / Alt + Up',
    descriptionKey: 'nautilus.contextMenu.goUp',
    categoryKey: 'shortcuts.categories.fileBrowserNautilus',
  },
  {
    actionId: 'nautilus.goBack',
    keys: 'Alt + Left',
    descriptionKey: 'nautilus.contextMenu.goBack',
    categoryKey: 'shortcuts.categories.fileBrowserNautilus',
  },
  {
    actionId: 'nautilus.goForward',
    keys: 'Alt + Right',
    descriptionKey: 'nautilus.contextMenu.goForward',
    categoryKey: 'shortcuts.categories.fileBrowserNautilus',
  },
  {
    actionId: 'nautilus.open',
    keys: 'Enter',
    descriptionKey: 'nautilus.contextMenu.open',
    categoryKey: 'shortcuts.categories.fileBrowserNautilus',
  },
  {
    actionId: 'nautilus.focusPath',
    keys: 'Ctrl + L',
    descriptionKey: 'nautilus.contextMenu.focusPath',
    categoryKey: 'shortcuts.categories.fileBrowserNautilus',
  },
  {
    actionId: 'nautilus.newTab',
    keys: 'Ctrl + T',
    descriptionKey: 'nautilus.contextMenu.newTab',
    categoryKey: 'shortcuts.categories.fileBrowserNautilus',
  },
  {
    actionId: 'nautilus.nextTab',
    keys: 'Ctrl + Tab',
    descriptionKey: 'nautilus.contextMenu.nextTab',
    categoryKey: 'shortcuts.categories.fileBrowserNautilus',
  },
  {
    actionId: 'nautilus.previousTab',
    keys: 'Ctrl + Shift + Tab',
    descriptionKey: 'nautilus.contextMenu.previousTab',
    categoryKey: 'shortcuts.categories.fileBrowserNautilus',
  },
  {
    actionId: 'nautilus.duplicateTab',
    keys: 'Ctrl + Shift + T',
    descriptionKey: 'nautilus.contextMenu.duplicateTab',
    categoryKey: 'shortcuts.categories.fileBrowserNautilus',
  },
  {
    actionId: 'nautilus.closeTab',
    keys: 'Ctrl + W',
    descriptionKey: 'nautilus.contextMenu.closeTab',
    categoryKey: 'shortcuts.categories.fileBrowserNautilus',
  },
  {
    actionId: 'nautilus.toggleSplit',
    keys: 'Ctrl + /',
    descriptionKey: 'nautilus.contextMenu.toggleSplit',
    categoryKey: 'shortcuts.categories.fileBrowserNautilus',
  },
  {
    actionId: 'nautilus.switchPane',
    keys: 'Ctrl + I',
    descriptionKey: 'nautilus.contextMenu.switchPane',
    categoryKey: 'shortcuts.categories.fileBrowserNautilus',
  },
  {
    actionId: 'nautilus.closeDialog',
    keys: 'Escape',
    descriptionKey: 'shortcuts.actions.closeDialog',
    categoryKey: 'shortcuts.categories.fileBrowserNautilus',
  },
];

export const FLOW_SHORTCUTS: ShortcutDefinition[] = [
  {
    actionId: 'flow.save',
    keys: 'Ctrl + S',
    descriptionKey: 'shortcuts.actions.saveWorkflow',
    categoryKey: 'shortcuts.categories.flowWorkspace',
  },
  {
    actionId: 'flow.deleteSelected',
    keys: 'Delete / Backspace',
    descriptionKey: 'shortcuts.actions.deleteSelected',
    categoryKey: 'shortcuts.categories.flowWorkspace',
  },
  {
    actionId: 'flow.closeDialog',
    keys: 'Escape',
    descriptionKey: 'shortcuts.actions.closeDialog',
    categoryKey: 'shortcuts.categories.flowWorkspace',
  },
];

export function getShortcutsForContext(context: ShortcutContext = 'main'): ShortcutDefinition[] {
  switch (context) {
    case 'nautilus':
      return NAUTILUS_SHORTCUTS;
    case 'flow':
      return FLOW_SHORTCUTS;
    case 'main':
    default:
      return MAIN_SHORTCUTS;
  }
}
