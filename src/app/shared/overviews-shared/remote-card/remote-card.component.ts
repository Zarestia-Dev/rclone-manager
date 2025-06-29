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
import { MatIconModule } from "@angular/material/icon";
import { MatProgressSpinnerModule } from "@angular/material/progress-spinner";
import { MatTooltipModule } from "@angular/material/tooltip";
import { QuickActionButton, QuickActionButtonsComponent } from "../../../shared/components";
import { AppTab, Remote, RemoteAction } from "../../../shared/components/types";

export type RemoteCardVariant = "active" | "inactive" | "error";

@Component({
  selector: "app-remote-card",
  standalone: true,
  imports: [
    CommonModule,
    MatCardModule,
    MatIconModule,
    MatButtonModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    QuickActionButtonsComponent,
  ],
  templateUrl: "./remote-card.component.html",
  styleUrl: "./remote-card.component.scss",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RemoteCardComponent {
  @Input() remote!: Remote;
  @Input() variant: RemoteCardVariant = "inactive";
  @Input() mode: AppTab = "general";
  @Input() iconService: any;
  @Input() actionState: RemoteAction = null;
  @Input() showOpenButton = false;
  @Input() primaryActionLabel = "Start";
  @Input() activeIcon = "circle-check";

  @Output() remoteClick = new EventEmitter<Remote>();
  @Output() openInFiles = new EventEmitter<string>();
  @Output() primaryAction = new EventEmitter<string>();
  @Output() secondaryAction = new EventEmitter<string>();
  @Output() mountAction = new EventEmitter<string>();
  @Output() unmountAction = new EventEmitter<string>();
  @Output() syncAction = new EventEmitter<string>();
  @Output() copyAction = new EventEmitter<string>();
  @Output() stopSyncAction = new EventEmitter<string>();
  @Output() stopCopyAction = new EventEmitter<string>();

  get isOpening(): boolean {
    return this.actionState === "open";
  }

  get isStopping(): boolean {
    return this.actionState === "stop";
  }

  get isLoading(): boolean {
    return this.actionState === this.mode;
  }

  get primaryActionIcon(): string {
    return this.mode === "mount" ? "mount" : "play";
  }

  get secondaryActionIcon(): string {
    return this.mode === "mount" ? "eject" : "stop";
  }

  get secondaryActionTooltip(): string {
    if (this.mode === "mount") return "Unmount";
    if (this.mode === "sync") return "Stop Sync";
    if (this.mode === "copy") return "Stop Copy";
    return "Stop";
  }

  getActionButtons(): QuickActionButton[] {
    const buttons: QuickActionButton[] = [];

    // General mode shows all operations (for general-overview)
    if (this.mode === "general") {
      return this.getGeneralActionButtons();
    }

    if (this.variant === "active") {
      // Open/Browse button for active remotes
      if (this.showOpenButton) {
        buttons.push({
          id: "open",
          icon: "folder",
          tooltip: "Browse (B)",
          color: "accent",
          isLoading: this.isOpening,
          isDisabled: this.isOpening,
          cssClass: "browse-btn",
        });
      }

      // Secondary action button (stop/unmount)
      buttons.push({
        id: "secondary",
        icon: this.secondaryActionIcon,
        tooltip: this.secondaryActionTooltip,
        color: "warn",
        isLoading: this.isStopping,
        isDisabled: this.isStopping,
        cssClass: "stop-btn",
      });
    } else if (this.variant === "inactive") {
      // Primary action button for inactive remotes
      buttons.push({
        id: "primary",
        icon: this.primaryActionIcon,
        tooltip: this.primaryActionLabel,
        isLoading: this.isLoading,
        isDisabled: this.isLoading,
        cssClass: `${this.mode}-btn`,
      });
    } else if (this.variant === "error") {
      // Fix button for error remotes
      buttons.push({
        id: "fix",
        icon: "wrench",
        tooltip: "Fix Issues",
        cssClass: "fix-btn",
      });
    }

    return buttons;
  }

  private getGeneralActionButtons(): QuickActionButton[] {
    const buttons: QuickActionButton[] = [];

    // Mount/Unmount Button
    const isMountAction =
      this.actionState === "mount" || this.actionState === "unmount";
    buttons.push({
      id: "mount",
      icon: this.remote.mountState?.mounted ? "eject" : "mount",
      tooltip: this.remote.mountState?.mounted ? "Unmount" : "Mount",
      color: this.remote.mountState?.mounted ? "warn" : "accent",
      isLoading: isMountAction,
      isDisabled: isMountAction,
      cssClass: this.remote.mountState?.mounted ? "unmount-btn" : "mount-btn",
    });

    // Sync Button
    const isSyncAction =
      this.actionState === "sync" || this.actionState === "stop";
    buttons.push({
      id: "sync",
      icon: this.remote.syncState?.isOnSync ? "stop" : "sync",
      tooltip: this.remote.syncState?.isOnSync ? "Stop Sync" : "Start Sync",
      color: this.remote.syncState?.isOnSync ? "warn" : "primary",
      isLoading: isSyncAction && !!this.remote.syncState?.isOnSync,
      isDisabled: isSyncAction,
      cssClass: this.remote.syncState?.isOnSync ? "stop-btn" : "sync-btn",
    });

    // Copy Button
    const isCopyAction =
      this.actionState === "copy" || this.actionState === "stop";
    buttons.push({
      id: "copy",
      icon: this.remote.copyState?.isOnCopy ? "stop" : "copy",
      tooltip: this.remote.copyState?.isOnCopy ? "Stop Copy" : "Start Copy",
      color: this.remote.copyState?.isOnCopy ? "warn" : undefined,
      isLoading: isCopyAction && !!this.remote.copyState?.isOnCopy,
      isDisabled: isCopyAction,
      cssClass: this.remote.copyState?.isOnCopy ? "stop-btn" : "copy-btn",
    });

    // Browse Button
    buttons.push({
      id: "browse",
      icon: "folder",
      tooltip: "Browse",
      color: "accent",
      isLoading: this.actionState === "open",
      isDisabled:
        !this.remote.mountState?.mounted || this.actionState === "open",
      cssClass: "browse-btn",
    });

    return buttons;
  }

  onActionButtonClick(action: { id: string; event: Event }): void {
    action.event.stopPropagation();

    switch (action.id) {
      case "open":
        this.onOpenInFiles(action.event);
        break;
      case "primary":
        this.onPrimaryAction(action.event);
        break;
      case "secondary":
        this.onSecondaryAction(action.event);
        break;
      case "mount":
        // Handle mount/unmount based on current state
        if (this.remote.mountState?.mounted) {
          this.onUnmountAction(action.event); // unmount
        } else {
          this.onMountAction(action.event); // mount
        }
        break;
      case "sync":
        // Handle sync/stop-sync based on current state
        if (this.remote.syncState?.isOnSync) {
          this.onStopSyncAction(action.event); // stop-sync
        } else {
          this.onSyncAction(action.event); // sync
        }
        break;
      case "copy":
        // Handle copy/stop-copy based on current state
        if (this.remote.copyState?.isOnCopy) {
          this.onStopCopyAction(action.event); // stop-copy
        } else {
          this.onCopyAction(action.event); // copy
        }
        break;
      case "browse":
        this.onBrowseAction(action.event);
        break;
      case "fix":
        // Handle fix action
        break;
    }
  }

  get remoteCardClasses() {
    return {
      [`${this.variant}-remote`]: true,
      mounted: this.remote.mountState?.mounted,
      syncing: this.remote.syncState?.isOnSync,
      copying: this.remote.copyState?.isOnCopy,
    };
  }

  onRemoteClick(): void {
    this.remoteClick.emit(this.remote);
  }

  onOpenInFiles(event: Event): void {
    event.stopPropagation();
    this.openInFiles.emit(this.remote.remoteSpecs.name);
  }

  onPrimaryAction(event: Event): void {
    event.stopPropagation();
    this.primaryAction.emit(this.remote.remoteSpecs.name);
  }

  onSecondaryAction(event: Event): void {
    event.stopPropagation();
    this.secondaryAction.emit(this.remote.remoteSpecs.name);
  }

  onMountAction(event: Event): void {
    event.stopPropagation();
    this.mountAction.emit(this.remote.remoteSpecs.name);
  }

  onSyncAction(event: Event): void {
    event.stopPropagation();
    this.syncAction.emit(this.remote.remoteSpecs.name);
  }

  onCopyAction(event: Event): void {
    event.stopPropagation();
    this.copyAction.emit(this.remote.remoteSpecs.name);
  }

  onBrowseAction(event: Event): void {
    event.stopPropagation();
    this.openInFiles.emit(this.remote.remoteSpecs.name);
  }

  onUnmountAction(event: Event): void {
    event.stopPropagation();
    this.unmountAction.emit(this.remote.remoteSpecs.name);
  }

  onStopSyncAction(event: Event): void {
    event.stopPropagation();
    this.stopSyncAction.emit(this.remote.remoteSpecs.name);
  }

  onStopCopyAction(event: Event): void {
    event.stopPropagation();
    this.stopCopyAction.emit(this.remote.remoteSpecs.name);
  }
}
