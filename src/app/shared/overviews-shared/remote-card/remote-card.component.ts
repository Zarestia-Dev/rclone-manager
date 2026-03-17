import { NgClass, TitleCasePipe } from '@angular/common';
import { Component, computed, input, inject, output } from '@angular/core';
import { TranslateService, TranslateModule } from '@ngx-translate/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { QuickActionButtonsComponent } from '../../../shared/components';
import {
  AppTab,
  PrimaryActionType,
  QuickActionButton,
  Remote,
  RemoteStatus,
  RemoteOperationState,
  RemoteServeState,
  RemoteAction,
  RemoteCardVariant,
} from '@app/types';
import { IconService } from '@app/services';

/**
 * Centralized configuration for all operation types.
 * Eliminates repetitive switch statements by providing lookup-based metadata.
 */
const OPERATION_CONFIG: Record<
  PrimaryActionType,
  {
    startIcon: string;
    stopIcon: string;
    startTooltip: string;
    stopTooltip: string;
    cssClass: string;
  }
> = {
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
    cssClass: 'primary',
  },
};

const SYNC_OPERATION_TYPES: PrimaryActionType[] = ['sync', 'copy', 'move', 'bisync'];

@Component({
  selector: 'app-remote-card',
  standalone: true,
  imports: [
    NgClass,
    TitleCasePipe,
    MatCardModule,
    MatIconModule,
    MatButtonModule,
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

  remote = input.required<Remote>();
  mode = input<AppTab>('general');
  actionState = input<RemoteAction>(null);
  primaryActionLabel = input('Start');
  activeIcon = input('circle-check');
  primaryActions = input<PrimaryActionType[]>([]);
  maxGeneralButtons = input(3);
  maxSyncButtons = input(4);
  maxMountButtons = input(1);

  remoteClick = output<Remote>();
  openInFiles = output<string>();
  startJob = output<{ type: PrimaryActionType; remoteName: string }>();
  stopJob = output<{ type: PrimaryActionType; remoteName: string; profileName?: string }>();

  // ── Derived state ──────────────────────────────────────────────────────────

  private readonly isAnySyncActive = computed(() =>
    SYNC_OPERATION_TYPES.some(op => this.isOperationActive(op))
  );

  readonly cardVariant = computed<RemoteCardVariant>(() => {
    const mode = this.mode();

    if (mode === 'general') {
      return this.isOperationActive('mount') ||
        this.isAnySyncActive() ||
        this.isOperationActive('serve')
        ? 'active'
        : 'inactive';
    }
    if (mode === 'mount') return this.isOperationActive('mount') ? 'active' : 'inactive';
    if (mode === 'sync') return this.isAnySyncActive() ? 'active' : 'inactive';
    if (mode === 'serve') return this.isOperationActive('serve') ? 'active' : 'inactive';
    return 'inactive';
  });

  readonly remoteCardClasses = computed(() => {
    const remote = this.remote();
    return {
      [`${this.cardVariant()}-remote`]: true,
      mounted: !!remote.status.mount.active,
      syncing: !!remote.status.sync.active,
      copying: !!remote.status.copy.active,
      moving: !!remote.status.move.active,
      bisyncing: !!remote.status.bisync.active,
      serving: !!remote.status.serve.active,
    };
  });

  readonly actionButtons = computed<QuickActionButton[]>(() => {
    const mode = this.mode();

    if (mode === 'general') return this.getGeneralActionButtons();
    if (mode === 'mount') return this.getMountActionButtons();
    if (mode === 'sync') return this.getSyncModeActionButtons();
    if (mode === 'serve') {
      const button = this.createOperationButton('serve');
      return button ? [button] : [];
    }
    return [];
  });

  // ── Action button builders ─────────────────────────────────────────────────

  private getMountActionButtons(): QuickActionButton[] {
    const buttons: QuickActionButton[] = [];

    for (const a of this.buildPrimaryActions(this.maxMountButtons(), true)) {
      const b = this.createOperationButton(a);
      if (b) buttons.push(b);
    }

    // Browse button only shown in active state
    if (this.cardVariant() === 'active') {
      buttons.push(this.buildBrowseButton('overviews.remoteCard.browse'));
    }

    return buttons;
  }

  private getSyncModeActionButtons(): QuickActionButton[] {
    const buttons: QuickActionButton[] = [];
    const actionState = this.actionState();

    if (this.cardVariant() === 'active') {
      SYNC_OPERATION_TYPES.forEach(type => {
        const state = this.remote().status[type as keyof Omit<RemoteStatus, 'diskUsage'>];
        if ('active' in state && state.active) {
          const config = OPERATION_CONFIG[type];
          buttons.push({
            id: type,
            icon: 'stop',
            tooltip: this.translate.instant(config.stopTooltip),
            isLoading: actionState === 'stop',
            isDisabled: actionState === 'stop',
            cssClass: 'warn',
          });
        }
      });
    } else {
      // Inactive — show start buttons only; no toggle behaviour needed
      this.buildPrimaryActions(this.maxSyncButtons(), false).forEach(actionType => {
        const button = this.createOperationButton(actionType, true);
        if (button) buttons.push(button);
      });
    }

    return buttons;
  }

  private getGeneralActionButtons(): QuickActionButton[] {
    const buttons: QuickActionButton[] = [];
    const actionState = this.actionState();
    const remote = this.remote();

    this.buildPrimaryActions(this.maxGeneralButtons(), true).forEach(actionType => {
      const button = this.createOperationButton(actionType);
      if (button) buttons.push(button);
    });

    buttons.push({
      id: 'browse',
      icon: 'folder',
      tooltip: this.translate.instant('overviews.remoteCard.browse'),
      isLoading: actionState === 'open',
      isDisabled: !remote.status.mount.active || actionState === 'open',
      cssClass: 'accent',
    });

    return buttons;
  }

  // ── Button factories ───────────────────────────────────────────────────────

  /**
   * Creates a toggle (start/stop) or start-only action button.
   *
   * @param actionType  The operation this button controls.
   * @param startOnly   When true the button always shows the start state —
   *                    used for sync-mode inactive cards where we never need
   *                    to show a stop affordance inline.
   */
  private createOperationButton(
    actionType: PrimaryActionType,
    startOnly = false
  ): QuickActionButton | null {
    const config = OPERATION_CONFIG[actionType];
    if (!config) return null;

    const actionState = this.actionState();
    const isActive = !startOnly && this.isOperationActive(actionType);
    const isActionInProgress = actionState === actionType || (!startOnly && actionState === 'stop');

    const isLoading = startOnly
      ? actionState === actionType
      : actionType === 'mount' || actionType === 'serve'
        ? isActionInProgress
        : isActionInProgress && isActive;

    return {
      id: actionType,
      icon: isActive ? config.stopIcon : config.startIcon,
      tooltip: isActive
        ? `${this.translate.instant(config.stopTooltip)} (${this.getActiveProfileName(actionType)})`
        : this.translate.instant(config.startTooltip),
      isLoading,
      isDisabled: isActionInProgress,
      cssClass: isActive ? 'warn' : config.cssClass,
    };
  }

  private buildBrowseButton(tooltipKey: string): QuickActionButton {
    const actionState = this.actionState();
    return {
      id: 'open',
      icon: 'folder',
      tooltip: this.translate.instant(tooltipKey),
      isLoading: actionState === 'open',
      isDisabled: actionState === 'open',
      cssClass: 'accent',
    };
  }

  // ── Primary-actions resolver ───────────────────────────────────────────────

  /**
   * Returns the default ordered action list for the current mode.
   * In general mode, user-supplied `primaryActions` take precedence.
   */
  private getDefaultPrimaryActions(): PrimaryActionType[] {
    switch (this.mode()) {
      case 'general':
        return ['mount', 'sync', 'bisync'];
      case 'sync':
        return ['sync', 'bisync', 'copy', 'move'];
      case 'mount':
        return ['mount'];
      case 'serve':
        return ['serve'];
      default:
        return ['mount', 'bisync'];
    }
  }

  /**
   * Builds an ordered, deduplicated list of primary actions up to `slotCount`.
   * User-supplied actions are prioritised in general mode; defaults fill remaining slots.
   */
  private buildPrimaryActions(slotCount: number, includeMount = true): PrimaryActionType[] {
    const mode = this.mode();
    const userActions = this.primaryActions();
    const defaults = this.getDefaultPrimaryActions();
    const source = mode === 'general' && userActions.length > 0 ? userActions : defaults;

    const seen = new Set<PrimaryActionType>();
    const result: PrimaryActionType[] = [];

    const fill = (list: PrimaryActionType[]) => {
      for (const a of list) {
        if (result.length >= slotCount) break;
        if (!includeMount && a === 'mount') continue;
        if (!seen.has(a)) {
          seen.add(a);
          result.push(a);
        }
      }
    };

    fill(source);
    if (result.length < slotCount) fill(defaults);

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
      this.openInFiles.emit(remoteName);
      return;
    }

    const type = action.id as PrimaryActionType;
    if (!OPERATION_CONFIG[type]) return;

    if (this.isOperationActive(type)) {
      this.stopJob.emit({ type, remoteName, profileName: this.getActiveProfileName(type) });
    } else {
      this.startJob.emit({ type, remoteName });
    }
  }

  // ── Operation state helpers ────────────────────────────────────────────────

  isOperationActive(operationType: PrimaryActionType): boolean {
    const state = this.remote().status[operationType as keyof Omit<RemoteStatus, 'diskUsage'>];
    return !!(state as RemoteOperationState | RemoteServeState)?.active;
  }

  private getOperationActiveProfiles(
    operationType: PrimaryActionType
  ): Record<string, unknown> | undefined {
    const state = this.remote().status[operationType as keyof Omit<RemoteStatus, 'diskUsage'>];
    return (state as RemoteOperationState | RemoteServeState)?.activeProfiles;
  }

  /** Returns the first active profile name for the given operation, or 'default'. */
  getActiveProfileName(operationType: PrimaryActionType): string {
    const profiles = this.getOperationActiveProfiles(operationType);
    return profiles ? (Object.keys(profiles)[0] ?? 'default') : 'default';
  }

  /** Returns the count of active profiles for the given operation. */
  getActiveProfileCount(operationType: PrimaryActionType): number {
    return Object.keys(this.getOperationActiveProfiles(operationType) ?? {}).length;
  }

  /** Builds the tooltip text for status indicator badges, listing all active profiles. */
  getProfileTooltip(operationType: PrimaryActionType): string {
    const count = this.getActiveProfileCount(operationType);
    if (count === 0) return operationType;
    if (count === 1) return `${operationType} (${this.getActiveProfileName(operationType)})`;
    const profiles = Object.keys(this.getOperationActiveProfiles(operationType) ?? {});
    return `${operationType} (${profiles.join(', ')})`;
  }
}
