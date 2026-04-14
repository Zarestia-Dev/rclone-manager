import { NgClass } from '@angular/common';
import { Component, computed, input, output } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { RemoteCardComponent } from '../remote-card/remote-card.component';
import {
  ActionState,
  AppTab,
  PrimaryActionType,
  Remote,
  RemoteAction,
  RemoteActionProgress,
  CardDisplayMode,
} from '@app/types';

@Component({
  selector: 'app-remotes-panel',
  imports: [NgClass, MatCardModule, MatIconModule, RemoteCardComponent],
  templateUrl: './remotes-panel.component.html',
  styleUrl: './remotes-panel.component.scss',
})
export class RemotesPanelComponent {
  title = input('');
  icon = input('');
  remotes = input<Remote[]>([]);
  mode = input<AppTab>('general');
  displayMode = input<CardDisplayMode>('compact');
  actionInProgress = input<RemoteActionProgress>({});
  primaryActionLabel = input('Start');
  activeIcon = input('circle-check');

  remoteSelected = output<Remote>();
  openInFiles = output<{ remoteName: string; path?: string }>();
  startJob = output<{ type: PrimaryActionType; remoteName: string; profileName?: string }>();
  stopJob = output<{
    type: PrimaryActionType;
    remoteName: string;
    profileName?: string;
  }>();

  readonly count = computed(() => this.remotes().length);

  readonly hasActiveRemotes = computed(() =>
    this.remotes().some(remote => this.isRemoteActiveInCurrentMode(remote))
  );

  readonly panelClass = computed(() => ({
    'active-remotes-panel': this.hasActiveRemotes() || this.mode() === 'general',
  }));

  readonly iconClass = computed(() => (this.hasActiveRemotes() ? 'active-icon' : ''));

  getActionState(remoteName: string): RemoteAction | null {
    const actions = this.actionInProgress()[remoteName];
    return Array.isArray(actions) && actions.length > 0 ? actions[0].type : null;
  }

  getActionStates(remoteName: string): ActionState[] {
    const actions = this.actionInProgress()[remoteName];
    return Array.isArray(actions) ? actions : [];
  }

  private isRemoteActiveInCurrentMode(remote: Remote): boolean {
    switch (this.mode()) {
      case 'mount':
        return remote.status.mount.active;
      case 'sync':
        return (
          remote.status.sync.active ||
          remote.status.copy.active ||
          remote.status.move.active ||
          remote.status.bisync.active
        );
      case 'serve':
        return remote.status.serve.active;
      case 'general':
      default:
        return (
          remote.status.mount.active ||
          remote.status.sync.active ||
          remote.status.copy.active ||
          remote.status.move.active ||
          remote.status.bisync.active ||
          remote.status.serve.active
        );
    }
  }
}
