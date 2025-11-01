import { CommonModule } from '@angular/common';
import {
  Component,
  EventEmitter,
  Input,
  Output,
  ChangeDetectionStrategy,
  inject,
} from '@angular/core';
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
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RemotesPanelComponent {
  @Input() title = '';
  @Input() icon = '';
  @Input() remotes: Remote[] = [];
  @Input() mode: AppTab = 'general';
  @Input() actionInProgress: RemoteActionProgress = {};
  @Input() primaryActionLabel = 'Start';
  @Input() activeIcon = 'circle-check';

  @Output() remoteSelected = new EventEmitter<Remote>();
  @Output() openInFiles = new EventEmitter<string>();
  @Output() startJob = new EventEmitter<{ type: PrimaryActionType; remoteName: string }>();
  @Output() stopJob = new EventEmitter<{ type: PrimaryActionType; remoteName: string }>();

  readonly iconService = inject(IconService);

  get count(): number {
    return this.remotes.length;
  }

  get hasActiveRemotes(): boolean {
    return this.remotes.some(
      remote =>
        remote.mountState?.mounted || remote.syncState?.isOnSync || remote.copyState?.isOnCopy
    );
  }

  get panelClass(): string {
    return this.hasActiveRemotes ? 'active-remotes-panel' : 'inactive-remotes-panel';
  }

  get iconClass(): string {
    return this.hasActiveRemotes ? 'active-icon' : 'inactive-icon';
  }

  onRemoteSelected(remote: Remote): void {
    this.remoteSelected.emit(remote);
  }

  onOpenInFiles(remoteName: string): void {
    this.openInFiles.emit(remoteName);
  }

  getActionState(remoteName: string): RemoteAction | null {
    return this.actionInProgress[remoteName] || null;
  }
}
