import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output, ChangeDetectionStrategy } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { RemoteCardComponent, RemoteCardVariant } from '../remote-card/remote-card.component';
import { AppTab, Remote, RemoteActionProgress, RemotePrimaryActions } from '../../components/types';

@Component({
  selector: 'app-remotes-panel',
  standalone: true,
  imports: [CommonModule, MatCardModule, MatIconModule, RemoteCardComponent],
  templateUrl: './remotes-panel.component.html',
  styleUrl: './remotes-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RemotesPanelComponent {
  @Input() title = '';
  @Input() icon = '';
  @Input() remotes: Remote[] = [];
  @Input() variant: RemoteCardVariant = 'inactive';
  @Input() mode: AppTab = 'general';
  @Input() iconService: any;
  @Input() actionInProgress: RemoteActionProgress = {};
  @Input() primaryActionLabel = 'Start';
  @Input() activeIcon = 'circle-check';

  @Output() remoteSelected = new EventEmitter<Remote>();
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

  get count(): number {
    return this.remotes.length;
  }

  onRemoteSelected(remote: Remote): void {
    this.remoteSelected.emit(remote);
  }

  onOpenInFiles(remoteName: string): void {
    this.openInFiles.emit(remoteName);
  }

  onPrimaryAction(remoteName: string): void {
    this.primaryAction.emit(remoteName);
  }

  onSecondaryAction(remoteName: string): void {
    this.secondaryAction.emit(remoteName);
  }

  onMountAction(remoteName: string): void {
    this.mountAction.emit(remoteName);
  }

  onUnmountAction(remoteName: string): void {
    this.unmountAction.emit(remoteName);
  }

  onSyncAction(remoteName: string): void {
    this.syncAction.emit(remoteName);
  }

  onCopyAction(remoteName: string): void {
    this.copyAction.emit(remoteName);
  }

  onStopSyncAction(remoteName: string): void {
    this.stopSyncAction.emit(remoteName);
  }

  onStopCopyAction(remoteName: string): void {
    this.stopCopyAction.emit(remoteName);
  }

  onMoveAction(remoteName: string): void {
    this.moveAction.emit(remoteName);
  }

  onStopMoveAction(remoteName: string): void {
    this.stopMoveAction.emit(remoteName);
  }

  onBisyncAction(remoteName: string): void {
    this.bisyncAction.emit(remoteName);
  }

  onStopBisyncAction(remoteName: string): void {
    this.stopBisyncAction.emit(remoteName);
  }

  onConfigurePrimaryActions(config: RemotePrimaryActions): void {
    this.configurePrimaryActions.emit(config);
  }

  getActionState(remoteName: string): any {
    return this.actionInProgress[remoteName] || null;
  }

  shouldShowOpenButton(remote: Remote): boolean {
    if (this.mode === 'mount') return true;
    if (this.mode === 'sync') {
      return (
        remote.syncState?.isLocal ||
        remote.copyState?.isLocal ||
        remote.moveState?.isLocal ||
        remote.bisyncState?.isLocal ||
        false
      );
    }
    if (this.mode === 'general') return remote.mountState?.mounted === true;
    return false;
  }

  getCardVariant(remote: Remote): RemoteCardVariant {
    // For general mode, determine variant based on remote state
    if (this.mode === 'general') {
      // Check if remote has any active operations
      if (
        remote.mountState?.mounted === true ||
        remote.syncState?.isOnSync === true ||
        remote.copyState?.isOnCopy === true ||
        remote.moveState?.isOnMove === true ||
        remote.bisyncState?.isOnBisync === true
      ) {
        return 'active';
      }

      // Check for error states
      if (
        remote.mountState?.mounted === 'error' ||
        remote.syncState?.isOnSync === 'error' ||
        remote.copyState?.isOnCopy === 'error' ||
        remote.moveState?.isOnMove === 'error' ||
        remote.bisyncState?.isOnBisync === 'error'
      ) {
        return 'error';
      }

      return 'inactive';
    }

    // For specific modes, use the provided variant
    return this.variant;
  }
}
