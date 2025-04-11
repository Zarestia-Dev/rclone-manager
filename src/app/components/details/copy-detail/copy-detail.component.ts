import { CommonModule } from '@angular/common';
import { Component, Input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

@Component({
  selector: 'app-copy-detail',
  imports: [MatIconModule, CommonModule, MatTooltipModule],
  templateUrl: './copy-detail.component.html',
  styleUrl: './copy-detail.component.scss'
})
export class CopyDetailComponent {
  @Input() selectedRemote: any = null;
  @Input() remoteSettings: { [key: string]: { [key: string]: any } } = {};
  
}
