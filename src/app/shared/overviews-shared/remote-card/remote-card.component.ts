import { CommonModule } from '@angular/common';
import {
  Component,
  EventEmitter,
  Input,
  Output,
  ChangeDetectionStrategy,
  inject,
} from '@angular/core';
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
  @Input() mode: AppTab = 'general';
  @Input() actionState: RemoteAction = null;
  @Input() primaryActionLabel = 'Start';
  @Input() activeIcon = 'circle-check';
  @Input() primaryActions?: PrimaryActionType[] = [];
  @Input() maxGeneralButtons = 3;
  @Input() maxSyncButtons = 4;
  @Input() maxMountButtons = 1;

  @Output() remoteClick = new EventEmitter<Remote>();
  @Output() openInFiles = new EventEmitter<string>();
  @Output() startJob = new EventEmitter<{ type: PrimaryActionType; remoteName: string }>();
  @Output() stopJob = new EventEmitter<{ type: PrimaryActionType; remoteName: string }>();

  readonly iconService = inject(IconService);
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
      if (this.cardVariant() === 'active') {
        // Create primary buttons (though mount mode usually has only mount-related action)
        const primary = this.buildPrimaryActions(this.maxMountButtons, /*includeMount=*/ true);
        for (const a of primary) {
          const b = this.createOperationButton(a);
          if (b) buttons.push(b);
        }

        // Open/Browse button for mounted remotes (always last)
        if (this.showOpenButton()) {
          buttons.push({
            id: 'open',
            icon: 'folder',
            tooltip: 'Browse (B)',
            isLoading: this.isOpening,
            isDisabled: this.isOpening,
            cssClass: 'accent',
          });
        }
      } else if (this.cardVariant() === 'inactive') {
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

    if (this.mode === 'serve') {
      // For serve mode, show serve start button
      if (this.cardVariant() === 'inactive') {
        const serveButton = this.createOperationButton('serve');
        if (serveButton) buttons.push(serveButton);
      }
    }

    return buttons;
  }

  private getSyncModeActionButtons(): QuickActionButton[] {
    const buttons: QuickActionButton[] = [];

    if (this.cardVariant() === 'active') {
      // For active sync operations, show browse button if destination is local
      if (this.showOpenButton()) {
        buttons.push({
          id: 'open',
          icon: 'folder',
          tooltip: 'Browse Destination',
          isLoading: this.isOpening,
          isDisabled: this.isOpening,
          cssClass: 'accent',
        });
      }

      // Show stop buttons for currently active operations
      if (this.remote.syncState?.isOnSync) {
        buttons.push({
          id: 'sync',
          icon: 'stop',
          tooltip: 'Stop Sync',
          isLoading: this.actionState === 'stop',
          isDisabled: this.actionState === 'stop',
          cssClass: 'warn',
        });
      }

      if (this.remote.copyState?.isOnCopy) {
        buttons.push({
          id: 'copy',
          icon: 'stop',
          tooltip: 'Stop Copy',
          isLoading: this.actionState === 'stop',
          isDisabled: this.actionState === 'stop',
          cssClass: 'warn',
        });
      }

      if (this.remote.moveState?.isOnMove) {
        buttons.push({
          id: 'move',
          icon: 'stop',
          tooltip: 'Stop Move',
          isLoading: this.actionState === 'stop',
          isDisabled: this.actionState === 'stop',
          cssClass: 'warn',
        });
      }

      if (this.remote.bisyncState?.isOnBisync) {
        buttons.push({
          id: 'bisync',
          icon: 'stop',
          tooltip: 'Stop BiSync',
          isLoading: this.actionState === 'stop',
          isDisabled: this.actionState === 'stop',
          cssClass: 'warn',
        });
      }
    } else if (this.cardVariant() === 'inactive') {
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
      case 'serve':
        return ['serve']; // Serve tab shows serve operation
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
      isLoading: this.actionState === 'open',
      isDisabled: !this.remote.mountState?.mounted || this.actionState === 'open',
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
          isLoading: isActionInProgress,
          isDisabled: isActionInProgress,
          cssClass: this.remote.mountState?.mounted ? 'warn' : 'accent',
        };

      case 'sync':
        return {
          id: 'sync',
          icon: this.remote.syncState?.isOnSync ? 'stop' : 'refresh',
          tooltip: this.remote.syncState?.isOnSync ? 'Stop Sync' : 'Start Sync',
          isLoading: isActionInProgress && !!this.remote.syncState?.isOnSync,
          isDisabled: isActionInProgress,
          cssClass: this.remote.syncState?.isOnSync ? 'warn' : 'primary',
        };

      case 'copy':
        return {
          id: 'copy',
          icon: this.remote.copyState?.isOnCopy ? 'stop' : 'copy',
          tooltip: this.remote.copyState?.isOnCopy ? 'Stop Copy' : 'Start Copy',
          isLoading: isActionInProgress && !!this.remote.copyState?.isOnCopy,
          isDisabled: isActionInProgress,
          cssClass: this.remote.copyState?.isOnCopy ? 'warn' : 'yellow',
        };

      case 'move':
        return {
          id: 'move',
          icon: this.remote.moveState?.isOnMove ? 'stop' : 'move',
          tooltip: this.remote.moveState?.isOnMove ? 'Stop Move' : 'Start Move',
          isLoading: isActionInProgress && !!this.remote.moveState?.isOnMove,
          isDisabled: isActionInProgress,
          cssClass: this.remote.moveState?.isOnMove ? 'warn' : 'orange',
        };

      case 'bisync':
        return {
          id: 'bisync',
          icon: this.remote.bisyncState?.isOnBisync ? 'stop' : 'right-left',
          tooltip: this.remote.bisyncState?.isOnBisync ? 'Stop BiSync' : 'Start BiSync',
          isLoading: isActionInProgress && !!this.remote.bisyncState?.isOnBisync,
          isDisabled: isActionInProgress,
          cssClass: this.remote.bisyncState?.isOnBisync ? 'warn' : 'purple',
        };

      case 'serve':
        return {
          id: 'serve',
          icon: this.remote.serveState?.hasActiveServes ? 'stop' : 'satellite-dish',
          tooltip: this.remote.serveState?.hasActiveServes ? 'Stop Serve' : 'Start Serve',
          isLoading: isActionInProgress,
          isDisabled: isActionInProgress,
          cssClass: this.remote.serveState?.hasActiveServes ? 'warn' : 'primary',
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
    const remoteName = this.remote.remoteSpecs.name;

    switch (action.id) {
      case 'open':
      case 'browse': // 'browse' is also used in getGeneralActionButtons
        this.openInFiles.emit(remoteName);
        break;
      case 'mount':
        if (this.remote.mountState?.mounted) {
          this.stopJob.emit({ type: 'mount', remoteName });
        } else {
          this.startJob.emit({ type: 'mount', remoteName });
        }
        break;
      case 'sync':
        if (this.remote.syncState?.isOnSync) {
          this.stopJob.emit({ type: 'sync', remoteName });
        } else {
          this.startJob.emit({ type: 'sync', remoteName });
        }
        break;
      case 'copy':
        if (this.remote.copyState?.isOnCopy) {
          this.stopJob.emit({ type: 'copy', remoteName });
        } else {
          this.startJob.emit({ type: 'copy', remoteName });
        }
        break;
      case 'move':
        if (this.remote.moveState?.isOnMove) {
          this.stopJob.emit({ type: 'move', remoteName });
        } else {
          this.startJob.emit({ type: 'move', remoteName });
        }
        break;
      case 'bisync':
        if (this.remote.bisyncState?.isOnBisync) {
          this.stopJob.emit({ type: 'bisync', remoteName });
        } else {
          this.startJob.emit({ type: 'bisync', remoteName });
        }
        break;
      case 'serve':
        if (!this.remote.serveState?.hasActiveServes) {
          this.startJob.emit({ type: 'serve', remoteName });
        }
        break;
    }
  }

  get remoteCardClasses(): Record<string, boolean> {
    return {
      [`${this.cardVariant()}-remote`]: true,
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

  showOpenButton(): boolean {
    if (this.mode === 'mount') return true;
    if (this.mode === 'sync') {
      return (
        this.remote.syncState?.isLocal ||
        this.remote.copyState?.isLocal ||
        this.remote.moveState?.isLocal ||
        this.remote.bisyncState?.isLocal ||
        false
      );
    }
    if (this.mode === 'general') return this.remote.mountState?.mounted === true;
    return false;
  }

  cardVariant(): RemoteCardVariant {
    // For general mode, determine variant based on remote state
    if (this.mode === 'general') {
      // Check if remote has any active operations
      if (
        this.remote.mountState?.mounted === true ||
        this.remote.syncState?.isOnSync === true ||
        this.remote.copyState?.isOnCopy === true ||
        this.remote.moveState?.isOnMove === true ||
        this.remote.bisyncState?.isOnBisync === true
      ) {
        return 'active';
      }
    }
    if (this.mode === 'mount') {
      return this.remote.mountState?.mounted === true ? 'active' : 'inactive';
    } else if (this.mode === 'sync') {
      return this.remote.syncState?.isOnSync === true ||
        this.remote.copyState?.isOnCopy === true ||
        this.remote.moveState?.isOnMove === true ||
        this.remote.bisyncState?.isOnBisync === true
        ? 'active'
        : 'inactive';
    } else {
      return 'inactive';
    }
  }
}
