import { Component, output, input } from '@angular/core';

import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatIconModule } from '@angular/material/icon';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatTooltipModule } from '@angular/material/tooltip';
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

  passwordChange = output<string>();
  storePasswordChange = output<boolean>();
  unlock = output<void>();

  onPasswordInput(value: string): void {
    this.passwordChange.emit(value || '');
  }

  onStoreChange(value: boolean): void {
    this.storePasswordChange.emit(value);
  }

  onSubmit(): void {
    if (this.password() && !this.isSubmitting() && !this.disabled()) {
      this.unlock.emit();
    }
  }
}
