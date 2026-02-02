import { Component, Output, EventEmitter, input, computed, signal, effect } from '@angular/core';

import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatIconModule } from '@angular/material/icon';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatButtonModule } from '@angular/material/button';
import { TranslateModule } from '@ngx-translate/core';

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
    TranslateModule,
  ],
  templateUrl: './password-manager.component.html',
  styleUrls: ['./password-manager.component.scss'],
})
export class PasswordManagerComponent {
  password = input('');
  storePassword = input(true);
  isSubmitting = input(false);
  hasError = input(false);
  errorMessage = input('');
  showStoreOption = input(true);
  disabled = input(false);
  placeholder = input('shared.passwordManager.placeholder');
  label = input('shared.passwordManager.label');

  @Output() passwordChange = new EventEmitter<string>();
  @Output() storePasswordChange = new EventEmitter<boolean>();
  @Output() unlock = new EventEmitter<void>();

  // Error counter - increments each time hasError becomes true (triggers shake animation)
  errorCount = signal(0);
  private lastErrorState = false;

  canSubmit = computed(() => !!(this.password() && !this.isSubmitting() && !this.disabled()));

  constructor() {
    // Use Angular effect() instead of setInterval for reactive error state monitoring
    effect(() => {
      const currentError = this.hasError();
      if (currentError && !this.lastErrorState) {
        // Error just occurred - increment counter to trigger animation
        this.errorCount.update(c => c + 1);
      }
      this.lastErrorState = currentError;
    });
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

  clearPassword(): void {
    this.passwordChange.emit('');
  }

  // Public method for parent to trigger shake
  shakeInput(): void {
    this.errorCount.update(c => c + 1);
  }
}
