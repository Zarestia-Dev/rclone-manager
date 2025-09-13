import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatIconModule } from '@angular/material/icon';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { PasswordLockoutStatus } from '@app/types';

@Component({
  selector: 'app-password-manager',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatIconModule,
    MatCheckboxModule,
    MatButtonModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
  ],
  templateUrl: './password-manager.component.html',
  styleUrls: ['./password-manager.component.scss'],
})
export class PasswordManagerComponent {
  @Input() password = '';
  @Input() storePassword = true;
  @Input() isSubmitting = false;
  @Input() hasError = false;
  @Input() errorMessage = '';
  @Input() lockoutStatus: PasswordLockoutStatus | null = null;
  @Input() showStoreOption = true;
  @Input() disabled = false;

  @Output() passwordChange = new EventEmitter<string>();
  @Output() storePasswordChange = new EventEmitter<boolean>();
  @Output() unlock = new EventEmitter<void>();

  onPasswordInput(value: string): void {
    this.passwordChange.emit(value || '');
  }

  onStoreChange(value: boolean): void {
    this.storePasswordChange.emit(value);
  }

  onSubmit(): void {
    if (this.canSubmit()) {
      this.unlock.emit();
    }
  }

  canSubmit(): boolean {
    return !!(
      this.password &&
      !this.isSubmitting &&
      !this.lockoutStatus?.is_locked &&
      !this.disabled
    );
  }

  formatTime(seconds: number): string {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes > 0) {
      return `${minutes}m ${remainingSeconds}s`;
    }
    return `${remainingSeconds}s`;
  }
}
