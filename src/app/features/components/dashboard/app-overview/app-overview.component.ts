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
import { AppTab, Remote, RemoteActionProgress } from "../../../../shared/components/types";
import { AnimationsService } from "../../../../services/core/animations.service";
import { OverviewHeaderComponent } from "../../../../shared/overviews-shared/overview-header/overview-header.component";
import { StatusOverviewPanelComponent } from "../../../../shared/overviews-shared/status-overview-panel/status-overview-panel.component";
import { RemotesPanelComponent } from "../../../../shared/overviews-shared/remotes-panel/remotes-panel.component";

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
    OverviewHeaderComponent,
    StatusOverviewPanelComponent,
    RemotesPanelComponent,
  ],
  animations: [AnimationsService.fadeInOut()],
  templateUrl: "./app-overview.component.html",
  styleUrl: "./app-overview.component.scss",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppOverviewComponent {
  @Input() mode: AppTab = "general"; // Default to 'general' mode
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
    return this.remotes.filter((remote) => {
      if (this.mode === "mount") {
        return remote.mountState?.mounted === true;
      } else if (this.mode === "sync") {
        return remote.syncState?.isOnSync === true;
      } else if (this.mode === "copy") {
        return remote.copyState?.isOnCopy === true;
      }
      return false;
    });
  }

  get inactiveRemotes(): Remote[] {
    return this.remotes.filter((remote) => {
      if (this.mode === "mount") {
        return !remote.mountState?.mounted;
      } else if (this.mode === "sync") {
        return !remote.syncState?.isOnSync;
      } else if (this.mode === "copy") {
        return !remote.copyState?.isOnCopy;
      }
      return false;
    });
  }

  get errorRemotes(): Remote[] {
    return this.remotes.filter((remote) => {
      if (this.mode === "mount") {
        return remote.mountState?.mounted === "error";
      } else if (this.mode === "sync") {
        return remote.syncState?.isOnSync === "error";
      } else if (this.mode === "copy") {
        return remote.copyState?.isOnCopy === "error";
      }
      return false;
    });
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
    if (this.mode === "mount") {
      return "Mount Overview";
    } else if (this.mode === "sync") {
      return "Sync Overview";
    } else if (this.mode === "copy") {
      return "Copy Overview";
    }
    return "Remotes Overview";
  }

  get primaryActionLabel(): string {
    switch (this.mode) {
      case "mount":
        return "Mount";
      case "sync":
        return "Start Sync";
      case "copy":
        return "Start Copy";
      default:
        return "Start";
    }
  }

  get activeIcon(): string {
    switch (this.mode) {
      case "mount":
        return "mount";
      case "sync":
        return "sync";
      case "copy":
        return "copy";
      default:
        return "circle-check";
    }
  }

  get primaryActionIcon(): string {
    return this.mode === "mount" ? "mount" : "play";
  }

  getActiveTitle(): string {
    switch (this.mode) {
      case 'mount':
        return 'Mounted Remotes';
      case 'sync':
        return 'Syncing Remotes';
      case 'copy':
        return 'Copying Remotes';
      default:
        return 'Active Remotes';
    }
  }

  getInactiveTitle(): string {
    switch (this.mode) {
      case 'mount':
        return 'Unmounted Remotes';
      case 'sync':
        return 'Off Sync Remotes';
      case 'copy':
        return 'Not Copying Remotes';
      default:
        return 'Inactive Remotes';
    }
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
}
