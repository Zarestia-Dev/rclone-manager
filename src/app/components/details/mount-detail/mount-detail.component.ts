import { CommonModule } from "@angular/common";
import {
  Component,
  EventEmitter,
  Input,
  Output,
  ChangeDetectionStrategy,
  OnDestroy,
  SimpleChanges,
} from "@angular/core";
import { MatCardModule } from "@angular/material/card";
import { MatDividerModule } from "@angular/material/divider";
import { MatChipsModule } from "@angular/material/chips";
import { MatTooltipModule } from "@angular/material/tooltip";
import { MatIconModule } from "@angular/material/icon";
import { MatProgressBarModule } from "@angular/material/progress-bar";
import { Subject } from "rxjs";
import { MatProgressSpinnerModule } from "@angular/material/progress-spinner";
import { MatButtonModule } from "@angular/material/button";
import { SENSITIVE_KEYS } from "../../../shared/remote-config/remote-config-types";
import {
  Remote,
  RemoteSettings,
  RemoteSettingsSection,
} from "../../../shared/components/types";

@Component({
  selector: "app-mount-detail",
  standalone: true,
  imports: [
    CommonModule,
    MatCardModule,
    MatDividerModule,
    MatChipsModule,
    MatTooltipModule,
    MatIconModule,
    MatProgressBarModule,
    MatProgressSpinnerModule,
    MatButtonModule,
  ],
  templateUrl: "./mount-detail.component.html",
  styleUrls: ["./mount-detail.component.scss"],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MountDetailComponent implements OnDestroy {
  @Input() selectedRemote: Remote | null = null;
  @Input() iconService: any; // Consider creating an interface for this
  @Input() remoteSettings: RemoteSettings = {};
  @Input() actionInProgress:
    | "mount"
    | "unmount"
    | "sync"
    | "copy"
    | "stop"
    | "open"
    | null = null;

  @Output() openInFiles = new EventEmitter<{
    remoteName: string;
    path: string;
  }>();
  @Output() mountRemote = new EventEmitter<string>();
  @Output() unmountRemote = new EventEmitter<string>();
  @Output() openRemoteConfigModal = new EventEmitter<{
    editTarget?: string;
    existingConfig?: any;
  }>();

  remoteSettingsSections: RemoteSettingsSection[] = [
    { key: "mount", title: "Mount Options", icon: "mount" },
    { key: "vfs", title: "VFS Options", icon: "vfs" },
  ];

  private destroy$ = new Subject<void>();

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }

  ngOnChanges(changes: SimpleChanges): void {}

  getDiskBarStyle(): { [key: string]: string } {
    if (!this.selectedRemote?.mountState?.mounted) {
      return this.getUnmountedStyle();
    }

    if (this.selectedRemote.mountState?.mounted === "error") {
      return this.getErrorStyle();
    }

    // Check if we have disk usage data and it's not supported
    if (this.selectedRemote.mountState?.diskUsage?.notSupported) {
      return this.getUnsupportedStyle();
    }

    // Check if we're still loading disk usage
    if (this.selectedRemote.mountState?.diskUsage?.loading) {
      return this.getLoadingStyle();
    }

    return this.getMountedStyle();
  }

  getUsagePercentage(): number {
    if (
      !this.selectedRemote?.mountState?.diskUsage ||
      this.selectedRemote.mountState.diskUsage.notSupported
    ) {
      return 0;
    }

    const used = this.parseSize(
      this.selectedRemote.mountState.diskUsage.used_space || "0"
    );
    const total = this.parseSize(
      this.selectedRemote.mountState.diskUsage.total_space || "1"
    );

    return total > 0 ? (used / total) * 100 : 0;
  }

  // Remote Settings Helpers
  getRemoteSettings(sectionKey: string): RemoteSettings {
    return this.remoteSettings?.[sectionKey] || {};
  }

  hasSettings(sectionKey: string): boolean {
    return Object.keys(this.getRemoteSettings(sectionKey)).length > 0;
  }

  isObjectButNotArray(value: any): boolean {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  // Path Helpers
  get mountDestination(): string {
    return this.remoteSettings?.["mountConfig"]?.["dest"] || "Need to set!";
  }

  get mountSource(): string {
    return this.remoteSettings?.["mountConfig"]?.["source"] || "Need to set!";
  }

  // Event Triggers
  triggerOpenRemoteConfig(editTarget?: string, existingConfig?: any) {
    this.openRemoteConfigModal.emit({ editTarget, existingConfig });
  }

  triggerMountRemote() {
    if (this.selectedRemote?.remoteSpecs?.name) {
      this.mountRemote.emit(this.selectedRemote.remoteSpecs.name);
    }
  }

  triggerUnmountRemote() {
    if (this.selectedRemote?.remoteSpecs?.name) {
      this.unmountRemote.emit(this.selectedRemote.remoteSpecs.name);
    }
  }

  triggerOpenInFiles() {
    if (this.selectedRemote?.remoteSpecs?.name) {
      this.openInFiles.emit({
        remoteName: this.selectedRemote.remoteSpecs.name,
        path: this.mountDestination,
      });
    }
  }

  // Security Helpers
  isSensitiveKey(key: string): boolean {
    return SENSITIVE_KEYS.some((sensitive) =>
      key.toLowerCase().includes(sensitive)
    );
  }

  maskSensitiveValue(key: string, value: any): string {
    return this.isSensitiveKey(key)
      ? "RESTRICTED"
      : this.truncateValue(value, 15);
  }

  // Private Helpers
  private getUnmountedStyle(): { [key: string]: string } {
    return {
      backgroundColor: "var(--purple)",
      border: "3px solid transparent",
      transition: "all 0.5s ease-in-out",
    };
  }

  private getErrorStyle(): { [key: string]: string } {
    return {
      backgroundColor: "var(--red)",
      border: "3px solid transparent",
      transition: "all 0.5s ease-in-out",
    };
  }

  private getUnsupportedStyle(): { [key: string]: string } {
    return {
      backgroundColor: "var(--yellow)",
      border: "3px solid transparent",
      transition: "all 0.5s ease-in-out",
    };
  }

  private getLoadingStyle(): { [key: string]: string } {
    return {
      backgroundColor: "var(--orange)",
      border: "3px solid transparent",
      backgroundImage:
        "linear-gradient(120deg, rgba(255,255,255,0.15) 25%, rgba(255,255,255,0.35) 50%, rgba(255,255,255,0.15) 75%)",
      backgroundSize: "200% 100%",
      animation: "diskLoadingShimmer 1.2s linear infinite",
      transition: "all 0.5s ease-in-out",
    };
  }

  private getMountedStyle(): { [key: string]: string } {
    return {
      backgroundColor: "#cecece",
      border: "3px solid var(--light-blue)",
      transition: "all 0.5s ease-in-out",
    };
  }

  private parseSize(size: string): number {
    const units: { [key: string]: number } = {
      B: 1,
      KB: 1024,
      MB: 1024 ** 2,
      GB: 1024 ** 3,
      TB: 1024 ** 4,
    };
    const match = size.trim().match(/^([\d.]+)\s*([A-Za-z]+)?$/);
    if (!match) return 0;
    const value = parseFloat(match[1]);
    const unit = (match[2] || "B").toUpperCase();
    return value * (units[unit] || 1);
  }

  private truncateValue(value: any, length: number): string {
    if (value === null || value === undefined) return "";

    if (typeof value === "object") {
      try {
        const jsonString = JSON.stringify(value);
        return jsonString.length > length
          ? `${jsonString.slice(0, length)}...`
          : jsonString;
      } catch {
        return "[Invalid JSON]";
      }
    }

    const stringValue = String(value);
    return stringValue.length > length
      ? `${stringValue.slice(0, length)}...`
      : stringValue;
  }
}
