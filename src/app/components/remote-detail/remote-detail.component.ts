import { CommonModule } from "@angular/common";
import { Component, EventEmitter, Input, Output } from "@angular/core";
import { MatCardModule } from "@angular/material/card";
import { MatDividerModule } from "@angular/material/divider";
import { MatChipsModule } from "@angular/material/chips";
import { MatTooltipModule } from "@angular/material/tooltip";
import { MatMenuModule } from "@angular/material/menu";
import { MatSlideToggleModule } from "@angular/material/slide-toggle";

@Component({
  selector: "app-remote-detail",
  imports: [
    CommonModule,
    MatCardModule,
    MatDividerModule,
    MatChipsModule,
    MatTooltipModule,
    MatMenuModule,
    MatSlideToggleModule,
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
    editTarget?: string,
    existingConfig?: any[]
  }>();
  @Output() saveRemoteSettings = new EventEmitter<{
    remoteName: string;
    settings?: any;
  }>();

  remoteSettingsSections: Array<{ key: string; title: string; icon: string }> =
    [
      { key: "mount", title: "Mount Options", icon: "mount.svg" },
      { key: "vfs", title: "VFS Options", icon: "vfs.svg" },
      { key: "copy", title: "Copy Options", icon: "copy.svg" },
      { key: "sync", title: "Sync Options", icon: "folder-sync.svg" },
      { key: "filter", title: "Filter Options", icon: "filter.svg" },
    ];

  /** ✅ Safely get settings (returns empty object if missing) */
  getRemoteSettings(sectionKey: string): { [key: string]: any } {
    
    return this.remoteSettings?.[sectionKey] ?? {}; // Default to an empty object
  }

  getRemoteSettingsKeys(sectionKey: string): boolean {
    return !!this.remoteSettings?.[sectionKey];
  }

  /** ✅ Save settings for a remote */
  saveRemoteSetting(settings: any) {
    console.log(settings);
    
    this.saveRemoteSettings.emit({
      remoteName: this.selectedRemote.remoteSpecs.name,
      settings: settings,
    })
  }

  /** ✅ Checks if the section has any data */
  hasSettings(sectionKey: string): boolean {
    return Object.keys(this.getRemoteSettings(sectionKey)).length > 0;
  }

  openRemoteConfig(editTarget?: string, existingConfig?: any) {
    console.log(existingConfig)
    this.openRemoteConfigModal.emit({
      editTarget: editTarget,
      existingConfig: existingConfig
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
