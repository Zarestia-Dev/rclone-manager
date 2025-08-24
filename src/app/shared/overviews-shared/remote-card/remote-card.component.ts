import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output, ChangeDetectionStrategy } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
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

// Services
import { IconService } from '../../services/icon.service';

// Variant moved to shared types

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
  @Input() primaryActions?: PrimaryActionType[] = [];
  @Input() maxGeneralButtons = 3;
  @Input() maxSyncButtons = 4;
  @Input() maxMountButtons = 1;

  @Output() remoteClick = new EventEmitter<Remote>();
  @Output() openInFiles = new EventEmitter<string>();
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
      // For mount mode, limit primary buttons to maxMountButtons and always show Browse last when mounted
      if (this.variant === 'active') {
        // Create primary buttons (though mount mode usually has only mount-related action)
        const primary = this.buildPrimaryActions(this.maxMountButtons, /*includeMount=*/ true);
        for (const a of primary) {
          const b = this.createOperationButton(a);
          if (b) buttons.push(b);
        }

        // Open/Browse button for mounted remotes (always last)
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
      } else if (this.variant === 'inactive') {
        // For inactive, show mount button as primary (respecting maxMountButtons)
        const primary = this.buildPrimaryActions(this.maxMountButtons, /*includeMount=*/ true);
        for (const a of primary) {
          const b = this.createOperationButton(a);
          if (b) buttons.push(b);
        }
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
      // For inactive remotes, show start buttons for available sync operations.
      // Build an ordered, deduplicated list of actions (exclude 'mount' here)
      const actionsToShow = this.buildPrimaryActions(this.maxSyncButtons, /*includeMount=*/ false);
      actionsToShow.forEach(actionType => {
        const button = this.createStartSyncOperationButton(actionType);
        if (button) buttons.push(button);
      });
    }

    return buttons;
  }

  private getDefaultPrimaryActions(): PrimaryActionType[] {
    // Return user's custom selection if available, otherwise use defaults
    if (this.primaryActions && this.primaryActions.length > 0 && this.mode === 'general') {
      return this.primaryActions;
    }

    // Default primary actions: Mount + Sync + BiSync (3 operations)
    // Note: Mount is handled separately, so we return sync operations only
    switch (this.mode) {
      case 'general':
        return ['mount', 'sync', 'bisync']; // Default for general tab
      case 'sync':
        return ['sync', 'bisync', 'copy', 'move']; // Sync-focused defaults
      case 'mount':
        return ['mount']; // Mount tab only shows one sync operation
      default:
        return ['mount', 'bisync'];
    }
  }

  private getGeneralActionButtons(): QuickActionButton[] {
    const buttons: QuickActionButton[] = [];

    // Build primary actions up to configured max for general
    const selectedActions = this.buildPrimaryActions(
      this.maxGeneralButtons,
      /*includeMount=*/ true
    );
    selectedActions.forEach((actionType: PrimaryActionType) => {
      const button = this.createOperationButton(actionType);
      if (button) buttons.push(button);
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

  /**
   * Build an ordered, deduplicated list of primary actions.
   * - Uses user-provided `primaryActions` when available, otherwise defaults.
   * - Fills up to `slotCount` items by appending defaults not already present.
   * - Optionally includes or excludes 'mount'.
   */
  private buildPrimaryActions(slotCount: number, includeMount = true): PrimaryActionType[] {
    const result: PrimaryActionType[] = [];

    const source =
      this.primaryActions && this.primaryActions.length > 0 && this.mode === 'general'
        ? [...this.primaryActions]
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
    const isActionInProgress = this.actionState === actionType || this.actionState === 'stop';

    switch (actionType) {
      case 'mount':
        return {
          id: 'mount',
          icon: this.remote.mountState?.mounted ? 'eject' : 'mount',
          tooltip: this.remote.mountState?.mounted ? 'Unmount' : 'Mount',
          color: this.remote.mountState?.mounted ? 'warn' : 'accent',
          isLoading: isActionInProgress,
          isDisabled: isActionInProgress,
          cssClass: this.remote.mountState?.mounted ? 'unmount-btn' : 'mount-btn',
        };

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

  private createStartSyncOperationButton(actionType: PrimaryActionType): QuickActionButton | null {
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

  onOpenInFiles(event: Event): void {
    event.stopPropagation();
    this.openInFiles.emit(this.remote.remoteSpecs.name);
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
}
