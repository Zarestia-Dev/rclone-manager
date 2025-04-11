import { CommonModule } from '@angular/common';
import { Component, Input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

@Component({
  selector: 'app-job-detail',
  imports: [MatIconModule, CommonModule, MatTooltipModule],
  templateUrl: './job-detail.component.html',
  styleUrl: './job-detail.component.scss'
})
export class JobDetailComponent {
  @Input() selectedRemote: any = null;
  @Input() remoteSettings: { [key: string]: { [key: string]: any } } = {};
}
