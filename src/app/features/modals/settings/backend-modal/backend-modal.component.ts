import { Component, computed, effect, inject, resource, signal } from '@angular/core';
import { NgClass, NgTemplateOutlet } from '@angular/common';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatDialogRef, MatDialog } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { BackendService } from 'src/app/services/system/backend.service';
import type {
  AddBackendConfig,
  BackendInfo,
  BackendSettingMetadata,
} from 'src/app/shared/types/backend.types';
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
import { BACKEND_CONSTANTS } from 'src/app/shared/constants/backend.constants';

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
    NgTemplateOutlet,
    NgClass,
  ],
  templateUrl: './backend-modal.component.html',
  styleUrls: ['./backend-modal.component.scss', '../../../../styles/_shared-modal.scss'],
})
export class BackendModalComponent {
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
    mode: 'add' | 'edit' | null;
    editingName?: string;
    isLoading?: boolean;
  }>({
    mode: null,
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
    host: [BACKEND_CONSTANTS.DEFAULTS.HOST, [Validators.required]],
    port: [
      BACKEND_CONSTANTS.DEFAULTS.PORT,
      [Validators.required, Validators.min(1024), Validators.max(65535)],
    ],
    username: [''],
    password: [''],
    config_password: [''],
    config_path: [''],
    has_auth: [false],
    // OAuth fields (for Local backend)
    oauth_host: [BACKEND_CONSTANTS.DEFAULTS.IP],
    oauth_port: [
      BACKEND_CONSTANTS.DEFAULTS.OAUTH_PORT,
      [Validators.min(1024), Validators.max(65535)],
    ],
  });

  constructor() {
    this.backendService.loadBackends();

    effect(() => {
      const schema = this.schema();
      if (schema && Object.keys(schema).length > 0) {
        this.applyValidators(schema);
      }
    });
  }

  readonly schemaResource = resource({
    loader: () => this.backendService.getBackendSchema(),
  });

  readonly schema = computed(() => this.schemaResource.value() ?? {});

  readonly fieldGroups = computed(() => {
    const schema = this.schema();
    const groups: Record<string, { key: string; meta: BackendSettingMetadata }[]> = {};
    const groupOrder = [
      BACKEND_CONSTANTS.GROUPS.CONNECTION,
      BACKEND_CONSTANTS.GROUPS.AUTHENTICATION,
      BACKEND_CONSTANTS.GROUPS.OAUTH,
      BACKEND_CONSTANTS.GROUPS.SECURITY,
      BACKEND_CONSTANTS.GROUPS.ADVANCED,
    ];

    Object.entries(schema).forEach(([key, meta]) => {
      if (key === 'is_local') return;
      const group = (meta.metadata['group'] as string) || 'other';
      if (!groups[group]) groups[group] = [];
      groups[group].push({ key, meta });
    });

    Object.values(groups).forEach(fields => {
      fields.sort(
        (a, b) =>
          ((a.meta.metadata['order'] as number) || 100) -
          ((b.meta.metadata['order'] as number) || 100)
      );
    });

    return groupOrder
      .map(name => ({
        name,
        fields: groups[name] || [],
      }))
      .filter(g => g.fields.length > 0);
  });

  private applyValidators(schema: Record<string, BackendSettingMetadata>): void {
    // Apply min/max/pattern from schema to form controls
    Object.entries(schema).forEach(([key, meta]: [string, BackendSettingMetadata]) => {
      const control = this.backendForm.get(key);
      if (!control) return;

      const validators = [];

      if (meta.constraints?.number?.min !== undefined)
        validators.push(Validators.min(meta.constraints.number.min));
      if (meta.constraints?.number?.max !== undefined)
        validators.push(Validators.max(meta.constraints.number.max));
      if (meta.constraints?.text?.pattern)
        validators.push(Validators.pattern(meta.constraints.text.pattern));

      if (validators.length > 0) {
        control.addValidators(validators);
        control.updateValueAndValidity();
      }
    });
  }

  close(): void {
    this.modalService.animatedClose(this.dialogRef);
  }

  toggleAddForm(): void {
    const current = this.formState();
    if (current.mode === null) {
      this.formState.set({ mode: 'add' });
      this.copyBackendFrom.set('none');
      this.copyRemotesFrom.set('none');
    } else {
      this.formState.set({ mode: null });
      this.resetForm();
    }
  }

  /** Get the runtime config path for the currently editing backend */
  getEditingBackendRuntimePath(): string | null {
    const state = this.formState();
    if (state.mode !== 'edit' || !state.editingName) return null;
    const backend = this.backends().find(b => b.name === state.editingName);
    return backend?.runtimeConfigPath ?? null;
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
      has_auth: backend.hasAuth,
      username: backend.username || '',
      password: backend.password || '', // Password now sent from backend for editing
      config_password: '', // Config passwords not sent from backend
      config_path: backend.configPath || '',
      oauth_host: '127.0.0.1', // Default, oauth_host not tracked in BackendInfo
      oauth_port: backend.oauthPort || 51901,
    });

    // Update validators based on initial state
    this.updateAuthValidators(backend.hasAuth);

    // Name is always read-only in edit mode (users can delete and re-create to rename)
    this.backendForm.get('name')?.disable();
  }

  cancelEdit(): void {
    this.formState.set({ mode: null });
    this.resetForm();
    this.backendForm.get('name')?.enable();
  }

  private resetForm(): void {
    this.backendForm.reset({
      host: BACKEND_CONSTANTS.DEFAULTS.HOST,
      port: BACKEND_CONSTANTS.DEFAULTS.PORT,
      has_auth: false,
      oauth_host: BACKEND_CONSTANTS.DEFAULTS.IP,
      oauth_port: BACKEND_CONSTANTS.DEFAULTS.OAUTH_PORT,
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

    const backendData: AddBackendConfig = this.backendService.mapFormToConfig(
      formValue,
      isEditingLocal
    );

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
    return backend?.hasConfigPassword || false;
  }

  async removeConfigPassword(): Promise<void> {
    const state = this.formState();
    if (state.mode !== 'edit' || !state.editingName) return;

    try {
      this.formState.update(s => ({ ...s, isLoading: true }));
      await this.backendService.updateBackend({
        name: state.editingName,
        isLocal: false,
        host: '',
        port: 0,
        configPassword: '',
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
    if (backend.isLocal) return BACKEND_CONSTANTS.ICONS.LOCAL;
    if (!backend.os) return BACKEND_CONSTANTS.ICONS.REMOTE;
    const os = backend.os.toLowerCase();
    if (os.includes('linux')) return BACKEND_CONSTANTS.ICONS.LINUX;
    if (os.includes('darwin') || os.includes('macos')) return BACKEND_CONSTANTS.ICONS.APPLE;
    if (os.includes('windows')) return BACKEND_CONSTANTS.ICONS.WINDOWS;
    return BACKEND_CONSTANTS.ICONS.REMOTE;
  }

  getStatusClass(backend: BackendInfo): string {
    if (!backend.status) return BACKEND_CONSTANTS.STATUS.UNKNOWN;
    if (backend.status === BACKEND_CONSTANTS.STATUS.CONNECTED)
      return BACKEND_CONSTANTS.STATUS.CONNECTED;
    if (backend.status.startsWith(BACKEND_CONSTANTS.STATUS.ERROR_PREFIX))
      return BACKEND_CONSTANTS.STATUS.ERROR_PREFIX;
    return BACKEND_CONSTANTS.STATUS.UNKNOWN;
  }

  getStatusTooltip(backend: BackendInfo): string {
    if (!backend.status) return this.translate.instant('modals.backend.status.notTested');
    if (backend.status === BACKEND_CONSTANTS.STATUS.CONNECTED)
      return this.translate.instant('modals.backend.status.connected');
    if (backend.status.startsWith(BACKEND_CONSTANTS.STATUS.ERROR_PREFIX))
      return this.translate.instant('modals.backend.status.error', {
        message: backend.status.replace(BACKEND_CONSTANTS.STATUS.ERROR_PREFIX + ':', '').trim(),
      });
    return backend.status;
  }

  getFieldClasses(field: { key: string }, group: string): string[] {
    return [
      'field-wrapper',
      field.key === 'host' || field.key === 'oauth_host' ? 'host-field' : '',
      field.key === 'port' || field.key === 'oauth_port' ? 'port-field' : '',
      group !== BACKEND_CONSTANTS.GROUPS.CONNECTION && group !== BACKEND_CONSTANTS.GROUPS.OAUTH
        ? 'full-width'
        : '',
    ].filter(Boolean);
  }

  getFieldIcon(key: string): string | null {
    switch (key) {
      case 'host':
        return BACKEND_CONSTANTS.ICONS.GLOBE;
      case 'username':
        return BACKEND_CONSTANTS.ICONS.USER;
      case 'password':
      case 'config_password':
        return key === 'config_password'
          ? BACKEND_CONSTANTS.ICONS.LOCK
          : BACKEND_CONSTANTS.ICONS.KEY;
      case 'config_path':
        return BACKEND_CONSTANTS.ICONS.FILE;
      case 'oauth_host':
        return BACKEND_CONSTANTS.ICONS.GLOBE; // Optional, if you want icon for oauth host
      default:
        return null;
    }
  }

  isPasswordVisible(key: string): boolean {
    return key === 'config_password' ? this.showConfigPassword() : this.showPassword();
  }

  toggleFieldPassword(key: string): void {
    if (key === 'config_password') {
      this.toggleConfigPasswordVisibility();
    } else {
      this.togglePasswordVisibility();
    }
  }
}
