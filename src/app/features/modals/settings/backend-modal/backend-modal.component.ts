import { Component, inject, OnInit, signal } from '@angular/core';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatDialogRef, MatDialog } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatRadioModule } from '@angular/material/radio';
import { BackendService } from 'src/app/services/system/backend.service';
import type { BackendInfo } from 'src/app/shared/types/backend.types';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatTabsModule } from '@angular/material/tabs';
import { ConfirmModalComponent } from 'src/app/shared/modals/confirm-modal/confirm-modal.component';
import { firstValueFrom } from 'rxjs';
import { BackendSecurityComponent } from './backend-security/backend-security.component';

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
    MatRadioModule,
    MatTabsModule,
    BackendSecurityComponent,
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
      has_auth: !!(backend.username || backend.password),
      username: backend.username || '',
      password: backend.password || '',
      config_password: backend.config_password || '',
      oauth_host: backend.oauth_host || '127.0.0.1',
      oauth_port: backend.oauth_port || 51901,
    });

    // Name is always read-only in edit mode (users can delete and re-create to rename)
    this.backendForm.get('name')?.disable();
  }

  cancelEdit(): void {
    this.formState.set({ mode: 'closed' });
    this.resetForm();
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
    } finally {
      this.switchingTo.set(null);
    }
  }

  async testBackend(name: string): Promise<void> {
    try {
      this.testingBackend.set(name);
      const result = await this.backendService.testConnection(name);

      this.snackBar.open(
        result.success
          ? `Connection successful${result.version ? ` (${result.version})` : ''}`
          : `Connection failed: ${result.message}`,
        'Close',
        {
          duration: 4000,
          panelClass: result.success ? 'snackbar-success' : 'snackbar-error',
          horizontalPosition: 'center',
          verticalPosition: 'bottom',
        }
      );
    } catch {
      this.snackBar.open('Test failed unexpectedly', 'Close', {
        duration: 4000,
        panelClass: 'snackbar-error',
      });
    } finally {
      this.testingBackend.set(null);
    }
  }

  async saveBackend(): Promise<void> {
    if (this.backendForm.invalid || this.hasDuplicateName() || this.hasDuplicateHost()) return;

    const formValue = this.backendForm.getRawValue();
    const state = this.formState();

    // Determine backend type - Local when editing Local, remote for new backends
    const isEditingLocal = state.mode === 'edit' && state.editingName === 'Local';
    const backendType = isEditingLocal ? ('local' as const) : ('remote' as const);

    const backendData = {
      name: formValue.name,
      host: formValue.host,
      port: formValue.port,
      backend_type: backendType,
      username: formValue.has_auth ? formValue.username : undefined,
      password: formValue.has_auth ? formValue.password : undefined,
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
        title: 'Delete Backend',
        message: `Are you sure you want to remove the backend "${name}"?`,
        confirmText: 'Delete',
        cancelText: 'Cancel',
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

  getStatusClass(status: string): string {
    return this.backendService.getStatusClass(status);
  }

  getStatusIcon(status: string): string {
    if (status === 'connected') return 'circle-check';
    if (status.startsWith('error')) return 'circle-xmark';
    return 'question';
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
}
