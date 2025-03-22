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
  @Input() selectedRemote: any;
  @Output() openInFiles = new EventEmitter<string>();
  @Output() mountRemote = new EventEmitter<string>();
  @Output() unmountRemote = new EventEmitter<string>();
  @Output() deleteRemote = new EventEmitter<string>();
  @Output() openRemoteConfigModal = new EventEmitter<{ remoteName: string; type?: string }>();

  openRemoteConfig(type?: string) {
    this.openRemoteConfigModal.emit({ remoteName: this.selectedRemote.remoteSpecs.name, type });
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
  if (typeof value === 'object') {
    try {
      const jsonString = JSON.stringify(value);
      return jsonString.length > length ? jsonString.slice(0, length) + "..." : jsonString;
    } catch (error) {
      return "[Invalid JSON]";
    }
  } 
  if (typeof value === 'string') {
    return value.length > length ? value.slice(0, length) + "..." : value;
  }
  return value;
}

}
