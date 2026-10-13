import { Component, input, computed, ChangeDetectionStrategy } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { TranslatePipe } from '@ngx-translate/core';
import { FormatFileSizePipe } from '@app/pipes';
import { ProvisionProgressPayload } from '@app/types';

@Component({
  selector: 'app-provision-progress',
  imports: [DecimalPipe, MatIconModule, MatProgressBarModule, TranslatePipe, FormatFileSizePipe],
  templateUrl: './provision-progress.component.html',
  styleUrls: ['./provision-progress.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProvisionProgressComponent {
  readonly progress = input<ProvisionProgressPayload | null>(null);

  readonly percentage = computed(() => {
    const prog = this.progress();
    if (!prog || !prog.totalBytes || prog.totalBytes <= 0) return null;
    return Math.min(100, Math.max(0, (prog.downloadedBytes / prog.totalBytes) * 100));
  });
}
