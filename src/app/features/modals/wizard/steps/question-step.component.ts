import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import { PillDirective } from 'src/app/shared/directives/pill.directive';
import { AlertBannerComponent } from 'src/app/shared/components/alert-banner/alert-banner.component';
import { WizardState } from '../wizard.state';

@Component({
  selector: 'app-wizard-question-step',
  imports: [MatIconModule, TranslatePipe, PillDirective, AlertBannerComponent],
  templateUrl: './question-step.component.html',
  styleUrl: '../wizard-shared.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WizardQuestionStepComponent {
  protected readonly state = inject(WizardState);
}
