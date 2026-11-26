import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import { AlertBannerComponent } from 'src/app/shared/components/alert-banner/alert-banner.component';
import { CopyToClipboardDirective } from 'src/app/shared/directives/copy-to-clipboard.directive';
import { WizardState } from '../wizard.state';

@Component({
  selector: 'app-wizard-done-step',
  imports: [
    NgTemplateOutlet,
    MatButtonModule,
    MatIconModule,
    TranslatePipe,
    AlertBannerComponent,
    CopyToClipboardDirective,
  ],
  templateUrl: './done-step.component.html',
  styleUrls: ['./done-step.component.scss', '../wizard-shared.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WizardDoneStepComponent {
  protected readonly state = inject(WizardState);
}
