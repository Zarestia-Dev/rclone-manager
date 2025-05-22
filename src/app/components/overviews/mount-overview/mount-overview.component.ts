import { CommonModule } from "@angular/common";
import {
  Component,
  EventEmitter,
  Input,
  Output,
  ChangeDetectionStrategy,
} from "@angular/core";
import { MatButtonModule } from "@angular/material/button";
import { MatCardModule } from "@angular/material/card";
import { MatDividerModule } from "@angular/material/divider";
import { MatIconModule } from "@angular/material/icon";
import { MatProgressSpinnerModule } from "@angular/material/progress-spinner";
import { MatTooltipModule } from "@angular/material/tooltip";

export type RemoteAction =
  | "mount"
  | "unmount"
  | "sync"
  | "stop"
  | "open"
  | null;

export interface RemoteActionProgress {
  [remoteName: string]: RemoteAction;
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
  notSupported?: boolean;
}

export interface Remote {
  remoteSpecs: RemoteSpecs;
  mounted?: boolean | "error";
  diskUsage?: DiskUsage;
  isOnSync?: boolean | "error";
  syncJobID?: number;
}

export interface RemoteSettings {
  [key: string]: { [key: string]: any };
}

export type AppTab = "mount" | "sync" | "copy" | "jobs";

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
    MatButtonModule,
  ],
  templateUrl: "./mount-overview.component.html",
  styleUrls: ["./mount-overview.component.scss"],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MountOverviewComponent {
  @Input() mode: AppTab = "mount";
  @Input() remotes: Remote[] = [];
  @Input() selectedRemote: Remote | null = null;
  @Input() iconService: any;
  @Input() actionInProgress: RemoteActionProgress = {};

  @Output() remoteSelected = new EventEmitter<Remote>();
  @Output() openInFiles = new EventEmitter<string>();
  @Output() primaryAction = new EventEmitter<string>();
  @Output() secondaryAction = new EventEmitter<string>();

  // Computed properties based on mode
  get activeRemotes(): Remote[] {
    return this.remotes.filter((remote) =>
      this.mode === "mount" ? remote.mounted === true : remote.isOnSync === true
    );
  }

  get inactiveRemotes(): Remote[] {
    return this.remotes.filter((remote) =>
      this.mode === "mount" ? !remote.mounted : !remote.isOnSync
    );
  }

  get errorRemotes(): Remote[] {
    return this.remotes.filter((remote) =>
      this.mode === "mount"
        ? remote.mounted === "error"
        : remote.isOnSync === "error"
    );
  }

  get activeCount(): number {
    return this.activeRemotes.length;
  }

  get inactiveCount(): number {
    return this.inactiveRemotes.length;
  }

  get errorCount(): number {
    return this.errorRemotes.length;
  }

  get title(): string {
    return `${this.mode === "mount" ? "Mount" : "Sync"} Overview`;
  }

  get activeIcon(): string {
    return this.mode === "mount" ? "mount" : "sync";
  }

  get inactiveIcon(): string {
    return "circle-xmark";
  }

  get primaryActionLabel(): string {
    return this.mode === "mount" ? "Mount" : "Start Sync";
  }

  get primaryActionIcon(): string {
    return this.mode === "mount" ? "mount" : "play";
  }

  get secondaryActionLabel(): string {
    return "Open Files";
  }

  get secondaryActionIcon(): string {
    return "folder";
  }

  selectRemote(remote: Remote): void {
    this.remoteSelected.emit(remote);
  }

  triggerOpenInFiles(remoteName: string): void {
    if (remoteName) {
      this.openInFiles.emit(remoteName);
    }
  }

  triggerPrimaryAction(remoteName: string): void {
    if (remoteName) {
      console.log(`Triggering primary action for ${remoteName}`);
      this.primaryAction.emit(remoteName);
      console.log(`Primary action triggered for ${remoteName}`);
    }
  }

  getActionState(remoteName: string | undefined): RemoteAction {
    return remoteName ? this.actionInProgress[remoteName] : null;
  }
}
