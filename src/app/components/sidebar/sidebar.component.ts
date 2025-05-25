import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatSidenavModule } from '@angular/material/sidenav';

export interface RemoteSpecs {
  name: string;
  type: string;
  [key: string]: any;
}

export interface DiskUsage {
  total_space: string;
  used_space: string;
  free_space: string;
  loading?: boolean;
  error?: boolean;
  notSupported?: boolean;
}

export interface Remote {
  remoteSpecs: RemoteSpecs;
  mountState?: {
    mounted?: boolean | "error";
    diskUsage?: DiskUsage;
  };
  syncState?: {
    isOnSync?: boolean | "error";
    syncJobID?: number;
  };
}

@Component({
  selector: 'app-sidebar',
  imports: [
    CommonModule,
    MatSidenavModule,
    MatCardModule,
    MatIconModule,
  ],
  templateUrl: './sidebar.component.html',
  styleUrl: './sidebar.component.scss'
})
export class SidebarComponent {
  @Input() remotes: Remote[] = [];
  @Input() iconService: any;
  @Output() remoteSelected = new EventEmitter<any>();

  selectRemote(remote: any) {
    this.remoteSelected.emit(remote); // Emit event when a remote is selected
  }
}
