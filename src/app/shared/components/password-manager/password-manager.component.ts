import {
  Component,
  Input,
  Output,
  EventEmitter,
  OnInit,
  OnChanges,
  SimpleChanges,
  ChangeDetectorRef,
  inject,
} from '@angular/core';

import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatIconModule } from '@angular/material/icon';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatButtonModule } from '@angular/material/button';
import { FormatTimePipe } from '../../pipes/format-time.pipe';
import { AnimationsService } from '../../services/animations.service';

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
  animations: [AnimationsService.slideInOut()],
  templateUrl: './password-manager.component.html',
  styleUrls: ['./password-manager.component.scss'],
})
export class PasswordManagerComponent implements OnInit, OnChanges {
  @Input() password = '';
  @Input() storePassword = true;
  @Input() isSubmitting = false;
  @Input() hasError = false;
  @Input() errorMessage = '';
  @Input() showStoreOption = true;
  @Input() showSubmitButton = false;
  @Input() showPasswordStrength = false;
  @Input() disabled = false;
  @Input() placeholder = 'Enter your rclone config password';
  @Input() label = 'Configuration Password';
  @Input() shakeTrigger = 0;

  @Output() passwordChange = new EventEmitter<string>();
  @Output() storePasswordChange = new EventEmitter<boolean>();
  @Output() unlock = new EventEmitter<void>();

  // Animation state
  isEntering = false;

  // Shake state for wrong password feedback
  shouldShake = false;
  private isShaking = false;

  FormatTimePipe = new FormatTimePipe();

  private cdr = inject(ChangeDetectorRef);

  ngOnInit(): void {
    // Trigger entrance animation
    setTimeout(() => {
      this.isEntering = true;
      this.cdr.detectChanges();
    }, 50);
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['hasError']) {
      const prev = changes['hasError'].previousValue;
      const curr = changes['hasError'].currentValue;
      // If it changed from falsy -> truthy, trigger the shake
      if (!prev && curr && !this.isShaking) {
        this.triggerShake();
      }
    }
    if (changes['shakeTrigger'] && !this.isShaking) {
      this.triggerShake();
    }
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
    return !!(this.password && !this.isSubmitting && !this.disabled);
  }

  // Utility method for focus management
  focusPasswordInput(): void {
    const input = document.querySelector('.password-field input') as HTMLInputElement;
    if (input && !this.disabled) {
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
    this.shouldShake = true;
    this.isShaking = true;
    // Ensure change detection runs so template classes update immediately
    this.cdr.detectChanges();
    setTimeout(() => {
      this.shouldShake = false;
      this.isShaking = false;
      this.cdr.detectChanges();
    }, duration);
  }

  // Backwards-compatible method kept for external callers
  shakeInput(): void {
    this.triggerShake();
  }
}
