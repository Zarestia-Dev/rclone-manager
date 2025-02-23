import { Component } from '@angular/core';
import { SidebarComponent } from '../components/sidebar/sidebar.component';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [SidebarComponent, CommonModule, MatIconModule],
  templateUrl: './home.component.html',
  styleUrl: './home.component.scss'
})
export class HomeComponent {
  remotes: any[] = []; // List of RClone remotes
  selectedRemote: any = null; // Currently selected remote

  constructor() {
    // Load remotes from storage or API
    this.loadRemotes();
  }

  loadRemotes() {
    // Example: Load remotes from localStorage
    const savedRemotes = localStorage.getItem('rclone-remotes');
    this.remotes = savedRemotes ? JSON.parse(savedRemotes) : [];
  }

  addRemote() {
    // Example: Add a new remote
  }

  selectRemote(remote: any) {
    this.selectedRemote = remote;
  }

}
