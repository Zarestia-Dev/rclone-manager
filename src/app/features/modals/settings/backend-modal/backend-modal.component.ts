import { Component, computed, inject, OnInit, resource, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NgClass, NgTemplateOutlet } from '@angular/common';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { BackendService } from 'src/app/services/infrastructure/system/backend.service';
import type {
  addBackendArgs,
  BackendInfo,
  BackendSettingMetadata,
} from 'src/app/shared/types/backend.types';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatTabsModule } from '@angular/material/tabs';
import { MatExpansionModule } from '@angular/material/expansion';
import { map } from 'rxjs';
import { BackendSecurityComponent } from './backend-security/backend-security.component';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { FileSystemService } from 'src/app/services/operations/file-system.service';
import { MatSlideToggle } from '@angular/material/slide-toggle';
import { ModalService, NotificationService } from '@app/services';
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
    MatTabsModule,
    BackendSecurityComponent,
    TranslateModule,
    MatExpansionModule,
    MatSlideToggle,
    NgTemplateOutlet,
    NgClass,
  ],
  templateUrl: './backend-modal.component.html',
  styleUrls: ['./backend-modal.component.scss', '../../../../styles/_shared-modal.scss'],
})
export class BackendModalComponent implements OnInit {
  private readonly dialogRef = inject(MatDialogRef<BackendModalComponent>);
  private readonly notificationService = inject(NotificationService);
  private readonly backendService = inject(BackendService);
  private readonly fb = inject(FormBuilder);
  private readonly translate = inject(TranslateService);
  private readonly fileSystemService = inject(FileSystemService);
  private readonly modalService = inject(ModalService);

  readonly backends = this.backendService.backends;
  readonly activeBackend = this.backendService.activeBackend;
  readonly isLoading = this.backendService.isLoading;

  readonly formMode = signal<{
    mode: 'add' | 'edit' | null;
    editingName?: string;
  }>({ mode: null });

  readonly isSaving = signal(false);

  readonly testingBackend = signal<string | null>(null);
  readonly switchingTo = signal<string | null>(null);
  readonly showPassword = signal(false);
  readonly showConfigPassword = signal(false);
  readonly copyBackendFrom = signal<string>('none');
  readonly copyRemotesFrom = signal<string>('none');

  readonly activeConfigPath = this.backendService.activeConfigPath;

  readonly backendForm: FormGroup = this.fb.group({
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
    oauth_host: [BACKEND_CONSTANTS.DEFAULTS.IP],
    oauth_port: [
      BACKEND_CONSTANTS.DEFAULTS.OAUTH_PORT,
      [Validators.min(1024), Validators.max(65535)],
    ],
  });

  // Tracks form value reactively, including disabled controls (e.g. name in edit mode).
  private readonly formValue = toSignal(
    this.backendForm.valueChanges.pipe(map(() => this.backendForm.getRawValue())),
    { initialValue: this.backendForm.getRawValue() }
  );

  readonly isDuplicateName = computed(() => {
    const name = this.formValue()['name']?.toLowerCase();
    const { mode, editingName } = this.formMode();
    if (!name || (mode === 'edit' && editingName?.toLowerCase() === name)) return false;
    return this.backends().some(b => b.name.toLowerCase() === name);
  });

  readonly isDuplicateHost = computed(() => {
    const { host, port } = this.formValue();
    const { editingName } = this.formMode();
    if (!host || !port) return false;
    return this.backends().some(b => b.name !== editingName && b.host === host && b.port === port);
  });

  readonly hasConfigPassword = computed(() => {
    const { mode, editingName } = this.formMode();
    if (mode !== 'edit' || !editingName) return false;
    return this.backends().find(b => b.name === editingName)?.hasConfigPassword ?? false;
  });

  readonly editingBackendRuntimePath = computed(() => {
    const { mode, editingName } = this.formMode();
    if (mode !== 'edit' || !editingName) return null;
    return this.backends().find(b => b.name === editingName)?.runtimeConfigPath ?? null;
  });

  readonly isActiveEditing = computed(() => {
    const { mode, editingName } = this.formMode();
    if (mode !== 'edit' || !editingName) return false;
    return this.activeBackend() === editingName;
  });

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

    for (const [key, meta] of Object.entries(schema)) {
      if (key === 'is_local') continue;
      const group = (meta.metadata['group'] as string) || 'other';
      (groups[group] ??= []).push({ key, meta });
    }

    for (const fields of Object.values(groups)) {
      fields.sort(
        (a, b) =>
          ((a.meta.metadata['order'] as number) ?? 100) -
          ((b.meta.metadata['order'] as number) ?? 100)
      );
    }

    return groupOrder
      .map(name => ({ name, fields: groups[name] ?? [] }))
      .filter(g => g.fields.length > 0);
  });

  readonly securityFields = computed(
    () => this.fieldGroups().find(g => g.name === 'security')?.fields ?? []
  );

  ngOnInit(): void {
    this.backendService.loadBackends();
  }

  private applySchemaValidators(schema: Record<string, BackendSettingMetadata>): void {
    for (const [key, meta] of Object.entries(schema)) {
      const control = this.backendForm.get(key);
      if (!control) continue;

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
    }
  }

  close(): void {
    this.modalService.animatedClose(this.dialogRef);
  }

  toggleAddForm(): void {
    if (this.formMode().mode === null) {
      this.formMode.set({ mode: 'add' });
      this.copyBackendFrom.set('none');
      this.copyRemotesFrom.set('none');

      const schema = this.schema();
      if (Object.keys(schema).length > 0) {
        this.applySchemaValidators(schema);
      }
    } else {
      this.formMode.set({ mode: null });
      this.resetForm();
    }
  }

  startEdit(backend: BackendInfo): void {
    this.formMode.set({ mode: 'edit', editingName: backend.name });

    this.backendForm.patchValue({
      name: backend.name,
      host: backend.host,
      port: backend.port,
      has_auth: backend.hasAuth,
      username: backend.username ?? '',
      password: '',
      config_password: '',
      config_path: backend.configPath ?? '',
      oauth_host: backend.oauthHost ?? BACKEND_CONSTANTS.DEFAULTS.IP,
      oauth_port: backend.oauthPort ?? BACKEND_CONSTANTS.DEFAULTS.OAUTH_PORT,
    });

    this.updateAuthValidators(backend.hasAuth);
    this.backendForm.get('name')?.disable();

    const schema = this.schema();
    if (Object.keys(schema).length > 0) {
      this.applySchemaValidators(schema);
    }
  }

  cancelEdit(): void {
    this.formMode.set({ mode: null });
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
    this.updateAuthValidators(false);
    this.showPassword.set(false);
    this.showConfigPassword.set(false);
  }

  async switchToBackend(name: string): Promise<void> {
    if (name === this.activeBackend()) return;
    try {
      this.switchingTo.set(name);
      await this.backendService.switchBackend(name);
    } catch (error) {
      this.notificationService.showError(
        this.translate.instant('modals.backend.notifications.switchFailed', {
          message: error instanceof Error ? error.message : String(error),
        })
      );
    } finally {
      this.switchingTo.set(null);
      await this.backendService.loadBackends();
    }
  }

  async testBackend(name: string): Promise<void> {
    try {
      this.testingBackend.set(name);
      const result = await this.backendService.testConnection(name);

      if (result.success) {
        this.notificationService.showSuccess(
          this.translate.instant('modals.backend.notifications.connectionSuccess') +
            (result.version ? ` (${result.version})` : '')
        );
      } else {
        this.notificationService.showError(
          this.translate.instant('modals.backend.notifications.connectionFailed', {
            message: result.message,
          })
        );
      }
    } catch {
      this.notificationService.showError(
        this.translate.instant('modals.backend.notifications.testFailed')
      );
    } finally {
      this.testingBackend.set(null);
    }
  }

  async saveBackend(): Promise<void> {
    if (this.backendForm.invalid || this.isDuplicateName() || this.isDuplicateHost()) return;

    const formValue = this.backendForm.getRawValue();
    const { mode, editingName } = this.formMode();
    const isEditingLocal = mode === 'edit' && editingName === 'Local';

    this.isSaving.set(true);
    try {
      if (mode === 'edit' && editingName) {
        // Use the update mapper so blank password fields send undefined (→ Rust
        // None) and the existing credential is preserved instead of cleared.
        const backendData = this.backendService.mapFormToUpdateConfig(
          formValue,
          editingName,
          isEditingLocal
        );
        await this.backendService.updateBackend(backendData);
        this.notificationService.showSuccess(
          this.translate.instant('modals.backend.notifications.updated')
        );
      } else {
        const backendData: addBackendArgs = this.backendService.mapFormToConfig(formValue, false);
        await this.backendService.addBackend(
          backendData,
          this.copyBackendFrom() !== 'none' ? this.copyBackendFrom() : undefined,
          this.copyRemotesFrom() !== 'none' ? this.copyRemotesFrom() : undefined
        );
        this.notificationService.showSuccess(
          this.translate.instant('modals.backend.notifications.added')
        );
      }
      this.cancelEdit();
    } catch (error) {
      this.notificationService.showError(
        this.translate.instant('modals.backend.notifications.saveFailed', {
          message: error instanceof Error ? error.message : String(error),
        })
      );
    } finally {
      this.isSaving.set(false);
    }
  }

  async removeBackend(name: string): Promise<void> {
    if (name === 'Local') return;

    const confirmed = await this.notificationService.confirmModal(
      this.translate.instant('modals.backend.delete.title'),
      this.translate.instant('modals.backend.delete.message', { name }),
      this.translate.instant('common.delete'),
      this.translate.instant('common.cancel'),
      { icon: 'warning', color: 'warn' }
    );

    if (!confirmed) return;

    try {
      await this.backendService.removeBackend(name);
      this.notificationService.showSuccess(
        this.translate.instant('modals.backend.notifications.deleted')
      );
    } catch (error) {
      this.notificationService.showError(
        this.translate.instant('modals.backend.notifications.deleteFailed', {
          message: error instanceof Error ? error.message : String(error),
        })
      );
    }
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

  async removeConfigPassword(): Promise<void> {
    const { mode, editingName } = this.formMode();
    if (mode !== 'edit' || !editingName) return;

    const backend = this.backends().find(b => b.name === editingName);
    if (!backend) return;

    this.isSaving.set(true);
    try {
      await this.backendService.updateBackend({
        name: editingName,
        isLocal: backend.isLocal,
        host: backend.host,
        port: backend.port,
        username: backend.username,
        password: backend.password,
        configPath: backend.configPath,
        oauthPort: backend.oauthPort,
        oauthHost: backend.oauthHost,
        configPassword: '', // explicitly empty → Rust clears it
      });
      this.notificationService.showSuccess(
        this.translate.instant('modals.backend.notifications.updated')
      );
    } catch (error) {
      this.notificationService.showError(
        this.translate.instant('modals.backend.notifications.saveFailed', {
          message: String(error),
        })
      );
    } finally {
      this.isSaving.set(false);
    }
  }

  isConfigSelectionAllowed(): boolean {
    return this.isActiveEditing();
  }

  async selectConfigFile(): Promise<void> {
    if (!this.isConfigSelectionAllowed()) return;

    const { editingName } = this.formMode();
    const isLocalBackend = editingName === 'Local';
    const currentPath = this.backendForm.get('config_path')?.value || undefined;

    try {
      let selectedPath: string | null = null;

      if (isLocalBackend) {
        selectedPath = await this.fileSystemService.selectFile(currentPath);
      } else {
        const config: FilePickerConfig = {
          mode: 'local',
          selection: 'files',
          multi: false,
          initialLocation: currentPath,
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
      const msg = String(error);
      if (msg.includes('cancelled') || msg.includes('File selection cancelled')) return;
      this.notificationService.showError(
        this.translate.instant('modals.backend.notifications.fileSelectFailed')
      );
    }
  }

  // Icon & status helpers

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
    if (backend.status.startsWith(BACKEND_CONSTANTS.STATUS.ERROR_PREFIX)) {
      return this.translate.instant('modals.backend.status.error', {
        message: backend.status.replace(`${BACKEND_CONSTANTS.STATUS.ERROR_PREFIX}:`, '').trim(),
      });
    }
    return backend.status;
  }

  getFieldClasses(field: { key: string }, group: string): string[] {
    const isHostField = field.key === 'host' || field.key === 'oauth_host';
    const isPortField = field.key === 'port' || field.key === 'oauth_port';
    const isFullWidth =
      group !== BACKEND_CONSTANTS.GROUPS.CONNECTION && group !== BACKEND_CONSTANTS.GROUPS.OAUTH;

    return [
      'field-wrapper',
      isHostField ? 'host-field' : '',
      isPortField ? 'port-field' : '',
      isFullWidth ? 'full-width' : '',
    ].filter(Boolean);
  }

  getFieldIcon(key: string): string | null {
    switch (key) {
      case 'host':
      case 'oauth_host':
        return BACKEND_CONSTANTS.ICONS.GLOBE;
      case 'username':
        return BACKEND_CONSTANTS.ICONS.USER;
      case 'password':
        return BACKEND_CONSTANTS.ICONS.KEY;
      case 'config_password':
        return BACKEND_CONSTANTS.ICONS.LOCK;
      case 'config_path':
        return BACKEND_CONSTANTS.ICONS.FILE;
      default:
        return null;
    }
  }

  isPasswordVisible(key: string): boolean {
    return key === 'config_password' ? this.showConfigPassword() : this.showPassword();
  }

  toggleFieldPassword(key: string): void {
    if (key === 'config_password') {
      this.showConfigPassword.update(v => !v);
    } else {
      this.showPassword.update(v => !v);
    }
  }
}
