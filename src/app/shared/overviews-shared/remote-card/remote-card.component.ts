import { NgClass, TitleCasePipe } from '@angular/common';
import { Component, computed, input, inject, output } from '@angular/core';
import { TranslateService, TranslateModule } from '@ngx-translate/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { QuickActionButtonsComponent } from '../../../shared/components';
import {
  AppTab,
  PrimaryActionType,
  QuickActionButton,
  Remote,
  RemoteAction,
  RemoteCardVariant,
} from '@app/types';
import { IconService } from '@app/services';

/**
 * Centralized configuration for all operation types.
 * Eliminates repetitive switch statements by providing lookup-based metadata.
 */
interface OperationConfig {
  stateKey: keyof Remote;
  isActiveKey: string;
  startIcon: string;
  stopIcon: string;
  startTooltip: string;
  stopTooltip: string;
  cssClass: string;
}

const OPERATION_CONFIG: Record<PrimaryActionType, OperationConfig> = {
  mount: {
    stateKey: 'mountState',
    isActiveKey: 'mounted',
    startIcon: 'mount',
    stopIcon: 'eject',
    startTooltip: 'overviews.remoteCard.actions.mount',
    stopTooltip: 'overviews.remoteCard.actions.unmount',
    cssClass: 'accent',
  },
  sync: {
    stateKey: 'syncState',
    isActiveKey: 'isOnSync',
    startIcon: 'refresh',
    stopIcon: 'stop',
    startTooltip: 'overviews.remoteCard.actions.startSync',
    stopTooltip: 'overviews.remoteCard.actions.stopSync',
    cssClass: 'primary',
  },
  copy: {
    stateKey: 'copyState',
    isActiveKey: 'isOnCopy',
    startIcon: 'copy',
    stopIcon: 'stop',
    startTooltip: 'overviews.remoteCard.actions.startCopy',
    stopTooltip: 'overviews.remoteCard.actions.stopCopy',
    cssClass: 'yellow',
  },
  move: {
    stateKey: 'moveState',
    isActiveKey: 'isOnMove',
    startIcon: 'move',
    stopIcon: 'stop',
    startTooltip: 'overviews.remoteCard.actions.startMove',
    stopTooltip: 'overviews.remoteCard.actions.stopMove',
    cssClass: 'orange',
  },
  bisync: {
    stateKey: 'bisyncState',
    isActiveKey: 'isOnBisync',
    startIcon: 'right-left',
    stopIcon: 'stop',
    startTooltip: 'overviews.remoteCard.actions.startBisync',
    stopTooltip: 'overviews.remoteCard.actions.stopBisync',
    cssClass: 'purple',
  },
  serve: {
    stateKey: 'serveState',
    isActiveKey: 'isOnServe',
    startIcon: 'satellite-dish',
    stopIcon: 'stop',
    startTooltip: 'overviews.remoteCard.actions.startServe',
    stopTooltip: 'overviews.remoteCard.actions.stopServe',
    cssClass: 'primary',
  },
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
    MatDividerModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    QuickActionButtonsComponent,
    TranslateModule,
  ],
  templateUrl: './remote-card.component.html',
  styleUrl: './remote-card.component.scss',
})
export class RemoteCardComponent {
  private translate = inject(TranslateService);
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
  stopJob = output<{
    type: PrimaryActionType;
    remoteName: string;
    profileName?: string;
  }>();

  readonly iconService = inject(IconService);

  isOpening = computed(() => this.actionState() === 'open');
  isStopping = computed(() => this.actionState() === 'stop');
  isLoading = computed(() => this.actionState() === this.mode());

  actionButtons = computed<QuickActionButton[]>(() => {
    const buttons: QuickActionButton[] = [];
    const mode = this.mode();
    const cardVariant = this.cardVariant();

    if (mode === 'general') {
      return this.getGeneralActionButtons();
    }

    if (mode === 'mount') {
      if (cardVariant === 'active') {
        const primary = this.buildPrimaryActions(this.maxMountButtons(), true);
        for (const a of primary) {
          const b = this.createOperationButton(a);
          if (b) buttons.push(b);
        }
        if (this.showOpenButton()) {
          buttons.push({
            id: 'open',
            icon: 'folder',
            tooltip: this.translate.instant('overviews.remoteCard.browse') + ' (B)',
            isLoading: this.isOpening(),
            isDisabled: this.isOpening(),
            cssClass: 'accent',
          });
        }
      } else if (cardVariant === 'inactive') {
        const primary = this.buildPrimaryActions(this.maxMountButtons(), true);
        for (const a of primary) {
          const b = this.createOperationButton(a);
          if (b) buttons.push(b);
        }
      }
      return buttons;
    }

    // Sync mode - handle all sync operations
    if (mode === 'sync') {
      return this.getSyncModeActionButtons();
    }

    if (mode === 'serve') {
      // For serve mode, show serve start/stop button
      const serveButton = this.createOperationButton('serve');
      if (serveButton) buttons.push(serveButton);
    }

    return buttons;
  });

  private getSyncModeActionButtons(): QuickActionButton[] {
    const buttons: QuickActionButton[] = [];
    const cardVariant = this.cardVariant();
    const remote = this.remote();
    const actionState = this.actionState();

    if (cardVariant === 'active') {
      if (this.showOpenButton()) {
        buttons.push({
          id: 'open',
          icon: 'folder',
          tooltip: this.translate.instant('overviews.remoteCard.browseDest'),
          isLoading: this.isOpening(),
          isDisabled: this.isOpening(),
          cssClass: 'accent',
        });
      }

      // Create stop buttons for all active sync operations using a loop
      const syncOps: { type: PrimaryActionType; stateKey: keyof Remote; activeKey: string }[] = [
        { type: 'sync', stateKey: 'syncState', activeKey: 'isOnSync' },
        { type: 'copy', stateKey: 'copyState', activeKey: 'isOnCopy' },
        { type: 'move', stateKey: 'moveState', activeKey: 'isOnMove' },
        { type: 'bisync', stateKey: 'bisyncState', activeKey: 'isOnBisync' },
      ];

      syncOps.forEach(({ type, stateKey, activeKey }) => {
        const state = remote[stateKey] as Record<string, unknown> | undefined;
        if (state?.[activeKey]) {
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
    } else if (cardVariant === 'inactive') {
      // For inactive remotes, show start buttons for available sync operations.
      const actionsToShow = this.buildPrimaryActions(this.maxSyncButtons(), false);
      actionsToShow.forEach(actionType => {
        const button = this.createStartSyncOperationButton(actionType);
        if (button) buttons.push(button);
      });
    }

    return buttons;
  }

  private getDefaultPrimaryActions(): PrimaryActionType[] {
    const mode = this.mode();

    if (this.primaryActions() && this.primaryActions().length > 0 && mode === 'general') {
      return this.primaryActions();
    }

    // Default primary actions: Mount + Sync + BiSync (3 operations)
    // Note: Mount is handled separately, so we return sync operations only

    switch (mode) {
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

  private getGeneralActionButtons(): QuickActionButton[] {
    const buttons: QuickActionButton[] = [];
    const remote = this.remote();
    const actionState = this.actionState();

    const selectedActions = this.buildPrimaryActions(this.maxGeneralButtons(), true);
    selectedActions.forEach((actionType: PrimaryActionType) => {
      const button = this.createOperationButton(actionType);
      if (button) buttons.push(button);
    });

    buttons.push({
      id: 'browse',
      icon: 'folder',
      tooltip: this.translate.instant('overviews.remoteCard.browse'),
      isLoading: actionState === 'open',
      isDisabled: !remote.mountState?.mounted || actionState === 'open',
      cssClass: 'accent',
    });

    return buttons;
  }

  /**
   * Build an ordered, deduplicated list of primary actions.
   * - Uses user-provided `primaryActions` when available, otherwise defaults.
   * - Fills up to `slotCount` items by appending defaults not already present.
   * - Optionally includes or excludes 'mount'.
   */
  private buildPrimaryActions(slotCount: number, includeMount = true): PrimaryActionType[] {
    const result: PrimaryActionType[] = [];
    const mode = this.mode();

    const source =
      this.primaryActions() && this.primaryActions().length > 0 && mode === 'general'
        ? [...this.primaryActions()]
        : this.getDefaultPrimaryActions();

    // Add user/defaults in order, respecting includeMount flag and uniqueness
    for (const a of source) {
      if (result.length >= slotCount) break;
      if (!includeMount && a === 'mount') continue;
      if (!result.includes(a)) result.push(a);
    }

    if (result.length >= slotCount) return result;

    // Fill remaining with defaults (excluding mount if requested)
    const defaults = this.getDefaultPrimaryActions();
    for (const d of defaults) {
      if (result.length >= slotCount) break;
      if (!includeMount && d === 'mount') continue;
      if (!result.includes(d)) result.push(d);
    }

    return result;
  }

  private createOperationButton(actionType: PrimaryActionType): QuickActionButton | null {
    const config = OPERATION_CONFIG[actionType];
    if (!config) return null;

    const isActive = this.isOperationActive(actionType);
    const profileName = isActive ? this.getActiveProfileName(actionType) : 'default';
    const actionState = this.actionState();
    const isActionInProgress = actionState === actionType || actionState === 'stop';

    // For mount/serve, show loading always when action in progress
    // For others, only show loading when the operation is active and being stopped
    const showLoading =
      actionType === 'mount' || actionType === 'serve'
        ? isActionInProgress
        : isActionInProgress && isActive;

    return {
      id: actionType,
      icon: isActive ? config.stopIcon : config.startIcon,
      tooltip: isActive
        ? `${this.translate.instant(config.stopTooltip)} (${profileName})`
        : `${this.translate.instant(config.startTooltip)} (${profileName})`,
      isLoading: showLoading,
      isDisabled: isActionInProgress,
      cssClass: isActive ? 'warn' : config.cssClass,
    };
  }

  private createStartSyncOperationButton(actionType: PrimaryActionType): QuickActionButton | null {
    const config = OPERATION_CONFIG[actionType];
    if (!config) return null;

    const isActionInProgress = this.actionState() === actionType;
    return {
      id: actionType,
      icon: config.startIcon,
      tooltip: this.translate.instant(config.startTooltip),
      isLoading: isActionInProgress,
      isDisabled: isActionInProgress,
      cssClass: config.cssClass,
    };
  }

  onActionButtonClick(action: { id: string; event: Event }): void {
    action.event.stopPropagation();
    const remoteName = this.remote().remoteSpecs.name;

    // Handle browse/open actions
    if (action.id === 'open' || action.id === 'browse') {
      this.openInFiles.emit(remoteName);
      return;
    }

    // Handle operation actions using unified pattern
    const type = action.id as PrimaryActionType;
    if (OPERATION_CONFIG[type]) {
      if (this.isOperationActive(type)) {
        const profileName = this.getActiveProfileName(type);
        this.stopJob.emit({ type, remoteName, profileName });
      } else {
        this.startJob.emit({ type, remoteName });
      }
    }
  }

  remoteCardClasses = computed(() => {
    const remote = this.remote();
    return {
      [`${this.cardVariant()}-remote`]: true,
      mounted: !!remote.mountState?.mounted,
      syncing: !!remote.syncState?.isOnSync,
      copying: !!remote.copyState?.isOnCopy,
      moving: !!remote.moveState?.isOnMove,
      bisyncing: !!remote.bisyncState?.isOnBisync,
      serving: !!remote.serveState?.isOnServe,
    };
  });

  onRemoteClick(): void {
    this.remoteClick.emit(this.remote());
  }

  onOpenInFiles(event: Event): void {
    event.stopPropagation();
    this.openInFiles.emit(this.remote().remoteSpecs.name);
  }

  private showOpenButton(): boolean {
    const mode = this.mode();
    const remote = this.remote();
    if (mode === 'mount') return true;
    if (mode === 'sync') {
      return (
        remote.syncState?.isLocal ||
        remote.copyState?.isLocal ||
        remote.moveState?.isLocal ||
        remote.bisyncState?.isLocal ||
        false
      );
    }
    if (mode === 'general') return remote.mountState?.mounted === true;
    return false;
  }

  /**
   * Check if an operation is currently active for this remote
   */
  isOperationActive(operationType: PrimaryActionType): boolean {
    const config = OPERATION_CONFIG[operationType];
    const state = this.remote()[config.stateKey] as Record<string, unknown> | undefined;
    return !!state?.[config.isActiveKey];
  }

  /**
   * Get Selected Profiles map for an operation type
   */
  private getOperationActiveProfiles(
    operationType: PrimaryActionType
  ): Record<string, unknown> | undefined {
    const config = OPERATION_CONFIG[operationType];
    const state = this.remote()[config.stateKey] as
      | { activeProfiles?: Record<string, unknown> }
      | undefined;
    return state?.activeProfiles;
  }

  /**
   * Get the first Selected Profile name for a given operation type
   */
  getActiveProfileName(operationType: PrimaryActionType): string {
    const profiles = this.getOperationActiveProfiles(operationType);
    return profiles ? Object.keys(profiles)[0] || 'default' : 'default';
  }

  /**
   * Get the count of Selected Profiles for a given operation type
   */
  getActiveProfileCount(operationType: PrimaryActionType): number {
    return Object.keys(this.getOperationActiveProfiles(operationType) || {}).length;
  }

  /**
   * Get tooltip text for status indicators showing all Selected Profiles
   */
  getProfileTooltip(operationType: PrimaryActionType): string {
    const count = this.getActiveProfileCount(operationType);
    if (count === 0) return operationType;
    if (count === 1) return `${operationType} (${this.getActiveProfileName(operationType)})`;

    // Multiple profiles - list them all
    const profiles = Object.keys(this.getOperationActiveProfiles(operationType) || {});

    return `${operationType} (${profiles.join(', ')})`;
  }

  private isAnySyncActive(): boolean {
    return (
      this.isOperationActive('sync') ||
      this.isOperationActive('copy') ||
      this.isOperationActive('move') ||
      this.isOperationActive('bisync')
    );
  }

  cardVariant = computed<RemoteCardVariant>(() => {
    const mode = this.mode();

    if (mode === 'general') {
      if (
        this.isOperationActive('mount') ||
        this.isAnySyncActive() ||
        this.isOperationActive('serve')
      ) {
        return 'active';
      }
    }
    if (mode === 'mount') {
      return this.isOperationActive('mount') ? 'active' : 'inactive';
    }
    if (mode === 'sync') {
      return this.isAnySyncActive() ? 'active' : 'inactive';
    }
    if (mode === 'serve') {
      return this.isOperationActive('serve') ? 'active' : 'inactive';
    }
    return 'inactive';
  });
}
