import { Component, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatDrawerMode, MatSidenavModule } from '@angular/material/sidenav';
import { MatCardModule } from '@angular/material/card';
import {MatProgressBarModule} from '@angular/material/progress-bar';
import { MatDividerModule } from '@angular/material/divider';
import { MatChipsModule } from '@angular/material/chips';

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [MatSidenavModule, MatDividerModule, MatChipsModule, CommonModule, MatIconModule, MatCardModule, MatProgressBarModule],
  templateUrl: './home.component.html',
  styleUrl: './home.component.scss'
})
export class HomeComponent {
  isSidebarOpen = true;
  sidebarMode: MatDrawerMode = 'side';
  remotes = [
    { name: 'Google Drive', mounted: "true", id: 'drive', info: [
      { remote_disk: [
        { name: 'Total Space', value: '15 GB' },
        { name: 'Used Space', value: '5 GB' },
        { name: 'Free Space', value: '10 GB' }
      ]
      },
      { remote_specs: [
        { name: 'client_id', value: '1234567890' },
        { name: 'client_secret', value: '1234567890' },
        { name: 'token', value
        : '1234567890' },
        { name: 'file_access', value: 'full' },
        { name: 'service_account_file', value: 'service_account_file.json' }
      ] },
      { mount_specs: [
        { name: 'Mount Path', value: '/mnt/gdrive' },
        { name: 'Mount Type', value: 'Service' },
        { name: 'Mount Options', value: 'rw,uid=1000,gid=1000' },
        { name: 'spesific_mount_options', value: '--vfs-cache-max-size 20G --vfs-cache-max-age 24h --vfs-read-chunk-size 32M --vfs-read-chunk-size-limit 2G' }
      ] },
    ] },
    { name: 'Dropbox', icon: 'dropbox', mounted: "false", id: 'dropbox' },
    { name: 'OneDrive', icon: 'onedrive', mounted: "error", id: 'onedrive' },
    { name: 'Box', icon: 'box', mounted: "true", id: 'box' },
    { name: 'FTP', icon: 'ftp', mounted: "false", id: 'ftp' },
    { name: 'SFTP', icon: 'sftp', mounted: "error", id: 'sftp' },
    { name: 'WebDAV', icon: 'webdav', mounted: "true", id: 'webdav' },
    { name: 'S3', icon: 's3', mounted: "false", id: 's3' },
  ]; // Example remotes, replace with actual data.

  getUsagePercentage(remote: any): number {
    const used = parseFloat(remote.info[0].remote_disk[1].value);
    const total = parseFloat(remote.info[0].remote_disk[0].value);
    return (used / total) * 100;
  }
  openFiles() {
    console.log("Opening Files...");
    // Add logic to open the file manager here
  }
  
  unmountRemote() {
    console.log("Unmounting Remote...");
    // Add logic to unmount the remote here
  }

  @HostListener('window:resize', [])
  onResize() {
    this.updateSidebarMode();
  }

  private updateSidebarMode() {
    if (window.innerWidth < 900) {
      this.sidebarMode = 'over';
    } else {
      this.sidebarMode = 'side';
    }
  }
    

  ngOnInit(): void {
    // Load sidebar state from localStorage
    const savedState = localStorage.getItem('sidebarState');
    this.isSidebarOpen = savedState === 'true';
  }

  toggleSidebar(): void {
    this.isSidebarOpen = !this.isSidebarOpen;
    localStorage.setItem('sidebarState', String(this.isSidebarOpen)); // Save state
  }
  selectedRemote: any = null;

  selectRemote(remote: any) {
    this.selectedRemote = remote;
  }

  addRemote() {
    // Logic to add a new remote
  }
}
