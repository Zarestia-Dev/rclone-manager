import {
  Component,
  Input,
  Output,
  EventEmitter,
  OnInit,
  OnDestroy,
  ChangeDetectorRef,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatIconModule } from '@angular/material/icon';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatButtonModule } from '@angular/material/button';
import { PasswordLockoutStatus } from '@app/types';
import { FormatTimePipe } from '../../pipes/format-time.pipe';

export interface PasswordStrength {
  score: number; // 0-4 scale
  feedback: string[];
  level: 'weak' | 'medium' | 'strong';
}

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
    MatTooltipModule,
    MatButtonModule,
  ],
  templateUrl: './password-manager.component.html',
  styleUrls: ['./password-manager.component.scss'],
})
export class PasswordManagerComponent implements OnInit, OnDestroy {
  @Input() password = '';
  @Input() storePassword = true;
  @Input() isSubmitting = false;
  @Input() hasError = false;
  @Input() errorMessage = '';
  @Input() lockoutStatus: PasswordLockoutStatus | null = null;
  @Input() showStoreOption = true;
  @Input() showSubmitButton = false;
  @Input() showPasswordStrength = false;
  @Input() disabled = false;
  @Input() placeholder = 'Enter your rclone config password';
  @Input() label = 'Configuration Password';

  @Output() passwordChange = new EventEmitter<string>();
  @Output() storePasswordChange = new EventEmitter<boolean>();
  @Output() unlock = new EventEmitter<void>();
  @Output() passwordStrengthChange = new EventEmitter<PasswordStrength>();

  // Animation state
  isEntering = false;

  // Internal state
  private lockoutTimer?: number;
  private previousLockoutTime?: number;

  FormatTimePipe = new FormatTimePipe();

  private cdr = inject(ChangeDetectorRef);

  ngOnInit(): void {
    // Trigger entrance animation
    setTimeout(() => {
      this.isEntering = true;
      this.cdr.detectChanges();
    }, 50);

    // Start lockout timer if needed
    if (this.lockoutStatus?.is_locked && this.lockoutStatus.remaining_lockout_time) {
      this.startLockoutTimer();
    }
  }

  ngOnDestroy(): void {
    this.clearLockoutTimer();
  }

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

  getAttemptsRemainingText(lockoutStatus: PasswordLockoutStatus): string {
    const remaining = lockoutStatus.max_attempts - lockoutStatus.failed_attempts;

    if (remaining <= 1) {
      return 'Next failed attempt will lock the account';
    } else if (remaining <= 2) {
      return `${remaining} attempts remaining before lockout`;
    } else {
      return `${remaining} attempts remaining`;
    }
  }

  private startLockoutTimer(): void {
    this.clearLockoutTimer();

    if (!this.lockoutStatus?.remaining_lockout_time) return;

    this.previousLockoutTime = this.lockoutStatus.remaining_lockout_time;

    this.lockoutTimer = window.setInterval(() => {
      if (this.lockoutStatus && this.lockoutStatus.remaining_lockout_time) {
        this.lockoutStatus.remaining_lockout_time -= 1;

        // Update the UI
        this.cdr.detectChanges();

        // Clear timer when time is up
        if (this.lockoutStatus.remaining_lockout_time <= 0) {
          this.clearLockoutTimer();
          // Optionally emit an event that lockout has ended
          this.unlock.emit();
        }
      } else {
        this.clearLockoutTimer();
      }
    }, 1000);
  }

  private clearLockoutTimer(): void {
    if (this.lockoutTimer) {
      clearInterval(this.lockoutTimer);
      this.lockoutTimer = undefined;
    }
  }

  // Method to handle lockout status changes from parent
  updateLockoutStatus(newStatus: PasswordLockoutStatus | null): void {
    const wasLocked = this.lockoutStatus?.is_locked;
    const isNowLocked = newStatus?.is_locked;

    this.lockoutStatus = newStatus;

    // Start timer if newly locked
    if (!wasLocked && isNowLocked && newStatus?.remaining_lockout_time) {
      this.startLockoutTimer();
    }

    // Clear timer if no longer locked
    if (wasLocked && !isNowLocked) {
      this.clearLockoutTimer();
    }

    this.cdr.detectChanges();
  }

  // Utility method for focus management
  focusPasswordInput(): void {
    const input = document.querySelector('.password-field input') as HTMLInputElement;
    if (input && !this.disabled && !this.lockoutStatus?.is_locked) {
      input.focus();
    }
  }

  // Method to clear the password (useful for parent components)
  clearPassword(): void {
    this.passwordChange.emit('');
  }

  shakeInput(): void {
    const field = document.querySelector('.password-field-container');
    if (field) {
      field.classList.add('shake');
      setTimeout(() => field.classList.remove('shake'), 600);
    }
  }
}
