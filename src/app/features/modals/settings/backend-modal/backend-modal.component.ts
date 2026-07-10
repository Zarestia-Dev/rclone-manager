import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { BackendService } from 'src/app/services/infrastructure/system/backend.service';
import type { AddBackendArgs, BackendInfo, FilePickerConfig } from '@app/types';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatTabsModule } from '@angular/material/tabs';
import { MatExpansionModule } from '@angular/material/expansion';
import { BackendSecurityComponent } from './backend-security/backend-security.component';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { FileSystemService } from 'src/app/services/operations/file-system.service';
import { MatSlideToggle } from '@angular/material/slide-toggle';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { ValidatorRegistryService } from 'src/app/services/ui/validation/validator-registry.service';
import { BACKEND_CONSTANTS } from 'src/app/shared/constants/backend.constants';
import { EscapeCloseDirective } from '../../../../shared/directives/escape-close.directive';

@Component({
  selector: 'app-backend-modal',
  hostDirectives: [EscapeCloseDirective],
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
    TranslatePipe,
    MatExpansionModule,
    MatSlideToggle,
  ],
  templateUrl: './backend-modal.component.html',
  styleUrls: ['./backend-modal.component.scss', '../../../../styles/_shared-modal.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BackendModalComponent implements OnInit {
  private readonly dialogRef = inject(MatDialogRef<BackendModalComponent>);
  private readonly notificationService = inject(NotificationService);
  private readonly backendService = inject(BackendService);
  private readonly fb = inject(FormBuilder);
  private readonly translate = inject(TranslateService);
  private readonly fileSystemService = inject(FileSystemService);
  private readonly validatorRegistry = inject(ValidatorRegistryService);

  /** Cached validator factories — capture getters so the validator sees fresh state per CD cycle. */
  private readonly duplicateNameValidator = this.validatorRegistry.createDuplicateNameValidator({
    getExisting: () => this.backends(),
    getEditingName: () => this.editingName() ?? undefined,
    getMode: () =>
      (this.formMode() === 'add' ? 'create' : this.formMode()) as 'create' | 'edit' | null,
  });
  private readonly duplicateHostValidator = this.validatorRegistry.createDuplicateHostValidator({
    getExisting: () => this.backends(),
    getEditingName: () => this.editingName() ?? undefined,
  });

  readonly backends = this.backendService.backends;
  readonly activeBackend = this.backendService.activeBackend;
  readonly isLoading = this.backendService.isLoading;

  readonly formMode = signal<'add' | 'edit' | null>(null);
  readonly editingName = signal<string | null>(null);

  readonly isSaving = signal(false);

  readonly testingBackend = signal<string | null>(null);
  readonly switchingTo = signal<string | null>(null);
  readonly showPassword = signal(false);
  readonly showConfigPassword = signal(false);
  readonly copyBackendFrom = signal<string>('none');
  readonly copyRemotesFrom = signal<string>('none');

  readonly activeConfigPath = this.backendService.activeConfigPath;

  readonly backendForm: FormGroup;

  readonly backendsWithMetadata = computed(() => {
    return this.backends().map(backend => {
      let icon: string = BACKEND_CONSTANTS.ICONS.REMOTE;
      if (backend.isLocal) {
        icon = BACKEND_CONSTANTS.ICONS.LOCAL;
      } else if (backend.os) {
        const os = backend.os.toLowerCase();
        if (os.includes('linux')) {
          icon = BACKEND_CONSTANTS.ICONS.LINUX;
        } else if (os.includes('darwin') || os.includes('macos')) {
          icon = BACKEND_CONSTANTS.ICONS.APPLE;
        } else if (os.includes('windows')) {
          icon = BACKEND_CONSTANTS.ICONS.WINDOWS;
        }
      }

      let statusClass: string = BACKEND_CONSTANTS.STATUS.UNKNOWN;
      let statusTooltip = this.translate.instant('modals.backend.status.notTested');

      if (backend.status) {
        if (backend.status.type === 'connected') {
          statusClass = BACKEND_CONSTANTS.STATUS.CONNECTED;
          statusTooltip = this.translate.instant('modals.backend.status.connected');
        } else if (backend.status.type === 'error') {
          statusClass = BACKEND_CONSTANTS.STATUS.ERROR_PREFIX;
          statusTooltip = this.translate.instant('modals.backend.status.error', {
            message: backend.status.message,
          });
        }
      }

      return {
        ...backend,
        icon,
        statusClass,
        statusTooltip,
      };
    });
  });

  readonly hasConfigPassword = computed(() => {
    const mode = this.formMode();
    const editingName = this.editingName();
    if (mode !== 'edit' || !editingName) return false;
    return this.backends().find(b => b.name === editingName)?.hasConfigPassword ?? false;
  });

  readonly editingBackendRuntimePath = computed(() => {
    const mode = this.formMode();
    const editingName = this.editingName();
    if (mode !== 'edit' || !editingName) return null;
    return this.backends().find(b => b.name === editingName)?.runtimeConfigPath ?? null;
  });

  readonly isActiveEditing = computed(() => {
    const mode = this.formMode();
    const editingName = this.editingName();
    if (mode !== 'edit' || !editingName) return false;
    return this.activeBackend() === editingName;
  });

  constructor() {
    this.backendForm = this.fb.group(
      {
        name: [
          '',
          [
            Validators.required,
            Validators.pattern(/^[^/\\:*?"<>|]+$/),
            this.duplicateNameValidator,
          ],
        ],
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
      },
      { validators: [this.duplicateHostValidator] }
    );
  }

  async ngOnInit(): Promise<void> {
    await this.backendService.loadBackends();
  }

  toggleAddForm(): void {
    if (this.formMode() === null) {
      this.formMode.set('add');
      this.copyBackendFrom.set('none');
      this.copyRemotesFrom.set('none');
    } else {
      this.formMode.set(null);
      this.editingName.set(null);
      this.resetForm();
    }
  }

  startEdit(backend: BackendInfo): void {
    this.formMode.set('edit');
    this.editingName.set(backend.name);

    const hasCustomAuth = backend.hasAuth && !backend.isAuthGenerated;

    this.backendForm.patchValue({
      name: backend.name,
      host: backend.host,
      port: backend.port,
      has_auth: hasCustomAuth,
      username: backend.username ?? '',
      password: backend.password ?? '',
      config_password: '',
      config_path: backend.configPath ?? '',
      oauth_host: backend.oauthHost ?? BACKEND_CONSTANTS.DEFAULTS.IP,
      oauth_port: backend.oauthPort ?? BACKEND_CONSTANTS.DEFAULTS.OAUTH_PORT,
    });

    this.updateAuthValidators(hasCustomAuth);
    this.backendForm.get('name')?.disable();
  }

  cancelEdit(): void {
    this.formMode.set(null);
    this.editingName.set(null);
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
    if (this.backendForm.invalid) return;

    const formValue = this.backendForm.getRawValue();
    const mode = this.formMode();
    const editingName = this.editingName();
    const isEditingLocal = mode === 'edit' && editingName === 'Local';

    this.isSaving.set(true);
    try {
      if (mode === 'edit' && editingName) {
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
        const backendData: AddBackendArgs = this.backendService.mapFormToConfig(formValue, false);
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
    const mode = this.formMode();
    const editingName = this.editingName();
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

    const editingName = this.editingName();
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

  toggleFieldPassword(key: 'password' | 'configPassword'): void {
    if (key === 'configPassword') {
      this.showConfigPassword.update(v => !v);
    } else {
      this.showPassword.update(v => !v);
    }
  }

  close(): void {
    this.dialogRef.close();
  }
}
