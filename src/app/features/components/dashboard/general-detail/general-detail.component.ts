import { Component, EventEmitter, Input, Output } from "@angular/core";
import { MatButtonModule } from "@angular/material/button";
import { MatChipsModule } from "@angular/material/chips";
import { MatTooltipModule } from "@angular/material/tooltip";
import { MatDividerModule } from "@angular/material/divider";
import { MatIconModule } from "@angular/material/icon";
import { MatCardModule } from "@angular/material/card";
import { CommonModule } from "@angular/common";
import { MatProgressBarModule } from "@angular/material/progress-bar";
import { MatTableModule } from "@angular/material/table";
import { MatSortModule } from "@angular/material/sort";

import { JobInfo, Remote, SENSITIVE_KEYS } from "../../../../shared/components/types";
import { DiskUsageConfig, DiskUsagePanelComponent, JobsPanelComponent, JobsPanelConfig, SettingsPanelComponent, SettingsPanelConfig } from "../../../../shared/detail-shared";

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
    SettingsPanelComponent,
    DiskUsagePanelComponent,
    JobsPanelComponent,

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
    type: "sync" | "copy" | "mount" | string;
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

  // Configuration methods for shared components
  getRemoteConfigurationPanelConfig(): SettingsPanelConfig {
    return {
      section: {
        key: 'remote-config',
        title: 'Remote Configuration',
        icon: 'wrench'
      },
      settings: this.selectedRemote.remoteSpecs,
      hasSettings: Object.keys(this.selectedRemote.remoteSpecs).length > 0,
      restrictMode: this.restrictMode,
      buttonColor: 'primary',
      buttonLabel: 'Edit Configuration',
      sensitiveKeys: SENSITIVE_KEYS
    };
  }

  getDiskUsageConfig(): DiskUsageConfig {
    return {
      mounted: this.selectedRemote.mountState?.mounted || false,
      diskUsage: this.selectedRemote.mountState?.diskUsage
    };
  }

  getJobsPanelConfig(): JobsPanelConfig {
    return {
      jobs: this.getRemoteJobs,
      displayedColumns: this.displayedColumns
    };
  }

  // Event handlers for shared components
  onEditRemoteConfiguration(): void {
    this.openRemoteConfigModal.emit({
      editTarget: 'remote', 
      existingConfig: this.selectedRemote.remoteSpecs
    });
  }

  get getRemoteJobs(): JobInfo[] {
    return this.jobs.filter(
      (job) => job.remote_name === this.selectedRemote?.remoteSpecs.name
    );
  }
}
