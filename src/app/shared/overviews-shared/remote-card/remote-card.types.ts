import { PrimaryActionType, OpenableFolder, PillTone, OPERATION_TONE } from '@app/types';

export interface StatusIndicatorViewModel {
  op: PrimaryActionType;
  meta: StatusIndicatorMeta;
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
  tone: PillTone;
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
  tone: PillTone;
  tooltip: string;
}

/** Per-operation group of profile picker entries (one group per operation). */
export interface ProfilePickerGroup {
  operation: PrimaryActionType;
  tone: PillTone;
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

export interface StatusIndicatorMeta {
  icon: string;
  tone: PillTone;
  ariaKey: string;
  animateContainer?: boolean;
}

const STATUS_INDICATORS: Record<PrimaryActionType, Omit<StatusIndicatorMeta, 'tone'>> = {
  mount: { icon: 'mount', ariaKey: 'detailShared.status.mounted' },
  sync: { icon: 'refresh', ariaKey: 'detailShared.status.syncing' },
  copy: { icon: 'copy', ariaKey: 'detailShared.status.copying' },
  move: { icon: 'move', ariaKey: 'detailShared.status.moving' },
  bisync: { icon: 'right-left', ariaKey: 'detailShared.status.bisyncing' },
  serve: {
    icon: 'satellite-dish',
    ariaKey: 'detailShared.status.serving',
    animateContainer: true,
  },
  check: { icon: 'search', ariaKey: 'operations.checkActive' },
  cryptcheck: { icon: 'shield', ariaKey: 'operations.cryptcheckActive' },
  delete: { icon: 'trash', ariaKey: 'operations.deleteActive' },
  copyurl: { icon: 'link', ariaKey: 'operations.copyurlActive' },
  archivecreate: { icon: 'compress', ariaKey: 'operations.archivecreateActive' },
};

/** The status pill of each operation; its tone is the operation's own. */
export const STATUS_INDICATOR_META = Object.freeze(
  Object.fromEntries(
    Object.entries(STATUS_INDICATORS).map(([op, meta]) => [
      op,
      { ...meta, tone: OPERATION_TONE[op] },
    ])
  )
) as Readonly<Record<PrimaryActionType, StatusIndicatorMeta>>;
