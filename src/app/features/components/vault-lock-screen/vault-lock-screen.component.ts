import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { VaultService } from '../../../services/security/vault.service';

import { BackendTranslationService } from '../../../services/i18n/backend-translation.service';
import { AlertBannerComponent } from '../../../shared/components/alert-banner/alert-banner.component';

@Component({
  selector: 'app-vault-lock-screen',
  imports: [
    ReactiveFormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    TranslatePipe,
    AlertBannerComponent,
  ],
  templateUrl: './vault-lock-screen.component.html',
  styleUrl: './vault-lock-screen.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VaultLockScreenComponent {
  private readonly vaultService = inject(VaultService);
  private readonly translate = inject(TranslateService);
  private readonly backendTranslation = inject(BackendTranslationService);

  readonly passwordControl = new FormControl('', {
    nonNullable: true,
    validators: [Validators.required],
  });

  readonly lockForm = new FormGroup({
    password: this.passwordControl,
  });

  readonly showPassword = signal(false);
  readonly isSubmitting = this.vaultService.isBusy;
  readonly errorMessage = signal<string | null>(null);

  togglePasswordVisibility(): void {
    this.showPassword.update(show => !show);
  }

  async submitUnlock(event?: Event): Promise<void> {
    event?.preventDefault();

    if (this.passwordControl.invalid || this.isSubmitting()) {
      this.passwordControl.markAsTouched();
      return;
    }

    this.errorMessage.set(null);
    try {
      await this.vaultService.unlockVault(this.passwordControl.value);
    } catch (err) {
      const translated = this.backendTranslation.translateBackendMessage(err);
      this.errorMessage.set(translated || this.translate.instant('vault.errors.unlockFailed'));
    }
  }
}
