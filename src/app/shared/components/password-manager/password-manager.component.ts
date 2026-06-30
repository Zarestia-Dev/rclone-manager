import { Component, output, input, ChangeDetectionStrategy } from '@angular/core';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatIconModule } from '@angular/material/icon';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslatePipe } from '@ngx-translate/core';

@Component({
  selector: 'app-password-manager',
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  imports: [
    MatFormFieldModule,
    MatInputModule,
    MatIconModule,
    MatCheckboxModule,
    MatTooltipModule,
    TranslatePipe,
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
