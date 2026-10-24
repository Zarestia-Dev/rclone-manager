import { Component, ChangeDetectionStrategy, input } from '@angular/core';
import { DatePipe, TitleCasePipe } from '@angular/common';
import { TranslatePipe } from '@ngx-translate/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { JobInfoConfig } from '@app/types';

@Component({
  selector: 'app-job-info-panel',
  imports: [DatePipe, TitleCasePipe, MatCardModule, MatIconModule, TranslatePipe],
  styleUrls: ['./job-info-panel.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './job-info-panel.component.html',
})
export class JobInfoPanelComponent {
  readonly config = input.required<JobInfoConfig>();
}
