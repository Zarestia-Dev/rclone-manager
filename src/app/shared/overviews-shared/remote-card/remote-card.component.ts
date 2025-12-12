import { CommonModule } from '@angular/common';
import { Component, computed, EventEmitter, input, Output, inject } from '@angular/core';
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
import { IconService } from '../../services/icon.service';

@Component({
  selector: 'app-remote-card',
  standalone: true,
  imports: [
    CommonModule,
    MatCardModule,
    MatIconModule,
    MatButtonModule,
    MatDividerModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    QuickActionButtonsComponent,
  ],
  templateUrl: './remote-card.component.html',
  styleUrl: './remote-card.component.scss',
})
export class RemoteCardComponent {
  remote = input.required<Remote>();
  mode = input<AppTab>('general');
  actionState = input<RemoteAction>(null);
  primaryActionLabel = input('Start');
  activeIcon = input('circle-check');
  primaryActions = input<PrimaryActionType[]>([]);
  maxGeneralButtons = input(3);
  maxSyncButtons = input(4);
  maxMountButtons = input(1);

  @Output() remoteClick = new EventEmitter<Remote>();
  @Output() openInFiles = new EventEmitter<string>();
  @Output() startJob = new EventEmitter<{ type: PrimaryActionType; remoteName: string }>();
  @Output() stopJob = new EventEmitter<{ type: PrimaryActionType; remoteName: string }>();

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
            tooltip: 'Browse (B)',
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
      // For serve mode, show serve start button
      if (cardVariant === 'inactive') {
        const serveButton = this.createOperationButton('serve');
        if (serveButton) buttons.push(serveButton);
      }
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
          tooltip: 'Browse Destination',
          isLoading: this.isOpening(),
          isDisabled: this.isOpening(),
          cssClass: 'accent',
        });
      }

      if (remote.syncState?.isOnSync) {
        buttons.push({
          id: 'sync',
          icon: 'stop',
          tooltip: 'Stop Sync',
          isLoading: actionState === 'stop',
          isDisabled: actionState === 'stop',
          cssClass: 'warn',
        });
      }
      if (remote.copyState?.isOnCopy) {
        buttons.push({
          id: 'copy',
          icon: 'stop',
          tooltip: 'Stop Copy',
          isLoading: actionState === 'stop',
          isDisabled: actionState === 'stop',
          cssClass: 'warn',
        });
      }
      if (remote.moveState?.isOnMove) {
        buttons.push({
          id: 'move',
          icon: 'stop',
          tooltip: 'Stop Move',
          isLoading: actionState === 'stop',
          isDisabled: actionState === 'stop',
          cssClass: 'warn',
        });
      }
      if (remote.bisyncState?.isOnBisync) {
        buttons.push({
          id: 'bisync',
          icon: 'stop',
          tooltip: 'Stop BiSync',
          isLoading: actionState === 'stop',
          isDisabled: actionState === 'stop',
          cssClass: 'warn',
        });
      }
    } else if (cardVariant === 'inactive') {
      // For inactive remotes, show start buttons for available sync operations.
      // Build an ordered, deduplicated list of actions (exclude 'mount' here)

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
      tooltip: 'Browse',
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
    const actionState = this.actionState();
    const isActionInProgress = actionState === actionType || actionState === 'stop';
    const remote = this.remote();

    switch (actionType) {
      case 'mount':
        return {
          id: 'mount',
          icon: remote.mountState?.mounted ? 'eject' : 'mount',
          tooltip: remote.mountState?.mounted ? 'Unmount' : 'Mount',
          isLoading: isActionInProgress,
          isDisabled: isActionInProgress,
          cssClass: remote.mountState?.mounted ? 'warn' : 'accent',
        };

      case 'sync':
        return {
          id: 'sync',
          icon: remote.syncState?.isOnSync ? 'stop' : 'refresh',
          tooltip: remote.syncState?.isOnSync ? 'Stop Sync' : 'Start Sync',
          isLoading: isActionInProgress && !!remote.syncState?.isOnSync,
          isDisabled: isActionInProgress,
          cssClass: remote.syncState?.isOnSync ? 'warn' : 'primary',
        };

      case 'copy':
        return {
          id: 'copy',
          icon: remote.copyState?.isOnCopy ? 'stop' : 'copy',
          tooltip: remote.copyState?.isOnCopy ? 'Stop Copy' : 'Start Copy',
          isLoading: isActionInProgress && !!remote.copyState?.isOnCopy,
          isDisabled: isActionInProgress,
          cssClass: remote.copyState?.isOnCopy ? 'warn' : 'yellow',
        };

      case 'move':
        return {
          id: 'move',
          icon: remote.moveState?.isOnMove ? 'stop' : 'move',
          tooltip: remote.moveState?.isOnMove ? 'Stop Move' : 'Start Move',
          isLoading: isActionInProgress && !!remote.moveState?.isOnMove,
          isDisabled: isActionInProgress,
          cssClass: remote.moveState?.isOnMove ? 'warn' : 'orange',
        };

      case 'bisync':
        return {
          id: 'bisync',
          icon: remote.bisyncState?.isOnBisync ? 'stop' : 'right-left',
          tooltip: remote.bisyncState?.isOnBisync ? 'Stop BiSync' : 'Start BiSync',
          isLoading: isActionInProgress && !!remote.bisyncState?.isOnBisync,
          isDisabled: isActionInProgress,
          cssClass: remote.bisyncState?.isOnBisync ? 'warn' : 'purple',
        };

      case 'serve':
        return {
          id: 'serve',
          icon: remote.serveState?.isOnServe ? 'stop' : 'satellite-dish',
          tooltip: remote.serveState?.isOnServe ? 'Stop Serve' : 'Start Serve',
          isLoading: isActionInProgress,
          isDisabled: isActionInProgress,
          cssClass: remote.serveState?.isOnServe ? 'warn' : 'primary',
        };

      default:
        return null;
    }
  }

  private createStartSyncOperationButton(actionType: PrimaryActionType): QuickActionButton | null {
    const isActionInProgress = this.actionState() === actionType;

    switch (actionType) {
      case 'sync':
        return {
          id: 'sync',
          icon: 'refresh',
          tooltip: 'Start Sync',
          isLoading: isActionInProgress,
          isDisabled: isActionInProgress,
          cssClass: 'primary',
        };
      case 'copy':
        return {
          id: 'copy',
          icon: 'copy',
          tooltip: 'Start Copy',
          isLoading: isActionInProgress,
          isDisabled: isActionInProgress,
          cssClass: 'yellow',
        };
      case 'move':
        return {
          id: 'move',
          icon: 'move',
          tooltip: 'Start Move',
          isLoading: isActionInProgress,
          isDisabled: isActionInProgress,
          cssClass: 'orange',
        };
      case 'bisync':
        return {
          id: 'bisync',
          icon: 'right-left',
          tooltip: 'Start BiSync',
          isLoading: isActionInProgress,
          isDisabled: isActionInProgress,
          cssClass: 'purple',
        };
      default:
        return null;
    }
  }

  onActionButtonClick(action: { id: string; event: Event }): void {
    action.event.stopPropagation();
    const remoteName = this.remote().remoteSpecs.name;
    const remote = this.remote();

    switch (action.id) {
      case 'open':
      case 'browse':
        this.openInFiles.emit(remoteName);
        break;
      case 'mount':
        if (remote.mountState?.mounted) this.stopJob.emit({ type: 'mount', remoteName });
        else this.startJob.emit({ type: 'mount', remoteName });
        break;
      case 'sync':
        if (remote.syncState?.isOnSync) this.stopJob.emit({ type: 'sync', remoteName });
        else this.startJob.emit({ type: 'sync', remoteName });
        break;
      case 'copy':
        if (remote.copyState?.isOnCopy) this.stopJob.emit({ type: 'copy', remoteName });
        else this.startJob.emit({ type: 'copy', remoteName });
        break;
      case 'move':
        if (remote.moveState?.isOnMove) this.stopJob.emit({ type: 'move', remoteName });
        else this.startJob.emit({ type: 'move', remoteName });
        break;
      case 'bisync':
        if (remote.bisyncState?.isOnBisync) this.stopJob.emit({ type: 'bisync', remoteName });
        else this.startJob.emit({ type: 'bisync', remoteName });
        break;
      case 'serve':
        if (!remote.serveState?.isOnServe) this.startJob.emit({ type: 'serve', remoteName });
        break;
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

  cardVariant = computed<RemoteCardVariant>(() => {
    const mode = this.mode();
    const remote = this.remote();

    if (mode === 'general') {
      if (
        remote.mountState?.mounted ||
        remote.syncState?.isOnSync ||
        remote.copyState?.isOnCopy ||
        remote.moveState?.isOnMove ||
        remote.bisyncState?.isOnBisync
      ) {
        return 'active';
      }
    }
    if (mode === 'mount') {
      return remote.mountState?.mounted ? 'active' : 'inactive';
    }
    if (mode === 'sync') {
      return remote.syncState?.isOnSync ||
        remote.copyState?.isOnCopy ||
        remote.moveState?.isOnMove ||
        remote.bisyncState?.isOnBisync
        ? 'active'
        : 'inactive';
    }
    return 'inactive';
  });
}
