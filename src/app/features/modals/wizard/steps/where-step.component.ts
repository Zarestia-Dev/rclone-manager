import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { PillDirective } from 'src/app/shared/directives/pill.directive';
import { AlertBannerComponent } from 'src/app/shared/components/alert-banner/alert-banner.component';
import { NumberInputComponent } from 'src/app/shared/components/number-input/number-input.component';
import { PathFieldComponent } from 'src/app/shared/components/path-field/path-field.component';
import { WindowsMountTargetComponent } from 'src/app/shared/remote-config/windows-mount-target/windows-mount-target.component';
import { WizardState } from '../wizard.state';
import { IconService } from 'src/app/services/ui/icon.service';

@Component({
  selector: 'app-wizard-where-step',
  imports: [
    NgTemplateOutlet,
    MatIconModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatSlideToggleModule,
    FormsModule,
    TranslatePipe,
    PillDirective,
    AlertBannerComponent,
    NumberInputComponent,
    PathFieldComponent,
    WindowsMountTargetComponent,
  ],
  templateUrl: './where-step.component.html',
  styleUrls: ['./where-step.component.scss', '../wizard-shared.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WizardWhereStepComponent {
  protected readonly state = inject(WizardState);
  protected readonly iconService = inject(IconService);
}
