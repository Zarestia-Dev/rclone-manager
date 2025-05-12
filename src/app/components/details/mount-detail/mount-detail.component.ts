import { CommonModule } from "@angular/common";
import { Component, EventEmitter, Input, Output, ChangeDetectionStrategy } from "@angular/core";
import { MatCardModule } from "@angular/material/card";
import { MatDividerModule } from "@angular/material/divider";
import { MatChipsModule } from "@angular/material/chips";
import { MatTooltipModule } from "@angular/material/tooltip";
import { MatIconModule } from "@angular/material/icon";
import { MatProgressBarModule } from "@angular/material/progress-bar";
import { Subject } from "rxjs";
import { MatProgressSpinnerModule } from "@angular/material/progress-spinner";
import { MatButtonModule } from "@angular/material/button";
import { SENSITIVE_KEYS } from "../../../shared/remote-config-types";

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

export interface RemoteSettings {
  [key: string]: { [key: string]: any };
}

export interface Remote {
  custom_flags?: { [key: string]: any };
  mount_options?: { [key: string]: any };
  name?: string;
  show_in_tray_menu?: boolean;
  type?: string;
  remoteSpecs?: RemoteSpecs;
  diskUsage?: RemoteDiskUsage;
  mounted?: boolean | string;
}

export interface RemoteSettingsSection {
  key: string;
  title: string;
  icon: string;
}

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
    MatButtonModule
  ],
  templateUrl: "./mount-detail.component.html",
  styleUrls: ["./mount-detail.component.scss"],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class MountDetailComponent {
  @Input() selectedRemote: Remote | null = null;
  @Input() iconService: any; // Consider creating an interface for this
  @Input() remoteSettings: RemoteSettings = {};
  @Input() actionInProgress: 'mount' | 'unmount' | 'open' | null = null;
  
  @Output() openInFiles = new EventEmitter<string>();
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

  // Memoized function for better performance
  getDiskBarStyle = (): { [key: string]: string } => {
    if (!this.selectedRemote?.mounted) {
      return {
        backgroundColor: "var(--purple)",
        border: "3px solid transparent",
        transition: "all 0.5s ease-in-out",
      };
    }

    if (this.selectedRemote.mounted === "error") {
      return {
        backgroundColor: "var(--red)",
        border: "3px solid transparent",
        transition: "all 0.5s ease-in-out",
      };
    }

    return {
      backgroundColor: "#cecece",
      border: "3px solid #70caf2",
      transition: "all 0.5s ease-in-out",
    };
  };

  getRemoteSettings(sectionKey: string): RemoteSettings {
    return this.remoteSettings?.[sectionKey] || {};
  }

  hasSettings(sectionKey: string): boolean {
    return Object.keys(this.getRemoteSettings(sectionKey)).length > 0;
  }

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
      this.openInFiles.emit(this.selectedRemote.remoteSpecs.name);
    }
  }

  getUsagePercentage(): number {
    if (!this.selectedRemote?.diskUsage) return 0;
    
    const used = this.parseSize(this.selectedRemote.diskUsage.used_space || "0");
    const total = this.parseSize(this.selectedRemote.diskUsage.total_space || "1");
    
    return total > 0 ? (used / total) * 100 : 0;
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

  isSensitiveKey(key: string): boolean {
    return SENSITIVE_KEYS.some(sensitive =>
      key.toLowerCase().includes(sensitive)
    );
  }

  maskSensitiveValue(key: string, value: any): string {
    return this.isSensitiveKey(key) 
      ? "RESTRICTED" 
      : this.truncateValue(value, 15);
  }

  private truncateValue(value: any, length: number): string {
    if (value === null || value === undefined) return '';
    
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