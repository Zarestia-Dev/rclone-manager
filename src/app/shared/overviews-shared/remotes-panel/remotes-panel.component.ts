import { CommonModule } from '@angular/common';
import { Component, computed, EventEmitter, input, Output, inject } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { RemoteCardComponent } from '../remote-card/remote-card.component';
import { AppTab, PrimaryActionType, Remote, RemoteAction, RemoteActionProgress } from '@app/types';
import { IconService } from '../../services/icon.service';

@Component({
  selector: 'app-remotes-panel',
  standalone: true,
  imports: [CommonModule, MatCardModule, MatIconModule, RemoteCardComponent],
  templateUrl: './remotes-panel.component.html',
  styleUrl: './remotes-panel.component.scss',
})
export class RemotesPanelComponent {
  title = input('');
  icon = input('');
  remotes = input<Remote[]>([]);
  mode = input<AppTab>('general');
  actionInProgress = input<RemoteActionProgress>({});
  primaryActionLabel = input('Start');
  activeIcon = input('circle-check');
  primaryActions = input<PrimaryActionType[]>([]);

  @Output() remoteSelected = new EventEmitter<Remote>();
  @Output() openInFiles = new EventEmitter<string>();
  @Output() startJob = new EventEmitter<{ type: PrimaryActionType; remoteName: string }>();
  @Output() stopJob = new EventEmitter<{ type: PrimaryActionType; remoteName: string }>();

  readonly iconService = inject(IconService);

  count = computed(() => this.remotes().length);

  hasActiveRemotes = computed(() =>
    this.remotes().some(
      remote =>
        remote.mountState?.mounted || remote.syncState?.isOnSync || remote.copyState?.isOnCopy
    )
  );

  panelClass = computed(() =>
    this.hasActiveRemotes() ? 'active-remotes-panel' : 'inactive-remotes-panel'
  );

  iconClass = computed(() => (this.hasActiveRemotes() ? 'active-icon' : 'inactive-icon'));

  onRemoteSelected(remote: Remote): void {
    this.remoteSelected.emit(remote);
  }

  onOpenInFiles(remoteName: string): void {
    this.openInFiles.emit(remoteName);
  }

  getActionState(remoteName: string): RemoteAction | null {
    const actions = this.actionInProgress()[remoteName];
    if (Array.isArray(actions) && actions.length > 0) {
      return actions[0].type;
    }
    return null;
  }
}
