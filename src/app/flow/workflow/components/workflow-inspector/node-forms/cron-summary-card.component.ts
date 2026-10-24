import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';

@Component({
  selector: 'app-cron-summary-card',
  standalone: true,
  imports: [MatButtonModule, MatIconModule, TranslatePipe],
  template: `
    <div class="operation-summary-card">
      <div class="summary-prop-row">
        <span class="prop-label">{{ 'flow.workflow.inspector.cronExpression' | translate }}</span>
        <div class="prop-badge remote-badge">
          <mat-icon svgIcon="clock" class="prop-icon"></mat-icon>
          <span class="prop-value font-semibold code-font">
            {{ cronExpression() || '0 2 * * *' }}
          </span>
        </div>
      </div>

      <div class="summary-prop-row">
        <span class="prop-label">{{ 'wizards.appOperation.yourSchedule' | translate }}</span>
        <span class="prop-value" [class.text-warn]="isCronInvalid()">
          {{ cronHumanReadable() || ('flow.workflow.inspector.cronDaily' | translate) }}
        </span>
      </div>

      <!-- Edit in Modal CTA Button -->
      <button
        matButton="filled"
        type="button"
        class="btn-edit-config"
        (click)="openDetailed.emit()"
        [attr.title]="'flow.workflow.inspector.openDetailedTooltip' | translate"
      >
        <mat-icon svgIcon="tune"></mat-icon>
        <span>{{ 'flow.workflow.inspector.openDetailed' | translate }}</span>
      </button>
    </div>
  `,
  styleUrl: '../workflow-inspector.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CronSummaryCardComponent {
  readonly cronExpression = input<string>('0 2 * * *');
  readonly cronHumanReadable = input<string>('');
  readonly isCronInvalid = input<boolean>(false);
  readonly openDetailed = output<void>();
}
