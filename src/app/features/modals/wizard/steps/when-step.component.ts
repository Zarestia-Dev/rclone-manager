import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { AlertBannerComponent } from 'src/app/shared/components/alert-banner/alert-banner.component';
import { CronInputComponent } from 'src/app/shared/remote-config/cron-input/cron-input.component';
import { NumberInputComponent } from 'src/app/shared/components/number-input/number-input.component';
import { WizardState } from '../wizard.state';

@Component({
  selector: 'app-wizard-when-step',
  imports: [
    NgTemplateOutlet,
    MatIconModule,
    FormsModule,
    TranslatePipe,
    AlertBannerComponent,
    CronInputComponent,
    NumberInputComponent,
  ],
  templateUrl: './when-step.component.html',
  styleUrls: ['./when-step.component.scss', '../wizard-shared.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WizardWhenStepComponent {
  protected readonly state = inject(WizardState);
}
