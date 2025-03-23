import { CommonModule } from "@angular/common";
import { Component, EventEmitter, Input, Output } from "@angular/core";
import { MatCardModule } from "@angular/material/card";
import { MatDividerModule } from "@angular/material/divider";
import { MatChipsModule } from "@angular/material/chips";
import { MatTooltipModule } from "@angular/material/tooltip";

@Component({
  selector: "app-remote-detail",
  imports: [
    CommonModule,
    MatCardModule,
    MatDividerModule,
    MatChipsModule,
    MatTooltipModule,
  ],
  templateUrl: "./remote-detail.component.html",
  styleUrl: "./remote-detail.component.scss",
})
export class RemoteDetailComponent {
  @Input() selectedRemote: any = null;
  @Input() remoteSettings: { [key: string]: { [key: string]: any } } = {};
  @Output() openInFiles = new EventEmitter<string>();
  @Output() mountRemote = new EventEmitter<string>();
  @Output() unmountRemote = new EventEmitter<string>();
  @Output() deleteRemote = new EventEmitter<string>();
  @Output() openRemoteConfigModal = new EventEmitter<{
    remoteName: string;
    type?: string;
  }>();

  remoteSettingsSections: Array<{ key: string; title: string; icon: string }> =
    [
      { key: "mount_options", title: "Mount Options", icon: "mount.svg" },
      { key: "vfs_options", title: "VFS Options", icon: "vfs.svg" },
      { key: "copy_options", title: "Copy Options", icon: "copy.svg" },
      { key: "sync_options", title: "Sync Options", icon: "folder-sync.svg" },
      { key: "filter_options", title: "Filter Options", icon: "filter.svg" },
    ];

  /** ✅ Safely get settings (returns empty object if missing) */
  getRemoteSettings(sectionKey: string): { [key: string]: any } {
    return this.remoteSettings?.[sectionKey] ?? {}; // Default to an empty object
  }

  /** ✅ Checks if the section has any data */
  hasSettings(sectionKey: string): boolean {
    return Object.keys(this.getRemoteSettings(sectionKey)).length > 0;
  }

  openRemoteConfig(type?: string) {
    this.openRemoteConfigModal.emit({
      remoteName: this.selectedRemote.remoteSpecs.name,
      type,
    });
  }

  deleteRemoteByName() {
    this.deleteRemote.emit(this.selectedRemote.remoteSpecs.name);
  }

  mountRemoteByFs() {
    this.mountRemote.emit(this.selectedRemote.remoteSpecs.name);
  }

  unmountRemoteByFs() {
    this.unmountRemote.emit(this.selectedRemote.remoteSpecs.name);
  }

  openRemoteInFiles() {
    this.openInFiles.emit(this.selectedRemote.remoteSpecs.name);
  }

  getUsagePercentage(): number {
    const used = parseFloat(this.selectedRemote.diskUsage?.used_space || "0");
    const total = parseFloat(this.selectedRemote.diskUsage?.total_space || "1");
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
