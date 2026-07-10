import { Component, ChangeDetectionStrategy, inject, input, output, signal } from '@angular/core';
import { FormsModule, FormControl, ReactiveFormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSelectModule } from '@angular/material/select';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';

import { RemoteManagementService } from 'src/app/services/remote/remote-management.service';
import { CopyToClipboardDirective } from '../../directives/copy-to-clipboard.directive';
import { RcloneOptionTranslatePipe } from '@app/pipes';

@Component({
  selector: 'app-obscure-tool',
  imports: [
    FormsModule,
    ReactiveFormsModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatTooltipModule,
    MatSelectModule,
    TranslatePipe,
    RcloneOptionTranslatePipe,
    CopyToClipboardDirective,
  ],
  templateUrl: './obscure-tool.component.html',
  styleUrl: './obscure-tool.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ObscureToolComponent {
  private readonly remoteService = inject(RemoteManagementService);
  readonly translate = inject(TranslateService);

  // Inputs & Outputs
  readonly visible = input(false);
  readonly sensitiveFields = input<{ name: string; key: string; help: string }[]>([]);
  readonly provider = input<string | null>(null);
  readonly applyObscured = output<{ key: string; value: string }>();

  // State Signals
  readonly clearText = signal('');
  readonly obscuredText = signal('');
  readonly hidePassword = signal(true);
  readonly isProcessing = signal(false);
  readonly error = signal<string | null>(null);

  // Form Controls
  readonly targetFieldCtrl = new FormControl('');

  togglePasswordVisibility(): void {
    this.hidePassword.update(v => !v);
  }

  async performObscure(): Promise<void> {
    const raw = this.clearText().trim();
    if (!raw) {
      this.clearInputs();
      return;
    }

    this.isProcessing.set(true);
    this.error.set(null);

    try {
      const res = await this.remoteService.obscureValue(raw);
      this.obscuredText.set(res);
    } catch (e: any) {
      console.error('Failed to obscure string:', e);
      this.error.set(e.message || 'Failed to obscure value');
      this.obscuredText.set('');
    } finally {
      this.isProcessing.set(false);
    }
  }

  applyToField(): void {
    const targetKey = this.targetFieldCtrl.value;
    const val = this.obscuredText();
    if (targetKey && val) {
      this.applyObscured.emit({ key: targetKey, value: val });
    }
  }

  clearInputs(): void {
    this.clearText.set('');
    this.obscuredText.set('');
    this.error.set(null);
    this.targetFieldCtrl.setValue('');
  }
}
