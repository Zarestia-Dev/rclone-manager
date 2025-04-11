import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

@Component({
  selector: 'app-mount-overview',
  imports: [MatCardModule, MatDividerModule, CommonModule, MatIconModule, MatTooltipModule],
  templateUrl: './mount-overview.component.html',
  styleUrl: './mount-overview.component.scss'
})
export class MountOverviewComponent {

  @Input() remotes: any[] = [];
  @Input() selectedRemote: any = null;
  @Output() remoteSelected = new EventEmitter<any>();
  @Output() openInFiles = new EventEmitter<string>();
  @Output() mountRemote = new EventEmitter<string>();

  selectRemote(remote: any) {
    this.remoteSelected.emit(remote);
  }

  openRemoteInFiles(remoteName: string) {
    this.openInFiles.emit(remoteName);
  }

  mountRemoteByFs(remoteName: string) {
    this.mountRemote.emit(remoteName);
  }

  /** ✅ Cached computed properties */
  get mountedRemotes() {
    return this.remotes.filter(remote => remote.mounted);
  }

  get unmountedRemotes() {
    return this.remotes.filter(remote => !remote.mounted);
  }

  get errorRemotes() {
    return this.remotes.filter(remote => remote.mounted === 'error');
  }

  get mountedCount() {
    return this.mountedRemotes.length;
  }

  get unmountedCount() {
    return this.unmountedRemotes.length;
  }

  get errorCount() {
    return this.errorRemotes.length;
  }
}