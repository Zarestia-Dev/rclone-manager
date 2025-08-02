import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output, ChangeDetectionStrategy } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule, MatMenuTrigger } from '@angular/material/menu';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { QuickActionButton, QuickActionButtonsComponent } from '../../../shared/components';
import {
  AppTab,
  Remote,
  RemoteAction,
  SyncOperationType,
  RemotePrimaryActions,
} from '../../../shared/components/types';

// Services
import { IconService } from '../../services/icon.service';

export type RemoteCardVariant = 'active' | 'inactive' | 'error';

@Component({
  selector: 'app-remote-card',
  standalone: true,
  imports: [
    CommonModule,
    MatCardModule,
    MatIconModule,
    MatButtonModule,
    MatDividerModule,
    MatMenuModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    QuickActionButtonsComponent,
  ],
  templateUrl: './remote-card.component.html',
  styleUrl: './remote-card.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RemoteCardComponent {
  @Input() remote!: Remote;
  @Input() variant: RemoteCardVariant = 'inactive';
  @Input() mode: AppTab = 'general';
  @Input() iconService!: IconService;
  @Input() actionState: RemoteAction = null;
  @Input() showOpenButton = false;
  @Input() primaryActionLabel = 'Start';
  @Input() activeIcon = 'circle-check';
  @Input() primaryActions: SyncOperationType[] = []; // Will be set by getDefaultPrimaryActions()
  @Input() userSelectedPrimaryActions?: SyncOperationType[]; // User's custom selection

  @Output() remoteClick = new EventEmitter<Remote>();
  @Output() openInFiles = new EventEmitter<string>();
  @Output() primaryAction = new EventEmitter<string>();
  @Output() secondaryAction = new EventEmitter<string>();
  @Output() mountAction = new EventEmitter<string>();
  @Output() unmountAction = new EventEmitter<string>();
  @Output() syncAction = new EventEmitter<string>();
  @Output() copyAction = new EventEmitter<string>();
  @Output() stopSyncAction = new EventEmitter<string>();
  @Output() stopCopyAction = new EventEmitter<string>();
  @Output() moveAction = new EventEmitter<string>();
  @Output() bisyncAction = new EventEmitter<string>();
  @Output() stopMoveAction = new EventEmitter<string>();
  @Output() stopBisyncAction = new EventEmitter<string>();
  @Output() configurePrimaryActions = new EventEmitter<RemotePrimaryActions>();

  get isOpening(): boolean {
    return this.actionState === 'open';
  }

  get isStopping(): boolean {
    return this.actionState === 'stop';
  }

  get isLoading(): boolean {
    return this.actionState === this.mode;
  }

  get primaryActionIcon(): string {
    return this.mode === 'mount' ? 'mount' : 'play';
  }

  get secondaryActionIcon(): string {
    return this.mode === 'mount' ? 'eject' : 'stop';
  }

  get secondaryActionTooltip(): string {
    if (this.mode === 'mount') return 'Unmount';
    if (this.mode === 'sync') return 'Stop Sync';
    return 'Stop';
  }

  getActionButtons(): QuickActionButton[] {
    const buttons: QuickActionButton[] = [];

    // General mode shows configurable primary operations (for general-overview)
    if (this.mode === 'general') {
      return this.getGeneralActionButtons();
    }

    // Mount mode - simple mount/unmount logic
    if (this.mode === 'mount') {
      if (this.variant === 'active') {
        // Open/Browse button for mounted remotes
        if (this.showOpenButton) {
          buttons.push({
            id: 'open',
            icon: 'folder',
            tooltip: 'Browse (B)',
            color: 'accent',
            isLoading: this.isOpening,
            isDisabled: this.isOpening,
            cssClass: 'browse-btn',
          });
        }

        // Unmount button
        buttons.push({
          id: 'secondary',
          icon: 'eject',
          tooltip: 'Unmount',
          color: 'warn',
          isLoading: this.isStopping,
          isDisabled: this.isStopping,
          cssClass: 'stop-btn',
        });
      } else if (this.variant === 'inactive') {
        // Mount button for unmounted remotes
        buttons.push({
          id: 'primary',
          icon: 'mount',
          tooltip: this.primaryActionLabel,
          color: 'accent',
          isLoading: this.isLoading,
          isDisabled: this.isLoading,
          cssClass: 'mount-btn',
        });
      }
      return buttons;
    }

    // Sync mode - handle all sync operations
    if (this.mode === 'sync') {
      return this.getSyncModeActionButtons();
    }

    return buttons;
  }

  private getSyncModeActionButtons(): QuickActionButton[] {
    const buttons: QuickActionButton[] = [];

    if (this.variant === 'active') {
      // For active sync operations, show browse button if destination is local
      if (this.showOpenButton) {
        buttons.push({
          id: 'open',
          icon: 'folder',
          tooltip: 'Browse Destination',
          color: 'accent',
          isLoading: this.isOpening,
          isDisabled: this.isOpening,
          cssClass: 'browse-btn',
        });
      }

      // Show stop buttons for currently active operations
      if (this.remote.syncState?.isOnSync) {
        buttons.push({
          id: 'sync',
          icon: 'stop',
          tooltip: 'Stop Sync',
          color: 'warn',
          isLoading: this.actionState === 'stop',
          isDisabled: this.actionState === 'stop',
          cssClass: 'stop-btn',
        });
      }

      if (this.remote.copyState?.isOnCopy) {
        buttons.push({
          id: 'copy',
          icon: 'stop',
          tooltip: 'Stop Copy',
          color: 'warn',
          isLoading: this.actionState === 'stop',
          isDisabled: this.actionState === 'stop',
          cssClass: 'stop-btn',
        });
      }

      if (this.remote.moveState?.isOnMove) {
        buttons.push({
          id: 'move',
          icon: 'stop',
          tooltip: 'Stop Move',
          color: 'warn',
          isLoading: this.actionState === 'stop',
          isDisabled: this.actionState === 'stop',
          cssClass: 'stop-btn',
        });
      }

      if (this.remote.bisyncState?.isOnBisync) {
        buttons.push({
          id: 'bisync',
          icon: 'stop',
          tooltip: 'Stop BiSync',
          color: 'warn',
          isLoading: this.actionState === 'stop',
          isDisabled: this.actionState === 'stop',
          cssClass: 'stop-btn',
        });
      }
    } else if (this.variant === 'inactive') {
      // For inactive remotes, show start buttons for available sync operations
      const primaryActionsToShow =
        this.primaryActions.length > 0 ? this.primaryActions : this.getDefaultPrimaryActions();

      primaryActionsToShow.forEach(actionType => {
        const button = this.createStartSyncOperationButton(actionType);
        if (button) {
          buttons.push(button);
        }
      });
    }

    return buttons;
  }

  private getDefaultPrimaryActions(): SyncOperationType[] {
    // Return user's custom selection if available, otherwise use defaults
    if (this.userSelectedPrimaryActions && this.userSelectedPrimaryActions.length > 0) {
      return this.userSelectedPrimaryActions;
    }

    // Default primary actions: Mount + Sync + BiSync (3 operations)
    // Note: Mount is handled separately, so we return sync operations only
    switch (this.mode) {
      case 'general':
        return ['sync', 'bisync']; // Default for general tab
      case 'sync':
        return ['sync', 'bisync', 'copy', 'move']; // Sync-focused defaults
      case 'mount':
        return ['sync']; // Mount tab only shows one sync operation
      default:
        return ['sync', 'bisync'];
    }
  }

  private getGeneralActionButtons(): QuickActionButton[] {
    const buttons: QuickActionButton[] = [];

    // Always show Mount/Unmount Button first
    const isMountAction = this.actionState === 'mount' || this.actionState === 'unmount';
    buttons.push({
      id: 'mount',
      icon: this.remote.mountState?.mounted ? 'eject' : 'mount',
      tooltip: this.remote.mountState?.mounted ? 'Unmount' : 'Mount',
      color: this.remote.mountState?.mounted ? 'warn' : 'accent',
      isLoading: isMountAction,
      isDisabled: isMountAction,
      cssClass: this.remote.mountState?.mounted ? 'unmount-btn' : 'mount-btn',
    });

    // Get the primary actions to show (user selection or defaults)
    const primaryActionsToShow = this.getDefaultPrimaryActions();

    // Add primary sync operations based on configuration (limit to 3)
    primaryActionsToShow.slice(0, 3).forEach(actionType => {
      const button = this.createSyncOperationButton(actionType);
      if (button) {
        buttons.push(button);
      }
    });

    // Always show Browse Button last
    buttons.push({
      id: 'browse',
      icon: 'folder',
      tooltip: 'Browse',
      color: 'accent',
      isLoading: this.actionState === 'open',
      isDisabled: !this.remote.mountState?.mounted || this.actionState === 'open',
      cssClass: 'browse-btn',
    });

    return buttons;
  }

  private createSyncOperationButton(actionType: SyncOperationType): QuickActionButton | null {
    const isActionInProgress = this.actionState === actionType || this.actionState === 'stop';

    switch (actionType) {
      case 'sync':
        return {
          id: 'sync',
          icon: this.remote.syncState?.isOnSync ? 'stop' : 'refresh',
          tooltip: this.remote.syncState?.isOnSync ? 'Stop Sync' : 'Start Sync',
          color: this.remote.syncState?.isOnSync ? 'warn' : 'primary',
          isLoading: isActionInProgress && !!this.remote.syncState?.isOnSync,
          isDisabled: isActionInProgress,
          cssClass: this.remote.syncState?.isOnSync ? 'stop-btn' : 'sync-btn',
        };

      case 'copy':
        return {
          id: 'copy',
          icon: this.remote.copyState?.isOnCopy ? 'stop' : 'copy',
          tooltip: this.remote.copyState?.isOnCopy ? 'Stop Copy' : 'Start Copy',
          color: this.remote.copyState?.isOnCopy ? 'warn' : undefined,
          isLoading: isActionInProgress && !!this.remote.copyState?.isOnCopy,
          isDisabled: isActionInProgress,
          cssClass: this.remote.copyState?.isOnCopy ? 'stop-btn' : 'copy-btn',
        };

      case 'move':
        return {
          id: 'move',
          icon: this.remote.moveState?.isOnMove ? 'stop' : 'move',
          tooltip: this.remote.moveState?.isOnMove ? 'Stop Move' : 'Start Move',
          color: this.remote.moveState?.isOnMove ? 'warn' : 'warn',
          isLoading: isActionInProgress && !!this.remote.moveState?.isOnMove,
          isDisabled: isActionInProgress,
          cssClass: this.remote.moveState?.isOnMove ? 'stop-btn' : 'move-btn',
        };

      case 'bisync':
        return {
          id: 'bisync',
          icon: this.remote.bisyncState?.isOnBisync ? 'stop' : 'right-left',
          tooltip: this.remote.bisyncState?.isOnBisync ? 'Stop BiSync' : 'Start BiSync',
          color: this.remote.bisyncState?.isOnBisync ? 'warn' : 'accent',
          isLoading: isActionInProgress && !!this.remote.bisyncState?.isOnBisync,
          isDisabled: isActionInProgress,
          cssClass: this.remote.bisyncState?.isOnBisync ? 'stop-btn' : 'bisync-btn',
        };

      default:
        return null;
    }
  }

  private createStartSyncOperationButton(actionType: SyncOperationType): QuickActionButton | null {
    const isActionInProgress = this.actionState === actionType;

    switch (actionType) {
      case 'sync':
        return {
          id: 'sync',
          icon: 'refresh',
          tooltip: 'Start Sync',
          color: 'primary',
          isLoading: isActionInProgress,
          isDisabled: isActionInProgress,
          cssClass: 'sync-btn',
        };

      case 'copy':
        return {
          id: 'copy',
          icon: 'copy',
          tooltip: 'Start Copy',
          color: undefined,
          isLoading: isActionInProgress,
          isDisabled: isActionInProgress,
          cssClass: 'copy-btn',
        };

      case 'move':
        return {
          id: 'move',
          icon: 'move',
          tooltip: 'Start Move',
          color: 'warn',
          isLoading: isActionInProgress,
          isDisabled: isActionInProgress,
          cssClass: 'move-btn',
        };

      case 'bisync':
        return {
          id: 'bisync',
          icon: 'right-left',
          tooltip: 'Start BiSync',
          color: 'accent',
          isLoading: isActionInProgress,
          isDisabled: isActionInProgress,
          cssClass: 'bisync-btn',
        };

      default:
        return null;
    }
  }

  onActionButtonClick(action: { id: string; event: Event }): void {
    action.event.stopPropagation();

    switch (action.id) {
      case 'open':
        this.onOpenInFiles(action.event);
        break;
      case 'primary':
        this.onPrimaryAction(action.event);
        break;
      case 'secondary':
        this.onSecondaryAction(action.event);
        break;
      case 'mount':
        // Handle mount/unmount based on current state
        if (this.remote.mountState?.mounted) {
          this.onUnmountAction(action.event); // unmount
        } else {
          this.onMountAction(action.event); // mount
        }
        break;
      case 'sync':
        // Handle sync/stop-sync based on current state
        if (this.remote.syncState?.isOnSync) {
          this.onStopSyncAction(action.event); // stop-sync
        } else {
          this.onSyncAction(action.event); // sync
        }
        break;
      case 'copy':
        // Handle copy/stop-copy based on current state
        if (this.remote.copyState?.isOnCopy) {
          this.onStopCopyAction(action.event); // stop-copy
        } else {
          this.onCopyAction(action.event); // copy
        }
        break;
      case 'move':
        // Handle move/stop-move based on current state
        if (this.remote.moveState?.isOnMove) {
          this.onStopMoveAction(action.event); // stop-move
        } else {
          this.onMoveAction(action.event); // move
        }
        break;
      case 'bisync':
        // Handle bisync/stop-bisync based on current state
        if (this.remote.bisyncState?.isOnBisync) {
          this.onStopBisyncAction(action.event); // stop-bisync
        } else {
          this.onBisyncAction(action.event); // bisync
        }
        break;
      case 'browse':
        this.onBrowseAction(action.event);
        break;
      case 'fix':
        // Handle fix action
        break;
    }
  }

  get remoteCardClasses(): Record<string, boolean> {
    return {
      [`${this.variant}-remote`]: true,
      mounted: !!this.remote.mountState?.mounted,
      syncing: !!this.remote.syncState?.isOnSync,
      copying: !!this.remote.copyState?.isOnCopy,
      moving: !!this.remote.moveState?.isOnMove,
      bisyncing: !!this.remote.bisyncState?.isOnBisync,
    };
  }

  onRemoteClick(): void {
    this.remoteClick.emit(this.remote);
  }

  onRightClick(event: MouseEvent, trigger: MatMenuTrigger): void {
    event.preventDefault();
    event.stopPropagation();
    trigger.openMenu();

    // Close the menu when user scrolls or clicks elsewhere
    const closeMenu = (): void => {
      trigger.closeMenu();
      window.removeEventListener('scroll', closeMenu, true);
      document.removeEventListener('click', closeMenu, true);
    };

    window.addEventListener('scroll', closeMenu, true);
    document.addEventListener('click', closeMenu, true);
  }

  onOpenInFiles(event: Event): void {
    event.stopPropagation();
    this.openInFiles.emit(this.remote.remoteSpecs.name);
  }

  onPrimaryAction(event: Event): void {
    event.stopPropagation();
    this.primaryAction.emit(this.remote.remoteSpecs.name);
  }

  onSecondaryAction(event: Event): void {
    event.stopPropagation();
    this.secondaryAction.emit(this.remote.remoteSpecs.name);
  }

  onMountAction(event: Event): void {
    event.stopPropagation();
    this.mountAction.emit(this.remote.remoteSpecs.name);
  }

  onSyncAction(event: Event): void {
    event.stopPropagation();
    this.syncAction.emit(this.remote.remoteSpecs.name);
  }

  onCopyAction(event: Event): void {
    event.stopPropagation();
    this.copyAction.emit(this.remote.remoteSpecs.name);
  }

  onBrowseAction(event: Event): void {
    event.stopPropagation();
    this.openInFiles.emit(this.remote.remoteSpecs.name);
  }

  onUnmountAction(event: Event): void {
    event.stopPropagation();
    this.unmountAction.emit(this.remote.remoteSpecs.name);
  }

  onStopSyncAction(event: Event): void {
    event.stopPropagation();
    this.stopSyncAction.emit(this.remote.remoteSpecs.name);
  }

  onStopCopyAction(event: Event): void {
    event.stopPropagation();
    this.stopCopyAction.emit(this.remote.remoteSpecs.name);
  }

  onMoveAction(event: Event): void {
    event.stopPropagation();
    this.moveAction.emit(this.remote.remoteSpecs.name);
  }

  onStopMoveAction(event: Event): void {
    event.stopPropagation();
    this.stopMoveAction.emit(this.remote.remoteSpecs.name);
  }

  onBisyncAction(event: Event): void {
    event.stopPropagation();
    this.bisyncAction.emit(this.remote.remoteSpecs.name);
  }

  onStopBisyncAction(event: Event): void {
    event.stopPropagation();
    this.stopBisyncAction.emit(this.remote.remoteSpecs.name);
  }

  // onConfigurePrimaryActions(event: Event): void {
  //   event.stopPropagation();

  //   // Emit configuration event with current state and available options
  //   this.configurePrimaryActions.emit({
  //     remoteName: this.remote.remoteSpecs.name,
  //     actions: this.getDefaultPrimaryActions(),
  //     availableActions: ['sync', 'copy', 'move', 'bisync'] as SyncOperationType[],
  //     currentDefaults: this.getDefaultPrimaryActions()
  //   });
  // }
}
