import { CommonModule } from "@angular/common";
import { Component, EventEmitter, Input, Output, ChangeDetectionStrategy } from "@angular/core";
import { MatButtonModule } from "@angular/material/button";
import { MatCardModule } from "@angular/material/card";
import { MatDividerModule } from "@angular/material/divider";
import { MatIconModule } from "@angular/material/icon";
import { MatProgressSpinnerModule } from "@angular/material/progress-spinner";
import { MatTooltipModule } from "@angular/material/tooltip";

export type RemoteAction = 'mount' | 'unmount' | 'open' | null;

export interface RemoteActionProgress {
  [remoteName: string]: RemoteAction;
}

export interface RemoteDiskUsage {
  total_space?: string;
  used_space?: string;
  free_space?: string;
}

export interface RemoteSpecs {
  name: string;
  type: string;
  [key: string]: any;
}

export interface DiskUsage {
  total_space: string;
  used_space: string;
  free_space: string;
  loading?: boolean;
  error?: boolean;
}

export interface Remote {
  remoteSpecs: RemoteSpecs;
  mounted: boolean | "error";
  diskUsage: DiskUsage;
}

export interface RemoteSettings {
  [key: string]: { [key: string]: any };
}


@Component({
  selector: "app-mount-overview",
  standalone: true,
  imports: [
    MatCardModule,
    MatDividerModule,
    CommonModule,
    MatIconModule,
    MatTooltipModule,
    MatProgressSpinnerModule,
    MatButtonModule
  ],
  templateUrl: "./mount-overview.component.html",
  styleUrls: ["./mount-overview.component.scss"],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class MountOverviewComponent {
  @Input() remotes: Remote[] = [];
  @Input() selectedRemote: Remote | null = null;
  @Input() iconService: any; // Consider creating an interface for this
  @Input() actionInProgress: RemoteActionProgress = {};
  
  @Output() remoteSelected = new EventEmitter<Remote>();
  @Output() openInFiles = new EventEmitter<string>();
  @Output() mountRemote = new EventEmitter<string>();

  // Computed properties for better performance
  get mountedRemotes(): Remote[] {
    return this.remotes.filter(remote => remote.mounted === true);
  }

  get unmountedRemotes(): Remote[] {
    return this.remotes.filter(remote => !remote.mounted);
  }

  get errorRemotes(): Remote[] {
    return this.remotes.filter(remote => remote.mounted === "error");
  }

  get mountedCount(): number {
    return this.mountedRemotes.length;
  }
  get unmountedCount(): number {
    return this.unmountedRemotes.length;
  }
  get errorCount(): number {
    return this.errorRemotes.length;
  }

  selectRemote(remote: Remote): void {
    this.remoteSelected.emit(remote);
  }

  openRemoteInFiles(remoteName: string): void {
    if (remoteName) {
      this.openInFiles.emit(remoteName);
    }
  }

  mountRemoteByFs(remoteName: string): void {
    if (remoteName) {
      this.mountRemote.emit(remoteName);
    }
  }

  // Helper to get action state safely
  getActionState(remoteName: string | undefined): RemoteAction {
    return remoteName ? this.actionInProgress[remoteName] : null;
  }
}