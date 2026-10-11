import { PrimaryActionType, OpenableFolder } from '@app/types';

export interface StatusIndicatorViewModel {
  op: PrimaryActionType;
  meta: { icon: string; pillClass: string; ariaKey: string; animateContainer?: boolean };
  tooltip: string;
}

export interface ProfilePathViewModel {
  path: string;
  isLocal: boolean;
  tooltip: string;
}

export interface ProfileChipViewModel {
  name: string;
  isBusy: boolean;
  canOpen: boolean;
  isActive: boolean;
  isOpening: boolean;
  chipTooltip: string;
  openPaths: ProfilePathViewModel[];
}

export interface DetailedOperationViewModel {
  key: PrimaryActionType;
  operation: PrimaryActionType;
  cssClass: string;
  labelIcon: string;
  profiles: ProfileChipViewModel[];
}

/** Per-operation profile picker entry used by the compact card's hover blossom. */
export interface ProfilePickerEntry {
  operation: PrimaryActionType;
  profile: string;
  isActive: boolean;
  isBusy: boolean;
  startIcon: string;
  stopIcon: string;
  cssClass: string;
  tooltip: string;
}

/** Per-operation group of profile picker entries (one group per operation). */
export interface ProfilePickerGroup {
  operation: PrimaryActionType;
  cssClass: string;
  /** Single-button trigger tooltip when only one profile exists. */
  triggerTooltip: string;
  /** Icon to show on the trigger button. */
  triggerIcon: string;
  /** Whether the operation is currently active (any profile running). */
  isActive: boolean;
  /** Whether at least one in-flight action targets this operation. */
  isBusy: boolean;
  entries: ProfilePickerEntry[];
}

export interface ActionButtonClickEvent {
  id: string;
  event: Event;
}

export interface ProfilePickerClickEvent {
  operation: PrimaryActionType;
  profile: string;
  event: Event;
}

export interface OpenFolderClickEvent {
  folder: OpenableFolder;
  event: Event;
}

export interface ProfileChipClickEvent {
  operation: PrimaryActionType;
  profile: string;
  event: Event;
}

export interface ProfileOpenInFilesEvent {
  operation: PrimaryActionType;
  profile: string;
  path: string;
  event: Event;
}

export const STATUS_INDICATOR_META: Record<
  PrimaryActionType,
  { icon: string; pillClass: string; ariaKey: string; animateContainer?: boolean }
> = {
  mount: { icon: 'mount', pillClass: 'p-accent', ariaKey: 'detailShared.status.mounted' },
  sync: { icon: 'refresh', pillClass: 'p-primary', ariaKey: 'detailShared.status.syncing' },
  copy: { icon: 'copy', pillClass: 'p-yellow', ariaKey: 'detailShared.status.copying' },
  move: { icon: 'move', pillClass: 'p-orange', ariaKey: 'detailShared.status.moving' },
  bisync: { icon: 'right-left', pillClass: 'p-purple', ariaKey: 'detailShared.status.bisyncing' },
  serve: {
    icon: 'satellite-dish',
    pillClass: 'p-accent',
    ariaKey: 'detailShared.status.serving',
    animateContainer: true,
  },
  check: { icon: 'search', pillClass: 'p-accent', ariaKey: 'operations.checkActive' },
  cryptcheck: { icon: 'shield', pillClass: 'p-accent', ariaKey: 'operations.cryptcheckActive' },
  delete: { icon: 'trash', pillClass: 'p-warn', ariaKey: 'operations.deleteActive' },
  copyurl: { icon: 'link', pillClass: 'p-accent', ariaKey: 'operations.copyurlActive' },
  archivecreate: {
    icon: 'compress',
    pillClass: 'p-primary',
    ariaKey: 'operations.archivecreateActive',
  },
};
