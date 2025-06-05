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
import {
  AppTab,
  Remote,
  RemoteAction,
  RemoteActionProgress,
} from "../../../shared/components/types";

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
    console.log(this.remotes);

    return this.activeRemotes.length;
  }

  get inactiveCount(): number {
    return this.inactiveRemotes.length;
  }

  get errorCount(): number {
    return this.errorRemotes.length;
  }

  get title(): string {
    switch (this.mode) {
      case "mount":
        return "Mount Overview";
      case "sync":
        return "Sync Overview";
      case "copy":
        return "Copy Overview";
      default:
        return "Overview";
    }
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

  getOpenButtonLabel(remoteName: string): string {
    return this.getActionState(remoteName) === "open"
      ? "Opening"
      : "Open Files";
  }

  getStopButtonLabel(): string {
    if (this.mode === "sync") return "Stop Sync";
    if (this.mode === "copy") return "Stop Copy";
    return "Stop";
  }

  isOpening(remoteName: string): boolean {
    return this.getActionState(remoteName) === "open";
  }

  isStopping(remoteName: string): boolean {
    return this.getActionState(remoteName) === "stop";
  }

  shouldShowOpenButton(remote: any): boolean {
    if (this.mode === "mount") return true;
    if (this.mode === "sync") return remote.syncState?.isLocal;
    if (this.mode === "copy") return remote.copyState?.isLocal;
    return false;
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
