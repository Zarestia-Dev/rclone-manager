import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';

@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './sidebar.component.html',
  styleUrl: './sidebar.component.scss'
})
export class SidebarComponent {
  @Input() remotes: any[] = []; // Input: List of remotes
  @Output() remoteSelected = new EventEmitter<any>(); // Output: Emit selected remote

  onRemoteClick(remote: any) {
    this.remoteSelected.emit(remote);
  }
}
