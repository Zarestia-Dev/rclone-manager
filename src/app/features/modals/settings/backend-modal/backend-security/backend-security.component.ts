import { ChangeDetectionStrategy, Component, inject, OnInit, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatExpansionModule } from '@angular/material/expansion';
import { RclonePasswordService } from 'src/app/services/security/rclone-password.service';
import { TranslatePipe } from '@ngx-translate/core';
import { AlertBannerComponent } from 'src/app/shared/components/alert-banner/alert-banner.component';
import { ValidatorRegistryService } from 'src/app/services/ui/validation/validator-registry.service';

@Component({
  selector: 'app-backend-security',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatSlideToggleModule,
    MatExpansionModule,
    TranslatePipe,
    AlertBannerComponent,
  ],
  templateUrl: './backend-security.component.html',
  styleUrls: ['./backend-security.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BackendSecurityComponent implements OnInit {
  private readonly passwordService = inject(RclonePasswordService);
  private readonly validatorRegistry = inject(ValidatorRegistryService);
  private readonly fb = inject(FormBuilder);

  readonly showCurrentPassword = signal(false);
  readonly showNewPassword = signal(false);
  readonly showKeychainPassword = signal(false);

  readonly showKeychainInput = signal(false);

  readonly isConfigEncrypted = signal<boolean | null>(null);
  readonly hasStoredPassword = signal(false);
  readonly encryptionLoading = signal(false);

  readonly keychainPassword = this.fb.control('', [Validators.required]);

  readonly encryptForm = this.fb.group(
    {
      newPassword: ['', [Validators.required]],
      confirmPassword: ['', [Validators.required]],
    },
    {
      validators: this.validatorRegistry.passwordMatchValidator('newPassword', 'confirmPassword'),
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

  readonly decryptPassword = this.fb.control('', [Validators.required]);

  async ngOnInit(): Promise<void> {
    await this.loadEncryptionStatus();
  }

  private async loadEncryptionStatus(): Promise<void> {
    try {
      const [hasPassword, isEncrypted] = await Promise.all([
        this.passwordService.hasStoredPassword(),
        this.passwordService.isConfigEncrypted(),
      ]);
      this.hasStoredPassword.set(hasPassword);
      this.isConfigEncrypted.set(isEncrypted);
    } catch (error) {
      console.error('Failed to load encryption status:', error);
    }
  }

  toggleCurrentPasswordVisibility(): void {
    this.showCurrentPassword.update(v => !v);
  }

  toggleNewPasswordVisibility(): void {
    this.showNewPassword.update(v => !v);
  }

  toggleKeychainPasswordVisibility(): void {
    this.showKeychainPassword.update(v => !v);
  }

  onPanelOpened(): void {
    this.encryptForm.reset();
    this.changePasswordForm.reset();
    this.decryptPassword.reset();
    this.showCurrentPassword.set(false);
    this.showNewPassword.set(false);
    this.showKeychainPassword.set(false);
  }

  async onKeychainToggle(event: { checked: boolean }): Promise<void> {
    if (!event.checked) {
      this.showKeychainInput.set(false);
      await this.removeStoredPassword();
    } else {
      this.showKeychainInput.set(true);
    }
  }

  async submitKeychainStore(): Promise<void> {
    if (this.keychainPassword.invalid) {
      this.keychainPassword.markAsTouched();
      return;
    }

    const password = this.keychainPassword.value || '';
    this.encryptionLoading.set(true);
    try {
      await this.passwordService.validatePassword(password);
      await this.passwordService.storePassword(password);
      this.showKeychainInput.set(false);
      this.keychainPassword.reset();
      this.showKeychainPassword.set(false);
      await this.loadEncryptionStatus();
    } catch (error) {
      console.error('Failed to store password in keychain:', error);
    } finally {
      this.encryptionLoading.set(false);
    }
  }

  async cancelKeychainStore(): Promise<void> {
    this.showKeychainInput.set(false);
    this.keychainPassword.reset();
    this.showKeychainPassword.set(false);
    await this.loadEncryptionStatus();
  }

  async submitEncrypt(): Promise<void> {
    if (this.encryptForm.invalid) {
      this.encryptForm.markAllAsTouched();
      return;
    }

    const newPassword = this.encryptForm.value.newPassword || '';
    this.encryptionLoading.set(true);
    try {
      await this.passwordService.encryptConfig(newPassword);
      await this.passwordService.storePassword(newPassword, { showSuccess: false });
      await this.loadEncryptionStatus();
      this.encryptForm.reset();
    } catch (error) {
      console.error('Failed to encrypt config:', error);
    } finally {
      this.encryptionLoading.set(false);
    }
  }

  async submitDecrypt(): Promise<void> {
    if (this.decryptPassword.invalid) {
      this.decryptPassword.markAsTouched();
      return;
    }

    const password = this.decryptPassword.value || '';
    this.encryptionLoading.set(true);
    try {
      await this.passwordService.unencryptConfig(password);
      await this.passwordService.removeStoredPassword({ showSuccess: false });
      await this.loadEncryptionStatus();
      this.decryptPassword.reset();
    } catch (error) {
      console.error('Failed to unencrypt config:', error);
    } finally {
      this.encryptionLoading.set(false);
    }
  }

  async submitChangePassword(): Promise<void> {
    if (this.changePasswordForm.invalid) {
      this.changePasswordForm.markAllAsTouched();
      return;
    }

    const { currentPassword, newPassword } = this.changePasswordForm.value;
    if (!currentPassword || !newPassword) return;

    this.encryptionLoading.set(true);
    try {
      await this.passwordService.changeConfigPassword(currentPassword, newPassword);
      await this.passwordService.storePassword(newPassword, { showSuccess: false });
      await this.loadEncryptionStatus();
      this.changePasswordForm.reset();
    } catch (error) {
      console.error('Failed to change password:', error);
    } finally {
      this.encryptionLoading.set(false);
    }
  }

  async removeStoredPassword(): Promise<void> {
    this.encryptionLoading.set(true);
    try {
      await this.passwordService.removeStoredPassword();
      await this.loadEncryptionStatus();
    } catch (error) {
      console.error('Failed to remove stored password:', error);
      await this.loadEncryptionStatus();
    } finally {
      this.encryptionLoading.set(false);
    }
  }
}
