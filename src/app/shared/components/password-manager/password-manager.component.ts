import {
  Component,
  Output,
  EventEmitter,
  OnInit,
  input,
  computed,
  signal,
  effect,
} from '@angular/core';

import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatIconModule } from '@angular/material/icon';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatButtonModule } from '@angular/material/button';
import { FormatTimePipe } from '../../pipes/format-time.pipe';

@Component({
  selector: 'app-password-manager',
  standalone: true,
  imports: [
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
export class PasswordManagerComponent implements OnInit {
  password = input('');
  storePassword = input(true);
  isSubmitting = input(false);
  hasError = input(false);
  errorMessage = input('');
  showStoreOption = input(true);
  showSubmitButton = input(false);
  showPasswordStrength = input(false);
  disabled = input(false);
  placeholder = input('Enter your rclone config password');
  label = input('Configuration Password');
  shakeTrigger = input(0);

  @Output() passwordChange = new EventEmitter<string>();
  @Output() storePasswordChange = new EventEmitter<boolean>();
  @Output() unlock = new EventEmitter<void>();

  // Animation state
  isEntering = signal(false);

  // Shake state for wrong password feedback
  shouldShake = signal(false);
  private isShaking = signal(false);

  FormatTimePipe = new FormatTimePipe();

  canSubmit = computed(() => !!(this.password() && !this.isSubmitting() && !this.disabled()));

  constructor() {
    effect(() => {
      // Trigger shake on hasError input change
      if (this.hasError() && !this.isShaking()) {
        this.triggerShake();
      }
    });
    effect(() => {
      // Trigger shake on shakeTrigger input change
      if (this.shakeTrigger() > 0 && !this.isShaking()) {
        this.triggerShake();
      }
    });
  }

  ngOnInit(): void {
    // Trigger entrance animation
    setTimeout(() => {
      this.isEntering.set(true);
    }, 50);
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

  // Utility method for focus management
  focusPasswordInput(): void {
    const input = document.querySelector('.password-field input') as HTMLInputElement;
    if (input && !this.disabled()) {
      input.focus();
    }
  }

  // Method to clear the password (useful for parent components)
  clearPassword(): void {
    this.passwordChange.emit('');
  }

  /**
   * Trigger a shake animation on the input/description.
   * Keeps state in a property so Angular templates and tests can interact predictably.
   */
  triggerShake(duration = 600): void {
    this.shouldShake.set(true);
    this.isShaking.set(true);
    setTimeout(() => {
      this.shouldShake.set(false);
      this.isShaking.set(false);
    }, duration);
  }

  // Backwards-compatible method kept for external callers
  shakeInput(): void {
    this.triggerShake();
  }
}
