import { ChangeDetectionStrategy, Component, inject, OnInit, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogRef } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatExpansionModule } from '@angular/material/expansion';
import { TranslatePipe } from '@ngx-translate/core';
import { VaultService } from '../../../../services/security/vault.service';
import { ValidatorRegistryService } from '../../../../services/ui/validation/validator-registry.service';
import { EscapeCloseDirective } from '../../../../shared/directives/escape-close.directive';
import { AlertBannerComponent } from '../../../../shared/components/alert-banner/alert-banner.component';

interface TimeoutOption {
  value: number;
  labelKey: string;
}

@Component({
  selector: 'app-vault-modal',
  hostDirectives: [EscapeCloseDirective],
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatExpansionModule,
    TranslatePipe,
    AlertBannerComponent,
  ],
  templateUrl: './vault-modal.component.html',
  styleUrls: ['./vault-modal.component.scss', '../../../../styles/_shared-modal.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VaultModalComponent implements OnInit {
  private readonly dialogRef = inject(MatDialogRef<VaultModalComponent>);
  private readonly vaultService = inject(VaultService);
  private readonly fb = inject(FormBuilder);
  private readonly validatorRegistry = inject(ValidatorRegistryService);

  readonly isVaultEnabled = this.vaultService.isVaultEnabled;
  readonly lockTimeoutSecs = this.vaultService.lockTimeoutSecs;
  readonly isBusy = this.vaultService.isBusy;

  readonly showEnablePassword = signal(false);
  readonly showEnableConfirm = signal(false);
  readonly showChangeCurrent = signal(false);
  readonly showChangeNew = signal(false);
  readonly showChangeConfirm = signal(false);
  readonly showDisablePassword = signal(false);

  readonly timeoutOptions: TimeoutOption[] = [
    { value: 0, labelKey: 'vault.timeout.never' },
    { value: 300, labelKey: 'vault.timeout.5m' },
    { value: 900, labelKey: 'vault.timeout.15m' },
    { value: 1800, labelKey: 'vault.timeout.30m' },
    { value: 3600, labelKey: 'vault.timeout.1h' },
  ];

  readonly enableForm = this.fb.group(
    {
      password: ['', [Validators.required]],
      confirmPassword: ['', [Validators.required]],
      timeoutSecs: [300],
    },
    {
      validators: this.validatorRegistry.passwordMatchValidator('password', 'confirmPassword'),
    }
  );

  readonly changePasswordForm = this.fb.group(
    {
      currentPassword: ['', [Validators.required]],
      newPassword: ['', [Validators.required]],
      confirmPassword: ['', [Validators.required]],
    },
    {
      validators: this.validatorRegistry.passwordMatchValidator('newPassword', 'confirmPassword'),
    }
  );

  readonly disableForm = this.fb.group({
    password: ['', [Validators.required]],
  });

  ngOnInit(): void {
    void this.vaultService.checkVaultStatus().catch(() => {
      // Best-effort status refresh when opening vault modal
    });
  }

  close(): void {
    this.dialogRef.close();
  }

  async submitEnableVault(): Promise<void> {
    if (this.enableForm.invalid || this.isBusy()) {
      this.enableForm.markAllAsTouched();
      return;
    }

    const { password, timeoutSecs } = this.enableForm.value;
    if (!password) return;

    try {
      await this.vaultService.enableVault(password, timeoutSecs ?? 300);
      this.enableForm.reset({ timeoutSecs: 300 });
    } catch {
      // Error handled with notification
    }
  }

  async submitChangePassword(): Promise<void> {
    if (this.changePasswordForm.invalid || this.isBusy()) {
      this.changePasswordForm.markAllAsTouched();
      return;
    }

    const { currentPassword, newPassword } = this.changePasswordForm.value;
    if (!currentPassword || !newPassword) return;

    try {
      await this.vaultService.changeVaultPassword(currentPassword, newPassword);
      this.changePasswordForm.reset();
    } catch {
      // Error handled with notification
    }
  }

  async submitDisableVault(): Promise<void> {
    if (this.disableForm.invalid || this.isBusy()) {
      this.disableForm.markAllAsTouched();
      return;
    }

    const password = this.disableForm.value.password;
    if (!password) return;

    try {
      await this.vaultService.disableVault(password);
      this.disableForm.reset();
    } catch {
      // Error handled with notification
    }
  }

  async onTimeoutChange(timeoutSecs: number): Promise<void> {
    if (this.isBusy()) return;
    try {
      await this.vaultService.setVaultLockTimeout(timeoutSecs);
    } catch {
      // Error handled with notification
    }
  }

  async lockNow(): Promise<void> {
    if (this.isBusy()) return;
    try {
      await this.vaultService.lockVault();
      this.close();
    } catch {
      // Error handled
    }
  }
}
