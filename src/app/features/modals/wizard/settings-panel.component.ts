import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { TranslatePipe } from '@ngx-translate/core';
import { PillDirective } from 'src/app/shared/directives/pill.directive';
import type { WizardDestinationSetting } from 'src/app/shared/utils/wizard.util';
import { WizardState } from './wizard.state';

/** The wizard's own settings: whether it opens after a cloud is added, and where it keeps setups. */
@Component({
  selector: 'app-wizard-settings-panel',
  imports: [MatIconModule, MatSlideToggleModule, TranslatePipe, PillDirective],
  templateUrl: './settings-panel.component.html',
  styleUrls: ['./settings-panel.component.scss', './wizard-shared.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WizardSettingsPanelComponent {
  protected readonly state = inject(WizardState);
  protected readonly options: readonly {
    id: WizardDestinationSetting;
    icon: string;
    label: string;
  }[] = [
    { id: 'auto', icon: 'wand', label: 'modals.wizard.settings.auto' },
    { id: 'profile', icon: 'server', label: 'modals.wizard.review.destination.profile' },
    { id: 'quick_run', icon: 'bolt', label: 'modals.wizard.review.destination.quickRun' },
  ];
}
