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
  localPath?: boolean; // Optional path for local remotes
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
  mountState?: {
    mounted?: boolean | "error";
    diskUsage?: DiskUsage;
  };
  syncState?: {
    isOnSync?: boolean | "error";
    syncJobID?: number;
  };
}

export interface RemoteSettings {
  [key: string]: { [key: string]: any };
}

export type AppTab = "mount" | "sync" | "copy" | "jobs";


@Component({
  selector: "app-app-overview",
  imports: [
    MatCardModule,
    MatDividerModule,
    CommonModule,
    MatIconModule,
    MatTooltipModule,
    MatProgressSpinnerModule,
    MatButtonModule,
  ],
  templateUrl: "./app-overview.component.html",
  styleUrl: "./app-overview.component.scss",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppOverviewComponent {
    @Input() mode: AppTab = "mount";
    @Input() remotes: Remote[] = [];
    @Input() selectedRemote: Remote | null = null;
    @Input() iconService: any;
    @Input() actionInProgress: RemoteActionProgress = {};
  
    @Output() remoteSelected = new EventEmitter<Remote>();
    @Output() openInFiles = new EventEmitter<string>();
    @Output() primaryAction = new EventEmitter<string>();
    @Output() secondaryActionClicked = new EventEmitter<string>();
    @Output() secondaryAction = new EventEmitter<string>();
  
    // Computed properties based on mode
    get activeRemotes(): Remote[] {
      return this.remotes.filter((remote) =>
        this.mode === "mount" ? remote.mountState?.mounted === true : remote.syncState?.isOnSync === true
      );
    }
  
    get inactiveRemotes(): Remote[] {
      return this.remotes.filter((remote) =>
        this.mode === "mount" ? !remote.mountState?.mounted : !remote.syncState?.isOnSync
      );
    }
  
    get errorRemotes(): Remote[] {
      return this.remotes.filter((remote) =>
        this.mode === "mount"
          ? remote.mountState?.mounted === "error"
          : remote.syncState?.isOnSync === "error"
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
        this.primaryAction.emit(remoteName);
      }
    }
  
    triggerSecondaryAction(remoteName: string): void {
      if (remoteName) {
        this.secondaryAction.emit(remoteName);
      }
    }
  
    getActionState(remoteName: string | undefined): RemoteAction {
      return remoteName ? this.actionInProgress[remoteName] : null;
    }
  
}
