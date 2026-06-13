import { ChangeDetectionStrategy, Component, inject, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { MatProgressBar } from '@angular/material/progress-bar';
import { TranslateModule } from '@ngx-translate/core';
import { RemoteConfigStateService } from 'src/app/services/remote/remote-config-state.service';

@Component({
  selector: 'app-config-modal-footer',
  standalone: true,
  imports: [MatButtonModule, MatIconModule, MatProgressSpinner, MatProgressBar, TranslateModule],
  templateUrl: './config-modal-footer.component.html',
  styleUrl: './config-modal-footer.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConfigModalFooterComponent {
  readonly state = inject(RemoteConfigStateService);

  readonly prevStep = output<void>();
  readonly nextStep = output<void>();
  readonly submitForm = output<void>();
  readonly cancelAuth = output<void>();
  readonly interactiveContinue = output<string | number | boolean | null>();
}
