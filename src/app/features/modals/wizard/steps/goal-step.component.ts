import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { TranslatePipe } from '@ngx-translate/core';
import { PillDirective } from 'src/app/shared/directives/pill.directive';
import { goalTone } from 'src/app/shared/utils/wizard.util';
import { WizardState } from '../wizard.state';
import { IconService } from 'src/app/services/ui/icon.service';

@Component({
  selector: 'app-wizard-goal-step',
  imports: [MatIconModule, MatSlideToggleModule, TranslatePipe, PillDirective],
  templateUrl: './goal-step.component.html',
  styleUrls: ['./goal-step.component.scss', '../wizard-shared.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WizardGoalStepComponent {
  protected readonly state = inject(WizardState);
  protected readonly iconService = inject(IconService);

  /** The cards: each goal with the colour and the words it has on this device and cloud. */
  protected readonly cards = computed(() => {
    const phone = !!this.state.env()?.isAndroid;
    const app = this.state.appBrand();
    return this.state.goals.map(goal => {
      const key = `modals.wizard.goals.${goal.id}`;
      const access = goal.id === 'access';
      return {
        goal,
        tone: goalTone(goal),
        title: access && phone ? `${key}.titlePhone` : `${key}.title`,
        description:
          access && phone
            ? `${key}.descriptionPhone`
            : access && app
              ? `${key}.descriptionApp`
              : `${key}.description`,
        params: { app },
      };
    });
  });
}
