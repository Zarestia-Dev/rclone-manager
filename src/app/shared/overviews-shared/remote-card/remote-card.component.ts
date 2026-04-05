import { NgClass, TitleCasePipe } from '@angular/common';
import { Component, computed, input, inject, output } from '@angular/core';
import { TranslateService, TranslateModule } from '@ngx-translate/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { QuickActionButtonsComponent } from '../../../shared/components';
import {
  ActionState,
  AppTab,
  PrimaryActionType,
  QuickActionButton,
  Remote,
  RemoteStatus,
  RemoteOperationState,
  RemoteServeState,
  RemoteAction,
  RemoteCardVariant,
  CardDisplayMode,
} from '@app/types';
import { IconService, isLocalPath } from '@app/services';

interface OpenInFilesEvent {
  remoteName: string;
  path?: string;
}

interface OperationMeta {
  startIcon: string;
  stopIcon: string;
  startTooltip: string;
  stopTooltip: string;
  cssClass: string;
}

const OPERATION_META: Record<PrimaryActionType, OperationMeta> = {
  mount: {
    startIcon: 'mount',
    stopIcon: 'eject',
    startTooltip: 'overviews.remoteCard.actions.mount',
    stopTooltip: 'overviews.remoteCard.actions.unmount',
    cssClass: 'accent',
  },
  sync: {
    startIcon: 'refresh',
    stopIcon: 'stop',
    startTooltip: 'overviews.remoteCard.actions.startSync',
    stopTooltip: 'overviews.remoteCard.actions.stopSync',
    cssClass: 'primary',
  },
  copy: {
    startIcon: 'copy',
    stopIcon: 'stop',
    startTooltip: 'overviews.remoteCard.actions.startCopy',
    stopTooltip: 'overviews.remoteCard.actions.stopCopy',
    cssClass: 'yellow',
  },
  move: {
    startIcon: 'move',
    stopIcon: 'stop',
    startTooltip: 'overviews.remoteCard.actions.startMove',
    stopTooltip: 'overviews.remoteCard.actions.stopMove',
    cssClass: 'orange',
  },
  bisync: {
    startIcon: 'right-left',
    stopIcon: 'stop',
    startTooltip: 'overviews.remoteCard.actions.startBisync',
    stopTooltip: 'overviews.remoteCard.actions.stopBisync',
    cssClass: 'purple',
  },
  serve: {
    startIcon: 'satellite-dish',
    stopIcon: 'stop',
    startTooltip: 'overviews.remoteCard.actions.startServe',
    stopTooltip: 'overviews.remoteCard.actions.stopServe',
    cssClass: 'accent',
  },
};

const SYNC_TYPES: PrimaryActionType[] = ['sync', 'copy', 'move', 'bisync'];

const MODE_DEFAULTS: Record<AppTab, PrimaryActionType[]> = {
  general: ['mount', 'sync', 'bisync'],
  sync: ['sync', 'bisync', 'copy', 'move'],
  mount: ['mount'],
  serve: ['serve'],
};

@Component({
  selector: 'app-remote-card',
  standalone: true,
  imports: [
    NgClass,
    TitleCasePipe,
    MatCardModule,
    MatIconModule,
    MatButtonModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    QuickActionButtonsComponent,
    TranslateModule,
  ],
  templateUrl: './remote-card.component.html',
  styleUrl: './remote-card.component.scss',
})
export class RemoteCardComponent {
  private readonly translate = inject(TranslateService);
  readonly iconService = inject(IconService);

  readonly remote = input.required<Remote>();
  readonly mode = input<AppTab>('general');
  readonly displayMode = input<CardDisplayMode>('compact');
  readonly actionState = input<RemoteAction>(null);
  readonly actionStates = input<ActionState[]>([]);
  readonly primaryActionLabel = input('Start');
  readonly activeIcon = input('circle-check');
  readonly primaryActions = input<PrimaryActionType[]>([]);
  readonly maxGeneralButtons = input(3);
  readonly maxSyncButtons = input(4);
  readonly maxMountButtons = input(1);

  readonly remoteClick = output<Remote>();
  readonly openInFiles = output<OpenInFilesEvent>();
  readonly startJob = output<{
    type: PrimaryActionType;
    remoteName: string;
    profileName?: string;
  }>();
  readonly stopJob = output<{
    type: PrimaryActionType;
    remoteName: string;
    profileName?: string;
  }>();

  // ── Derived state ──────────────────────────────────────────────────────────

  private readonly anySyncActive = computed(() => SYNC_TYPES.some(op => this.isOpActive(op)));

  readonly cardVariant = computed<RemoteCardVariant>(() => {
    const mode = this.mode();
    switch (mode) {
      case 'mount':
        return this.isOpActive('mount') ? 'active' : 'inactive';
      case 'sync':
        return this.anySyncActive() ? 'active' : 'inactive';
      case 'serve':
        return this.isOpActive('serve') ? 'active' : 'inactive';
      default:
        return this.isOpActive('mount') || this.anySyncActive() || this.isOpActive('serve')
          ? 'active'
          : 'inactive';
    }
  });

  readonly remoteCardClasses = computed(() => {
    const s = this.remote().status;
    return {
      [`${this.cardVariant()}-remote`]: true,
      mounted: !!s.mount.active,
      syncing: !!s.sync.active,
      copying: !!s.copy.active,
      moving: !!s.move.active,
      bisyncing: !!s.bisync.active,
      serving: !!s.serve.active,
    };
  });

  readonly actionButtons = computed<QuickActionButton[]>(() => {
    const mode = this.mode();
    switch (mode) {
      case 'general':
        return this.buildGeneralButtons();
      case 'mount':
        return this.buildMountButtons();
      case 'sync':
        return this.buildSyncButtons();
      case 'serve': {
        const btn = this.buildOpButton('serve');
        return btn ? [btn] : [];
      }
      default:
        return [];
    }
  });

  // ── Button builders ────────────────────────────────────────────────────────

  private buildGeneralButtons(): QuickActionButton[] {
    const actionState = this.actionState();
    const buttons = this.primaryActionsFor(this.maxGeneralButtons())
      .map(type => this.buildOpButton(type))
      .filter((b): b is QuickActionButton => !!b);

    buttons.push({
      id: 'browse',
      icon: 'folder',
      tooltip: this.translate.instant('overviews.remoteCard.browse'),
      isLoading: actionState === 'open',
      isDisabled: !this.remote().status.mount.active || actionState === 'open',
      cssClass: 'accent',
    });

    return buttons;
  }

  private buildMountButtons(): QuickActionButton[] {
    const buttons = this.primaryActionsFor(this.maxMountButtons())
      .map(type => this.buildOpButton(type))
      .filter((b): b is QuickActionButton => !!b);

    if (this.cardVariant() === 'active') {
      buttons.push({
        id: 'open',
        icon: 'folder',
        tooltip: this.translate.instant('overviews.remoteCard.browse'),
        isLoading: this.actionState() === 'open',
        isDisabled: this.actionState() === 'open',
        cssClass: 'accent',
      });
    }
    return buttons;
  }

  private buildSyncButtons(): QuickActionButton[] {
    const actionState = this.actionState();
    if (this.cardVariant() === 'active') {
      return SYNC_TYPES.filter(
        type =>
          (
            this.remote().status[
              type as keyof Omit<RemoteStatus, 'diskUsage'>
            ] as RemoteOperationState
          ).active
      ).map(type => ({
        id: type,
        icon: 'stop',
        tooltip: this.translate.instant(OPERATION_META[type].stopTooltip),
        isLoading: actionState === 'stop',
        isDisabled: actionState === 'stop',
        cssClass: 'warn',
      }));
    }
    return this.primaryActionsFor(this.maxSyncButtons(), false)
      .map(type => this.buildOpButton(type, true))
      .filter((b): b is QuickActionButton => !!b);
  }

  private buildOpButton(type: PrimaryActionType, startOnly = false): QuickActionButton | null {
    const meta = OPERATION_META[type];
    if (!meta) return null;

    const actionState = this.actionState();
    const isActive = !startOnly && this.isOpActive(type);
    const inProgress = actionState === type || (!startOnly && actionState === 'stop');

    const isLoading = startOnly
      ? actionState === type
      : type === 'mount' || type === 'serve'
        ? inProgress
        : inProgress && isActive;

    const activeProfileName = this.getFirstActiveProfile(type);

    return {
      id: type,
      icon: isActive ? meta.stopIcon : meta.startIcon,
      tooltip: isActive
        ? `${this.translate.instant(meta.stopTooltip)} (${activeProfileName})`
        : this.translate.instant(meta.startTooltip),
      isLoading,
      isDisabled: inProgress,
      cssClass: isActive ? 'warn' : meta.cssClass,
    };
  }

  // ── Primary action list builder ────────────────────────────────────────────

  private primaryActionsFor(limit: number, includeMount = true): PrimaryActionType[] {
    const mode = this.mode();
    const userActions = this.primaryActions();
    const source =
      mode === 'general' && userActions.length > 0
        ? userActions
        : (MODE_DEFAULTS[mode] ?? ['mount', 'bisync']);

    const result: PrimaryActionType[] = [];
    for (const a of source) {
      if (result.length >= limit) break;
      if (!includeMount && a === 'mount') continue;
      if (!result.includes(a)) result.push(a);
    }
    return result;
  }

  // ── Event handlers ─────────────────────────────────────────────────────────

  onRemoteClick(): void {
    this.remoteClick.emit(this.remote());
  }

  onActionButtonClick(action: { id: string; event: Event }): void {
    action.event.stopPropagation();
    const remoteName = this.remote().name;

    if (action.id === 'open' || action.id === 'browse') {
      this.openInFiles.emit({ remoteName });
      return;
    }

    const type = action.id as PrimaryActionType;
    if (!OPERATION_META[type]) return;

    if (this.isOpActive(type)) {
      this.stopJob.emit({ type, remoteName, profileName: this.getFirstActiveProfile(type) });
    } else {
      this.startJob.emit({ type, remoteName });
    }
  }

  onProfileOpenInFiles(operationType: PrimaryActionType, profileName: string, event: Event): void {
    event.stopPropagation();
    const path = this.getProfileOpenPath(operationType, profileName);
    if (path) this.openInFiles.emit({ remoteName: this.remote().name, path });
  }

  onProfileChipClick(operationType: PrimaryActionType, profileName: string, event: Event): void {
    event.stopPropagation();
    if (this.isProfileActionInProgress(operationType, profileName)) return;
    const remoteName = this.remote().name;
    if (this.isProfileActive(operationType, profileName)) {
      this.stopJob.emit({ type: operationType, remoteName, profileName });
    } else {
      this.startJob.emit({ type: operationType, remoteName, profileName });
    }
  }

  // ── Profile chip helpers ───────────────────────────────────────────────────

  isProfileChipDisabled(op: PrimaryActionType, profile: string): boolean {
    return this.isProfileActionInProgress(op, profile);
  }

  isProfileChipLoading(op: PrimaryActionType, profile: string): boolean {
    return this.isProfileActionInProgress(op, profile);
  }

  private isProfileActionInProgress(op: PrimaryActionType, profile: string): boolean {
    return this.actionStates().some(a => {
      if (a.profileName && a.profileName !== profile) return false;
      return a.type === 'stop' ? a.operationType === op : a.type === op;
    });
  }

  getProfileChipTooltip(op: PrimaryActionType, profile: string): string {
    const meta = OPERATION_META[op];
    const key = this.isProfileActive(op, profile) ? meta.stopTooltip : meta.startTooltip;
    return `${this.translate.instant(key)} (${profile})`;
  }

  getProfileOpenTooltip(profileName: string): string {
    return `${this.translate.instant('overviews.remoteCard.browse')} (${profileName})`;
  }

  getOperationLabelIcon(op: PrimaryActionType): string {
    return OPERATION_META[op]?.startIcon ?? 'circle';
  }

  getOperationCssClass(op: PrimaryActionType): string {
    return OPERATION_META[op]?.cssClass ?? 'primary';
  }

  // ── Operation state helpers ────────────────────────────────────────────────

  isOpActive(op: PrimaryActionType): boolean {
    return !!(
      this.remote().status[op as keyof Omit<RemoteStatus, 'diskUsage'>] as
        | RemoteOperationState
        | RemoteServeState
    )?.active;
  }

  private getActiveProfiles(op: PrimaryActionType): Record<string, unknown> | undefined {
    return (
      this.remote().status[op as keyof Omit<RemoteStatus, 'diskUsage'>] as
        | RemoteOperationState
        | RemoteServeState
    )?.activeProfiles;
  }

  getFirstActiveProfile(op: PrimaryActionType): string {
    const profiles = this.getActiveProfiles(op);
    return profiles ? (Object.keys(profiles)[0] ?? 'default') : 'default';
  }

  getProfileTooltip(op: PrimaryActionType): string {
    const profiles = this.getActiveProfiles(op);
    const names = Object.keys(profiles ?? {});
    if (names.length === 0) return op;
    if (names.length === 1) return `${op} (${names[0]})`;
    return `${op} (${names.join(', ')})`;
  }

  // ── Configured profiles helpers (detailed variant) ─────────────────────────

  getConfiguredProfiles(op: PrimaryActionType): string[] {
    return (
      (
        this.remote().status[op as keyof Omit<RemoteStatus, 'diskUsage'>] as
          | RemoteOperationState
          | RemoteServeState
      )?.configuredProfiles ?? []
    );
  }

  isProfileActive(op: PrimaryActionType, profile: string): boolean {
    return profile in (this.getActiveProfiles(op) ?? {});
  }

  canOpenProfilePath(op: PrimaryActionType, profile: string): boolean {
    return !!this.getProfileOpenPath(op, profile);
  }

  private getProfileOpenPath(op: PrimaryActionType, profile: string): string | null {
    if (op === 'mount') {
      const path = this.getActiveProfiles('mount')?.[profile];
      return typeof path === 'string' && isLocalPath(path) ? path : null;
    }

    if (SYNC_TYPES.includes(op) && !this.isProfileActive(op, profile)) return null;

    const browsePaths = (
      this.remote().status[op as keyof Omit<RemoteStatus, 'diskUsage'>] as RemoteOperationState
    )?.profileBrowsePaths;
    const configured = browsePaths?.[profile];
    if (typeof configured === 'string' && isLocalPath(configured)) return configured;

    const active = this.getActiveProfiles(op)?.[profile];
    if (typeof active === 'string' && isLocalPath(active)) return active;

    return null;
  }

  getActiveOperations(): PrimaryActionType[] {
    const mode = this.mode();
    let candidates: PrimaryActionType[];
    switch (mode) {
      case 'general':
        candidates = this.primaryActionsFor(this.maxGeneralButtons());
        break;
      case 'mount':
        candidates = ['mount'];
        break;
      case 'sync':
        candidates = this.primaryActionsFor(this.maxSyncButtons(), false);
        break;
      case 'serve':
        candidates = ['serve'];
        break;
      default:
        candidates = [];
    }
    return candidates.filter(op => this.getConfiguredProfiles(op).length > 0);
  }
}
