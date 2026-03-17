import { NgClass } from '@angular/common';
import { Component, computed, input, output } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { RemoteCardComponent } from '../remote-card/remote-card.component';
import { AppTab, PrimaryActionType, Remote, RemoteAction, RemoteActionProgress } from '@app/types';

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
  actionInProgress = input<RemoteActionProgress>({});
  primaryActionLabel = input('Start');
  activeIcon = input('circle-check');

  remoteSelected = output<Remote>();
  openInFiles = output<string>();
  startJob = output<{ type: PrimaryActionType; remoteName: string }>();
  stopJob = output<{
    type: PrimaryActionType;
    remoteName: string;
    profileName?: string;
  }>();

  readonly count = computed(() => this.remotes().length);

  readonly hasActiveRemotes = computed(() =>
    this.remotes().some(
      remote =>
        remote.status.mount.active ||
        remote.status.sync.active ||
        remote.status.copy.active ||
        remote.status.move.active ||
        remote.status.bisync.active ||
        remote.status.serve.active
    )
  );

  readonly panelClass = computed(() =>
    this.hasActiveRemotes() ? 'active-remotes-panel' : 'inactive-remotes-panel'
  );

  readonly iconClass = computed(() => (this.hasActiveRemotes() ? 'active-icon' : 'inactive-icon'));

  getActionState(remoteName: string): RemoteAction | null {
    const actions = this.actionInProgress()[remoteName];
    return Array.isArray(actions) && actions.length > 0 ? actions[0].type : null;
  }
}
