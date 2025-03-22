import { CommonModule } from "@angular/common";
import { Component, EventEmitter, Input, Output } from "@angular/core";
import { MatCardModule } from "@angular/material/card";
import { MatDividerModule } from "@angular/material/divider";

@Component({
  selector: "app-overview",
  imports: [MatCardModule, MatDividerModule, CommonModule],
  templateUrl: "./overview.component.html",
  styleUrl: "./overview.component.scss",
})
export class OverviewComponent {
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