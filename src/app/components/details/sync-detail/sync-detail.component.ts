import { CommonModule } from '@angular/common';
import { Component, Input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

@Component({
  selector: 'app-sync-detail',
  imports: [MatIconModule, CommonModule, MatTooltipModule],
  templateUrl: './sync-detail.component.html',
  styleUrl: './sync-detail.component.scss'
})
export class SyncDetailComponent {
  @Input() selectedRemote: any = null;
  @Input() remoteSettings: { [key: string]: { [key: string]: any } } = {};
  
}
