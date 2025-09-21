import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output, ChangeDetectionStrategy } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { RemoteCardComponent } from '../remote-card/remote-card.component';
import {
  AppTab,
  PrimaryActionType,
  Remote,
  RemoteActionProgress,
  RemoteCardVariant,
} from '@app/types';

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
  @Output() startJob = new EventEmitter<{ type: PrimaryActionType; remoteName: string }>();
  @Output() stopJob = new EventEmitter<{ type: PrimaryActionType; remoteName: string }>();

  get count(): number {
    return this.remotes.length;
  }

  onRemoteSelected(remote: Remote): void {
    this.remoteSelected.emit(remote);
  }

  onOpenInFiles(remoteName: string): void {
    this.openInFiles.emit(remoteName);
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

      return 'inactive';
    }

    // For specific modes, use the provided variant
    return this.variant;
  }
}
