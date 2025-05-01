import { CommonModule } from "@angular/common";
import { Component, EventEmitter, Input, Output, SimpleChanges } from "@angular/core";
import { MatCardModule } from "@angular/material/card";
import { MatDividerModule } from "@angular/material/divider";
import { MatChipsModule } from "@angular/material/chips";
import { MatTooltipModule } from "@angular/material/tooltip";
import { MatIconModule } from "@angular/material/icon";
import { MatProgressBarModule } from "@angular/material/progress-bar";
import { Subject } from "rxjs";
import { MatProgressSpinnerModule } from "@angular/material/progress-spinner";
import { MatButtonModule } from "@angular/material/button";

@Component({
  selector: "app-mount-detail",
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
  styleUrl: "./mount-detail.component.scss",
})
export class MountDetailComponent {
  @Input() selectedRemote: any = null;
  @Input() remoteSettings: { [key: string]: { [key: string]: any } } = {};
  @Input() actionInProgress: 'mount' | 'unmount' | 'open' | null = null;
  @Output() openInFiles = new EventEmitter<string>();
  @Output() mountRemote = new EventEmitter<string>();
  @Output() unmountRemote = new EventEmitter<string>();
  @Output() openRemoteConfigModal = new EventEmitter<{
    editTarget?: string;
    existingConfig?: any[];
  }>();

  filteredRemoteSpecs: { key: string; value: any }[] = [];
  remoteSettingsSections: Array<{ key: string; title: string; icon: string }> =
    [
      { key: "mount", title: "Mount Options", icon: "mount" },
      { key: "vfs", title: "VFS Options", icon: "vfs" },
      // { key: "copy", title: "Copy Options", icon: "copy.svg" },
      // { key: "sync", title: "Sync Options", icon: "folder-sync.svg" },
      // { key: "filter", title: "Filter Options", icon: "filter.svg" },
    ];

  ngOnInit() {
    console.log(this.selectedRemote);
    console.log(this.remoteSettings);
  }

  private destroy$ = new Subject<void>();

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }
  
  // Modify ngOnChanges to be more efficient
  ngOnChanges(changes: SimpleChanges) {
    if (changes['selectedRemote']) {
      console.log("Selected remote changed:", changes['selectedRemote'].currentValue);
      
    }
  }
  
  private filterSpecs(specs: any): { key: string; value: any }[] {
    if (!specs) return [];
    return Object.entries(specs)
      .filter(([key]) => !['name', 'type'].includes(key))
      .map(([key, value]) => ({ key, value }));
  }

  getDiskBarStyle(): { [key: string]: string } {
    if (!this.selectedRemote) return {};

    if (!this.selectedRemote.mounted) {
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
  }

  /** ✅ Safely get settings (returns empty object if missing) */
  getRemoteSettings(sectionKey: string): { [key: string]: any } {
    return this.remoteSettings?.[sectionKey] || {};
  }

  /** ✅ Checks if the section has any data */
  hasSettings(sectionKey: string): boolean {
    return Object.keys(this.getRemoteSettings(sectionKey)).length > 0;
  }

  triggerOpenRemoteConfig(editTarget?: string, existingConfig?: any) {
    console.log(existingConfig);
    this.openRemoteConfigModal.emit({
      editTarget: editTarget,
      existingConfig: existingConfig,
    });
  }

  triggerMountRemote() {
    this.mountRemote.emit(this.selectedRemote.remoteSpecs.name);
  }

  triggerUnmountRemote() {
    this.unmountRemote.emit(this.selectedRemote.remoteSpecs.name);
  }

  triggerOpenInFiles() {
    this.openInFiles.emit(this.selectedRemote.remoteSpecs.name);
  }

  getUsagePercentage(): number {
    const usedStr = this.selectedRemote.diskUsage?.used_space || "0";
    const totalStr = this.selectedRemote.diskUsage?.total_space || "1";

    // Helper to parse human-readable sizes like "2.00 GB"
    function parseSize(size: string): number {
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

    const used = parseSize(usedStr);
    const total = parseSize(totalStr) || 1; // Prevent division by zero

    return (used / total) * 100;
  }

  truncateValue(value: any, length: number): string {
    if (typeof value === "object") {
      try {
        const jsonString = JSON.stringify(value);
        return jsonString.length > length
          ? jsonString.slice(0, length) + "..."
          : jsonString;
      } catch (error) {
        return "[Invalid JSON]";
      }
    }
    if (typeof value === "string") {
      return value.length > length ? value.slice(0, length) + "..." : value;
    }
    return value;
  }
}
