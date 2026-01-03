import { Component, inject, OnInit, signal } from '@angular/core';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatDialogRef, MatDialog } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { BackendService } from 'src/app/services/system/backend.service';
import type { BackendInfo } from 'src/app/shared/types/backend.types';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatTabsModule } from '@angular/material/tabs';
import { ConfirmModalComponent } from 'src/app/shared/modals/confirm-modal/confirm-modal.component';
import { firstValueFrom } from 'rxjs';
import { BackendSecurityComponent } from './backend-security/backend-security.component';
import { TranslateModule, TranslateService } from '@ngx-translate/core';

@Component({
  selector: 'app-backend-modal',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    MatCheckboxModule,
    MatSnackBarModule,
    MatTabsModule,
    BackendSecurityComponent,
    TranslateModule,
  ],
  templateUrl: './backend-modal.component.html',
  styleUrls: ['./backend-modal.component.scss', '../../../../styles/_shared-modal.scss'],
})
export class BackendModalComponent implements OnInit {
  private readonly dialogRef = inject(MatDialogRef<BackendModalComponent>);
  private readonly backendService = inject(BackendService);
  private readonly fb = inject(FormBuilder);
  private readonly snackBar = inject(MatSnackBar);
  private readonly dialog = inject(MatDialog);
  private readonly translate = inject(TranslateService);

  // State
  readonly backends = this.backendService.backends;
  readonly activeBackend = this.backendService.activeBackend;
  readonly isLoading = this.backendService.isLoading;

  // UI state - consolidated form state
  readonly formState = signal<{ mode: 'closed' | 'add' | 'edit'; editingName?: string }>({
    mode: 'closed',
  });
  readonly testingBackend = signal<string | null>(null);
  readonly switchingTo = signal<string | null>(null);
  readonly showPassword = signal(false);
  readonly showConfigPassword = signal(false);

  // Backend form
  backendForm: FormGroup = this.fb.group({
    name: ['', [Validators.required, Validators.pattern(/^[^/\\:*?"<>|]+$/)]],
    host: ['localhost', [Validators.required]],
    port: [51900, [Validators.required, Validators.min(1024), Validators.max(65535)]],
    username: [''],
    password: [''],
    config_password: [''],
    has_auth: [false],
    // OAuth fields (for Local backend)
    oauth_host: ['127.0.0.1'],
    oauth_port: [51901, [Validators.min(1024), Validators.max(65535)]],
  });

  async ngOnInit(): Promise<void> {
    await this.backendService.loadBackends();
  }

  close(): void {
    this.dialogRef.close();
  }

  toggleAddForm(): void {
    const current = this.formState();
    if (current.mode === 'closed') {
      this.formState.set({ mode: 'add' });
    } else {
      this.formState.set({ mode: 'closed' });
      this.resetForm();
    }
  }

  startEdit(backend: BackendInfo): void {
    this.formState.set({ mode: 'edit', editingName: backend.name });

    this.backendForm.patchValue({
      name: backend.name,
      host: backend.host,
      port: backend.port,
      has_auth: backend.has_auth,
      username: backend.username || '',
      password: '', // Passwords not sent from backend for security
      config_password: '', // Config passwords not sent from backend
      oauth_host: '127.0.0.1', // Default, oauth_host not tracked in BackendInfo
      oauth_port: backend.oauth_port || 51901,
    });

    // Name is always read-only in edit mode (users can delete and re-create to rename)
    this.backendForm.get('name')?.disable();
  }

  cancelEdit(): void {
    this.formState.set({ mode: 'closed' });
    this.resetForm();
    this.backendForm.get('name')?.enable();
  }

  private resetForm(): void {
    this.backendForm.reset({
      host: 'localhost',
      port: 51900,
      has_auth: false,
      oauth_host: '127.0.0.1',
      oauth_port: 51901,
    });
    this.showPassword.set(false);
    this.showConfigPassword.set(false);
  }

  async switchToBackend(name: string): Promise<void> {
    if (name === this.activeBackend()) return;
    try {
      this.switchingTo.set(name);
      await this.backendService.switchBackend(name);
      this.snackBar.open(
        this.translate.instant('modals.backend.notifications.switched', { name }),
        this.translate.instant('common.close'),
        {
          duration: 3000,
          panelClass: 'snackbar-success',
        }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.snackBar.open(
        this.translate.instant('modals.backend.notifications.switchFailed', { message }),
        this.translate.instant('common.close'),
        {
          duration: 5000,
          panelClass: 'snackbar-error',
        }
      );
    } finally {
      this.switchingTo.set(null);
      // Reload to get updated status (connected/error)
      await this.backendService.loadBackends();
    }
  }

  async testBackend(name: string): Promise<void> {
    try {
      this.testingBackend.set(name);
      const result = await this.backendService.testConnection(name);

      this.snackBar.open(
        result.success
          ? this.translate.instant('modals.backend.notifications.connectionSuccess') +
              (result.version ? ` (${result.version})` : '')
          : this.translate.instant('modals.backend.notifications.connectionFailed', {
              message: result.message,
            }),
        this.translate.instant('common.close'),
        {
          duration: 4000,
          panelClass: result.success ? 'snackbar-success' : 'snackbar-error',
          horizontalPosition: 'center',
          verticalPosition: 'bottom',
        }
      );
    } catch {
      this.snackBar.open(
        this.translate.instant('modals.backend.notifications.testFailed'),
        this.translate.instant('common.close'),
        {
          duration: 4000,
          panelClass: 'snackbar-error',
        }
      );
    } finally {
      this.testingBackend.set(null);
    }
  }

  async saveBackend(): Promise<void> {
    if (this.backendForm.invalid || this.hasDuplicateName() || this.hasDuplicateHost()) return;

    const formValue = this.backendForm.getRawValue();
    const state = this.formState();

    // Determine if editing local backend
    const isEditingLocal = state.mode === 'edit' && state.editingName === 'Local';

    const backendData = {
      name: formValue.name,
      host: formValue.host,
      port: formValue.port,
      is_local: isEditingLocal,
      // Send empty strings to signal "clear auth" when toggle is off
      username: formValue.has_auth ? formValue.username : '',
      password: formValue.has_auth ? formValue.password : '',
      config_password: formValue.config_password || undefined,
      // OAuth fields only for Local backend
      oauth_host: isEditingLocal ? formValue.oauth_host : undefined,
      oauth_port: isEditingLocal ? formValue.oauth_port : undefined,
    };

    try {
      if (state.mode === 'edit' && state.editingName) {
        await this.backendService.updateBackend(backendData);
      } else {
        await this.backendService.addBackend(backendData);
      }
      this.cancelEdit();
    } catch (error) {
      console.error('Failed to save backend:', error);
    }
  }

  async removeBackend(name: string): Promise<void> {
    if (name === 'Local') return;

    const dialogRef = this.dialog.open(ConfirmModalComponent, {
      data: {
        title: this.translate.instant('modals.backend.delete.title'),
        message: this.translate.instant('modals.backend.delete.message', { name }),
        confirmText: this.translate.instant('modals.backend.delete.confirm'),
        cancelText: this.translate.instant('common.cancel'),
      },
    });

    const confirmed = await firstValueFrom(dialogRef.afterClosed());
    if (!confirmed) return;

    try {
      await this.backendService.removeBackend(name);
    } catch (error) {
      console.error('Failed to remove backend:', error);
    }
  }

  togglePasswordVisibility(): void {
    this.showPassword.update(v => !v);
  }

  toggleConfigPasswordVisibility(): void {
    this.showConfigPassword.update(v => !v);
  }

  hasDuplicateName(): boolean {
    const name = this.backendForm.get('name')?.value?.toLowerCase();
    const state = this.formState();
    if (!name || (state.mode === 'edit' && state.editingName?.toLowerCase() === name)) return false;
    return this.backends().some(b => b.name.toLowerCase() === name);
  }

  hasDuplicateHost(): boolean {
    const host = this.backendForm.get('host')?.value;
    const port = this.backendForm.get('port')?.value;
    const state = this.formState();
    if (!host || !port) return false;

    return this.backends().some(
      b => b.name !== state.editingName && b.host === host && b.port === port
    );
  }

  // ============= Encryption Actions =============
  // Moved to BackendSecurityComponent

  // ============= Icon & Status Helpers =============
  getBackendIcon(backend: BackendInfo): string {
    if (backend.is_local) return 'home';
    if (!backend.os) return 'cloud';
    const os = backend.os.toLowerCase();
    if (os.includes('linux')) return 'linux';
    if (os.includes('darwin') || os.includes('macos')) return 'apple';
    if (os.includes('windows')) return 'windows';
    return 'cloud';
  }

  getStatusClass(backend: BackendInfo): string {
    if (!backend.status) return 'unknown';
    if (backend.status === 'connected') return 'connected';
    if (backend.status.startsWith('error')) return 'error';
    return 'unknown';
  }

  getStatusTooltip(backend: BackendInfo): string {
    if (!backend.status) return this.translate.instant('modals.backend.status.notTested');
    if (backend.status === 'connected')
      return this.translate.instant('modals.backend.status.connected');
    if (backend.status.startsWith('error'))
      return this.translate.instant('modals.backend.status.error', {
        message: backend.status.replace('error:', '').trim(),
      });
    return backend.status;
  }
}
