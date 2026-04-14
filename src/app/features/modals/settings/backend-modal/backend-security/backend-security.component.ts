import { Component, inject, OnInit, signal } from '@angular/core';
import {
  FormBuilder,
  FormGroup,
  ReactiveFormsModule,
  Validators,
  AbstractControl,
  ValidationErrors,
} from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatExpansionModule } from '@angular/material/expansion';
import { RclonePasswordService } from 'src/app/services/security/rclone-password.service';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NotificationService } from '@app/services';

function passwordMatchValidator(group: AbstractControl): ValidationErrors | null {
  const newPassword = group.get('newPassword')?.value;
  const confirmPassword = group.get('confirmPassword')?.value;
  return newPassword === confirmPassword ? null : { passwordMismatch: true };
}

@Component({
  selector: 'app-backend-security',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    MatSlideToggleModule,
    MatExpansionModule,
    TranslateModule,
  ],
  templateUrl: './backend-security.component.html',
  styleUrls: ['./backend-security.component.scss'],
})
export class BackendSecurityComponent implements OnInit {
  private readonly passwordService = inject(RclonePasswordService);
  private readonly fb = inject(FormBuilder);
  private readonly notificationService = inject(NotificationService);
  private readonly translate = inject(TranslateService);

  readonly showCurrentPassword = signal(false);
  readonly showNewPassword = signal(false);

  readonly showKeychainInput = signal(false);

  readonly isConfigEncrypted = signal<boolean | null>(null);
  readonly hasStoredPassword = signal(false);
  readonly encryptionLoading = signal(false);

  readonly securityForm: FormGroup = this.fb.group(
    {
      currentPassword: ['', Validators.required],
      newPassword: ['', Validators.required],
      confirmPassword: ['', Validators.required],
      keychainPassword: ['', Validators.required],
    },
    { validators: passwordMatchValidator }
  );

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

  onPanelOpened(): void {
    this.securityForm.reset();
    this.showCurrentPassword.set(false);
    this.showNewPassword.set(false);
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
    const passwordControl = this.securityForm.get('keychainPassword');
    const password = passwordControl?.value;

    if (!password) {
      passwordControl?.markAsTouched();
      return;
    }

    this.encryptionLoading.set(true);
    try {
      await this.passwordService.validatePassword(password);
      await this.passwordService.storePassword(password);
      this.notificationService.showSuccess(
        this.translate.instant('modals.backend.security.passwordStored')
      );
      this.showKeychainInput.set(false);
      passwordControl?.reset();
      await this.loadEncryptionStatus();
    } catch (error) {
      this.notificationService.showError(this.translate.instant(String(error)));
    } finally {
      this.encryptionLoading.set(false);
    }
  }

  async cancelKeychainStore(): Promise<void> {
    this.showKeychainInput.set(false);
    this.securityForm.patchValue({ keychainPassword: '' });
    await this.loadEncryptionStatus();
  }

  async submitEncrypt(): Promise<void> {
    if (this.isFormInvalidForEncrypt()) return;

    const { newPassword } = this.securityForm.value;

    this.encryptionLoading.set(true);
    try {
      await this.passwordService.encryptConfig(newPassword);
      await this.passwordService.storePassword(newPassword);
      await this.loadEncryptionStatus();
      this.notificationService.showSuccess(
        this.translate.instant('modals.backend.security.encrypted')
      );
      this.securityForm.reset();
    } catch (error) {
      this.notificationService.showError(this.translate.instant(String(error)));
    } finally {
      this.encryptionLoading.set(false);
    }
  }

  async submitDecrypt(): Promise<void> {
    const currentPasswordControl = this.securityForm.get('currentPassword');
    if (!currentPasswordControl?.value) {
      currentPasswordControl?.markAsTouched();
      return;
    }

    this.encryptionLoading.set(true);
    try {
      await this.passwordService.unencryptConfig(currentPasswordControl.value);
      await this.passwordService.removeStoredPassword();
      await this.loadEncryptionStatus();
      this.notificationService.showSuccess(
        this.translate.instant('modals.backend.security.removeEncryption')
      );
      this.securityForm.reset();
    } catch (error) {
      this.notificationService.showError(this.translate.instant(String(error)));
    } finally {
      this.encryptionLoading.set(false);
    }
  }

  async submitChangePassword(): Promise<void> {
    if (this.isFormInvalidForChangePassword()) return;

    const { currentPassword, newPassword } = this.securityForm.value;

    this.encryptionLoading.set(true);
    try {
      await this.passwordService.changeConfigPassword(currentPassword, newPassword);
      await this.passwordService.storePassword(newPassword);
      await this.loadEncryptionStatus();
      this.notificationService.showSuccess(
        this.translate.instant('modals.backend.security.passwordChanged')
      );
      this.securityForm.reset();
    } catch (error) {
      this.notificationService.showError(this.translate.instant(String(error)));
    } finally {
      this.encryptionLoading.set(false);
    }
  }

  async removeStoredPassword(): Promise<void> {
    this.encryptionLoading.set(true);
    try {
      await this.passwordService.removeStoredPassword();
      await this.loadEncryptionStatus();
      this.notificationService.showSuccess(
        this.translate.instant('modals.backend.security.passwordRemoved')
      );
    } catch (error) {
      this.notificationService.showError(this.translate.instant(String(error)));
      await this.loadEncryptionStatus();
    } finally {
      this.encryptionLoading.set(false);
    }
  }

  isFormInvalidForEncrypt(): boolean {
    return (
      !this.securityForm.get('newPassword')?.valid ||
      !this.securityForm.get('confirmPassword')?.valid ||
      this.securityForm.hasError('passwordMismatch')
    );
  }

  isFormInvalidForChangePassword(): boolean {
    return !this.securityForm.get('currentPassword')?.valid || this.isFormInvalidForEncrypt();
  }
}
