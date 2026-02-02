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
import { MatExpansionModule } from '@angular/material/expansion';
import { ConfirmModalComponent } from 'src/app/shared/modals/confirm-modal/confirm-modal.component';
import { firstValueFrom } from 'rxjs';
import { BackendSecurityComponent } from './backend-security/backend-security.component';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { FileSystemService } from 'src/app/services/file-operations/file-system.service';
import { MatSlideToggle } from '@angular/material/slide-toggle';
import { ModalService } from '@app/services';
import { ApiClientService } from 'src/app/services/core/api-client.service';
import { FilePickerConfig } from 'src/app/shared/types/ui';

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
    MatExpansionModule,
    MatTooltipModule,
    MatSlideToggle,
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
  private readonly fileSystemService = inject(FileSystemService);
  private readonly modalService = inject(ModalService);
  private readonly apiClient = inject(ApiClientService);

  // State
  readonly backends = this.backendService.backends;
  readonly activeBackend = this.backendService.activeBackend;
  readonly isLoading = this.backendService.isLoading;

  // UI state - consolidated form state
  readonly formState = signal<{
    mode: 'closed' | 'add' | 'edit';
    editingName?: string;
    isLoading?: boolean;
  }>({
    mode: 'closed',
  });
  readonly testingBackend = signal<string | null>(null);
  readonly switchingTo = signal<string | null>(null);
  readonly showPassword = signal(false);
  readonly showConfigPassword = signal(false);

  // Copy options for new backend
  readonly copyBackendFrom = signal<string>('none');
  readonly copyRemotesFrom = signal<string>('none');

  /** Get the active config path from service's computed signal */
  readonly activeConfigPath = this.backendService.activeConfigPath;

  // Backend form
  backendForm: FormGroup = this.fb.group({
    name: ['', [Validators.required, Validators.pattern(/^[^/\\:*?"<>|]+$/)]],
    host: ['localhost', [Validators.required]],
    port: [51900, [Validators.required, Validators.min(1024), Validators.max(65535)]],
    username: [''],
    password: [''],
    config_password: [''],
    config_path: [''],
    has_auth: [false],
    // OAuth fields (for Local backend)
    oauth_host: ['127.0.0.1'],
    oauth_port: [51901, [Validators.min(1024), Validators.max(65535)]],
  });

  async ngOnInit(): Promise<void> {
    await this.backendService.loadBackends();
  }

  close(): void {
    this.modalService.animatedClose(this.dialogRef);
  }

  toggleAddForm(): void {
    const current = this.formState();
    if (current.mode === 'closed') {
      this.formState.set({ mode: 'add' });
      this.copyBackendFrom.set('none');
      this.copyRemotesFrom.set('none');
    } else {
      this.formState.set({ mode: 'closed' });
      this.resetForm();
    }
  }

  /** Get the runtime config path for the currently editing backend */
  getEditingBackendRuntimePath(): string | null {
    const state = this.formState();
    if (state.mode !== 'edit' || !state.editingName) return null;
    const backend = this.backends().find(b => b.name === state.editingName);
    return backend?.runtime_config_path ?? null;
  }

  /** Check if the backend currently being edited is the active one */
  isEditingActiveBackend(): boolean {
    const state = this.formState();
    if (state.mode !== 'edit' || !state.editingName) return false;
    return this.activeBackend() === state.editingName;
  }

  startEdit(backend: BackendInfo): void {
    this.formState.set({ mode: 'edit', editingName: backend.name });

    this.backendForm.patchValue({
      name: backend.name,
      host: backend.host,
      port: backend.port,
      has_auth: backend.has_auth,
      username: backend.username || '',
      password: backend.password || '', // Password now sent from backend for editing
      config_password: '', // Config passwords not sent from backend
      config_path: backend.config_path || '',
      oauth_host: '127.0.0.1', // Default, oauth_host not tracked in BackendInfo
      oauth_port: backend.oauth_port || 51901,
    });

    // Update validators based on initial state
    this.updateAuthValidators(backend.has_auth);

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
    this.updateAuthValidators(false); // Reset validators
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
      // Reload to get updated status (connected/error) and runtime_config_path
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
      config_path: formValue.config_path || undefined,
      // OAuth port only for Local backend
      oauth_port: isEditingLocal ? formValue.oauth_port : undefined,
    };

    try {
      if (state.mode === 'edit' && state.editingName) {
        await this.backendService.updateBackend(backendData);
        this.snackBar.open(
          this.translate.instant('modals.backend.notifications.updated'),
          this.translate.instant('common.close'),
          { duration: 3000, panelClass: 'snackbar-success' }
        );
      } else {
        // Check if copy options are selected
        const copyBackend = this.copyBackendFrom() !== 'none' ? this.copyBackendFrom() : undefined;
        const copyRemotes = this.copyRemotesFrom() !== 'none' ? this.copyRemotesFrom() : undefined;

        await this.backendService.addBackend(backendData, copyBackend, copyRemotes);

        this.snackBar.open(
          this.translate.instant('modals.backend.notifications.added'),
          this.translate.instant('common.close'),
          { duration: 3000, panelClass: 'snackbar-success' }
        );
      }
      this.cancelEdit();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.snackBar.open(
        this.translate.instant('modals.backend.notifications.saveFailed', { message }),
        this.translate.instant('common.close'),
        { duration: 5000, panelClass: 'snackbar-error' }
      );
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

  setAuthStatus(enabled: boolean): void {
    this.backendForm.get('has_auth')?.setValue(enabled);
    this.updateAuthValidators(enabled);
  }

  private updateAuthValidators(enabled: boolean): void {
    const usernameCtrl = this.backendForm.get('username');
    const passwordCtrl = this.backendForm.get('password');

    if (enabled) {
      usernameCtrl?.setValidators([Validators.required]);
      passwordCtrl?.setValidators([Validators.required]);
    } else {
      usernameCtrl?.clearValidators();
      passwordCtrl?.clearValidators();
    }

    usernameCtrl?.updateValueAndValidity();
    passwordCtrl?.updateValueAndValidity();
  }

  hasConfigPassword(): boolean {
    const state = this.formState();
    if (state.mode !== 'edit' || !state.editingName) return false;
    const backend = this.backends().find(b => b.name === state.editingName);
    return backend?.has_config_password || false;
  }

  async removeConfigPassword(): Promise<void> {
    const state = this.formState();
    if (state.mode !== 'edit' || !state.editingName) return;

    try {
      this.formState.update(s => ({ ...s, isLoading: true }));
      // Updating with empty config_password will trigger the removal logic in backend
      await this.backendService.updateBackend({
        name: state.editingName,
        is_local: false,
        host: '', // Not needed for password update but required by type
        port: 0, // Not needed
        config_password: '', // Empty string removes the password
      });

      this.snackBar.open(
        this.translate.instant('modals.backend.notifications.updated'),
        this.translate.instant('common.close'),
        { duration: 3000, panelClass: 'snackbar-success' }
      );
    } catch (error) {
      this.snackBar.open(
        this.translate.instant('modals.backend.notifications.saveFailed', {
          message: String(error),
        }),
        this.translate.instant('common.close'),
        { duration: 5000, panelClass: 'snackbar-error' }
      );
    } finally {
      this.formState.update(s => ({ ...s, isLoading: false }));
    }
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

  isConfigSelectionAllowed(): boolean {
    const state = this.formState();
    // 3. On new backend hide or disable this button (disable in this case as we return false)
    if (state.mode === 'add') return false;

    // Determine if editing local backend
    const isEditingLocal = state.editingName === 'Local';

    if (isEditingLocal) {
      // In headless mode, selecting a config path for the Local backend is problematic
      // because the internal file picker (Nautilus) relies on a working backend connection.
      if (this.apiClient.isHeadless()) return false;
      return true;
    }

    // 2. On remote backends... Its needs to be selected (active). Or else disable or hide.
    return this.isEditingActiveBackend();
  }

  async selectConfigFile(): Promise<void> {
    if (!this.isConfigSelectionAllowed()) return;

    const state = this.formState();
    const isEditingLocal = state.mode === 'edit' && state.editingName === 'Local';

    try {
      let selectedPath: string | null = null;

      // 1. Local backend selector logic
      if (isEditingLocal) {
        // In headless mode, use Nautilus file browser
        if (this.apiClient.isHeadless()) {
          const config: FilePickerConfig = {
            mode: 'local',
            selection: 'files',
            multi: false,
            initialLocation: this.backendForm.get('config_path')?.value || undefined,
          };
          const result = await this.fileSystemService.selectPathWithNautilus(config);
          if (!result.cancelled && result.paths.length > 0) {
            selectedPath = result.paths[0];
          }
        } else {
          // In Tauri mode, use native dialog
          // Use 'get_file_location' as requested, via apiClient.invoke to handle tauri invoke
          // Ideally this command opens a native file dialog and returns the path
          selectedPath = await this.apiClient.invoke<string>('get_file_location');
        }
      } else {
        // 2. Remote backends... use the nautilus file picker
        // We already checked isConfigSelectionAllowed() so we know it is active if we are here
        const config: FilePickerConfig = {
          mode: 'local', // We are selecting a local path for the config file? Or remote?
          // Usually strict config path selection is on the filesystem where rclone runs.
          // Nautilus picker 'local' mode browses the FS where rclone-manager runs.
          selection: 'files',
          multi: false,
          initialLocation: this.backendForm.get('config_path')?.value || undefined,
        };

        const result = await this.fileSystemService.selectPathWithNautilus(config);

        if (!result.cancelled && result.paths.length > 0) {
          selectedPath = result.paths[0];
        }
      }

      if (selectedPath) {
        this.backendForm.patchValue({ config_path: selectedPath });
        this.backendForm.markAsDirty();
      }
    } catch (error) {
      if (String(error).includes('cancelled') || String(error).includes('File selection cancelled'))
        return;
      console.error('Failed to select config file:', error);
      this.snackBar.open(
        this.translate.instant('modals.backend.notifications.fileSelectFailed'),
        this.translate.instant('common.close'),
        { duration: 3000, panelClass: 'snackbar-error' }
      );
    }
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
