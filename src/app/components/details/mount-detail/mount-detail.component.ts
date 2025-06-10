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
import {
  Remote,
  RemoteSettings,
  RemoteSettingsSection,
  SENSITIVE_KEYS,
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
  @Input() restrictMode!: boolean;

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

  isSensitiveKey(key: string, restrictMode: boolean): boolean {
    return (
      SENSITIVE_KEYS.some((sensitive) =>
        key.toLowerCase().includes(sensitive)
      ) && restrictMode
    );
  }

  maskSensitiveValue(key: string, value: any): string {
    return this.isSensitiveKey(key, this.restrictMode)
      ? "RESTRICTED"
      : this.truncateValue(value, 15);
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
