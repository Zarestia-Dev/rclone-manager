import { Component, EventEmitter, Input, Output } from "@angular/core";
import {
  AppTab,
  JobInfo,
  Remote,
  SENSITIVE_KEYS,
} from "../../../shared/components/types";
import { MatButtonModule } from "@angular/material/button";
import { MatChipsModule } from "@angular/material/chips";
import { MatTooltipModule } from "@angular/material/tooltip";
import { MatDividerModule } from "@angular/material/divider";
import { MatProgressSpinnerModule } from "@angular/material/progress-spinner";
import { MatIconModule } from "@angular/material/icon";
import { MatCardModule } from "@angular/material/card";
import { CommonModule } from "@angular/common";
import { MatProgressBarModule } from "@angular/material/progress-bar";
import { MatTableModule } from "@angular/material/table";
import { StateService } from "../../../services/state.service";
import { MatSortModule } from "@angular/material/sort";

@Component({
  selector: "app-general-detail",
  imports: [
    CommonModule,
    MatCardModule,
    MatIconModule,
    MatProgressBarModule,
    MatDividerModule,
    MatTooltipModule,
    MatChipsModule,
    MatButtonModule,
    MatTableModule,
    MatTooltipModule,
    MatSortModule,
  ],
  templateUrl: "./general-detail.component.html",
  styleUrl: "./general-detail.component.scss",
})
export class GeneralDetailComponent {
  @Input() selectedRemote!: Remote;
  @Input() iconService: any;
  @Input() jobs: JobInfo[] = [];
  @Input() actionInProgress:
    | "mount"
    | "unmount"
    | "sync"
    | "copy"
    | "stop"
    | "open"
    | null = null;
  @Input() restrictMode!: boolean;

  @Output() openRemoteConfigModal = new EventEmitter<{
    editTarget?: string;
    existingConfig?: any;
  }>();
  @Output() startOperation = new EventEmitter<{
    type: "sync" | "copy";
    remoteName: string;
  }>();
  @Output() stopOperation = new EventEmitter<{
    type: "sync" | "copy";
    remoteName: string;
  }>();
  @Output() deleteJob = new EventEmitter<number>();

  // For jobs table
  displayedColumns: string[] = [
    "type",
    "status",
    "progress",
    "startTime",
    "actions",
  ];


  constructor() {}

  getDiskBarStyle(): { [key: string]: string } {
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

  // Private Helpers
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

  triggerOpenRemoteConfig(editTarget?: string, existingConfig?: any) {
    this.openRemoteConfigModal.emit({ editTarget, existingConfig });
  }

  get getRemoteJobs(): JobInfo[] {
    return this.jobs.filter(
      (job) => job.remote_name === this.selectedRemote?.remoteSpecs.name
    );
  }

  getJobProgress(job: JobInfo): number {
    if (!job.stats) return 0;
    return (job.stats.bytes / job.stats.totalBytes) * 100;
  }

  getJobStatusIcon(job: JobInfo): string {
    switch (job.status) {
      case "Running":
        return "refresh";
      case "Completed":
        return "circle-check";
      case "Failed":
        return "circle-exclamation";
      case "Stopped":
        return "stop";
      default:
        return "question";
    }
  }

  getJobStatusColor(job: JobInfo): string {
    switch (job.status) {
      case "Running":
        return "primary";
      case "Completed":
        return "accent";
      case "Failed":
        return "warn";
      default:
        return "";
    }
  }

  formatBytes(bytes: number): string {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
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
