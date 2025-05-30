import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatSidenavModule } from '@angular/material/sidenav';
import { Remote } from '../../shared/components/types';

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
  @Output() remoteSelected = new EventEmitter<Remote>();

  selectRemote(remote: Remote): void {
    this.remoteSelected.emit(remote); // Emit event when a remote is selected
  }
}
