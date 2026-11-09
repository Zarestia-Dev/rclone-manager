import {
  ALL_PRIMARY_ACTIONS,
  OPERATION_ICONS,
  OPERATION_TONE,
  PillTone,
  PrimaryActionType,
} from '@app/types';

export interface StatusIndicatorViewModel {
  op: PrimaryActionType;
  meta: StatusIndicatorMeta;
  /** Comma-separated names of the profiles running this operation. */
  profiles: string;
}

export interface ProfilePathViewModel {
  path: string;
  icon: string;
}

export interface ProfileChipViewModel {
  name: string;
  isBusy: boolean;
  isActive: boolean;
  isOpening: boolean;
  /** i18n key of the chip tooltip (start or stop); the profile name follows in brackets. */
  tooltipKey: string;
  openPaths: ProfilePathViewModel[];
}

export interface DetailedOperationViewModel {
  operation: PrimaryActionType;
  tone: PillTone;
  labelIcon: string;
  profiles: ProfileChipViewModel[];
}

/** Per-operation profile picker entry used by the compact card's profile menu. */
export interface ProfilePickerEntry {
  operation: PrimaryActionType;
  profile: string;
  isActive: boolean;
  isBusy: boolean;
  startIcon: string;
  stopIcon: string;
  tone: PillTone;
}

/** A profile menu: one per operation that has several profiles. */
export interface ProfilePickerGroup {
  operation: PrimaryActionType;
  tone: PillTone;
  /** i18n key of the menu button tooltip. */
  triggerTooltipKey: string;
  /** Icon to show on the trigger button. */
  triggerIcon: string;
  /** Whether the operation is currently active (any profile running). */
  isActive: boolean;
  /** Whether at least one in-flight action targets this operation. */
  isBusy: boolean;
  entries: ProfilePickerEntry[];
}

export interface ProfileTarget {
  operation: PrimaryActionType;
  profile: string;
}

export interface ProfilePathTarget extends ProfileTarget {
  path: string;
}

export interface StatusIndicatorMeta {
  icon: string;
  tone: PillTone;
  ariaKey: string;
  animateContainer?: boolean;
}

const STATUS_ARIA_KEYS: Record<PrimaryActionType, string> = {
  mount: 'detailShared.status.mounted',
  sync: 'detailShared.status.syncing',
  copy: 'detailShared.status.copying',
  move: 'detailShared.status.moving',
  bisync: 'detailShared.status.bisyncing',
  serve: 'detailShared.status.serving',
  check: 'operations.checkActive',
  cryptcheck: 'operations.cryptcheckActive',
  delete: 'operations.deleteActive',
  copyurl: 'operations.copyurlActive',
  archivecreate: 'operations.archivecreateActive',
};

/** Where the status pill differs from the operation itself: serving shows a spinning dish. */
const STATUS_OVERRIDES: Partial<Record<PrimaryActionType, Partial<StatusIndicatorMeta>>> = {
  serve: { icon: 'satellite-dish', animateContainer: true },
};

/** The status pill of each operation: its icon and tone are the operation's own. */
export const STATUS_INDICATOR_META = Object.freeze(
  Object.fromEntries(
    ALL_PRIMARY_ACTIONS.map(op => [
      op,
      {
        icon: OPERATION_ICONS[op],
        tone: OPERATION_TONE[op],
        ariaKey: STATUS_ARIA_KEYS[op],
        ...STATUS_OVERRIDES[op],
      },
    ])
  )
) as Readonly<Record<PrimaryActionType, StatusIndicatorMeta>>;
