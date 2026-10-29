import * as validationUtils from 'src/app/shared/validators';
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
import type { BackendInfo, FilePickerConfig, TestConnectionResult } from '@app/types';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatTabsModule } from '@angular/material/tabs';
import { MatExpansionModule } from '@angular/material/expansion';
import { BackendSecurityComponent } from './backend-security/backend-security.component';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { FileSystemService } from 'src/app/services/operations/file-system.service';
import { MatSlideToggle } from '@angular/material/slide-toggle';
import { NotificationService } from 'src/app/services/ui/notification.service';

import { EscapeCloseDirective } from '../../../../shared/directives/escape-close.directive';
import { AlertBannerComponent } from 'src/app/shared/components/alert-banner/alert-banner.component';

type CopyKey = 'copyBackendFrom' | 'copyRemotesFrom' | 'copyFlowFrom';

const NO_COPY_SOURCE = 'none';
const DEFAULT_HOST = 'localhost';
const DEFAULT_PORT = 51900;

const OS_ICONS = [
  ['linux', 'linux'],
  ['darwin', 'apple'],
  ['macos', 'apple'],
  ['windows', 'windows'],
] as const;

const backendIcon = (backend: BackendInfo): string => {
  if (backend.isLocal) return 'home';
  const os = backend.os?.toLowerCase() ?? '';
  return OS_ICONS.find(([name]) => os.includes(name))?.[1] ?? 'cloud';
};

const noCopySources = (): Record<CopyKey, string> => ({
  copyBackendFrom: NO_COPY_SOURCE,
  copyRemotesFrom: NO_COPY_SOURCE,
  copyFlowFrom: NO_COPY_SOURCE,
});

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
    MatCheckboxModule,
    MatTabsModule,
    BackendSecurityComponent,
    TranslatePipe,
    MatExpansionModule,
    MatSlideToggle,
    AlertBannerComponent,
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

  /** Cached validator factories — capture getters so the validator sees fresh state per CD cycle. */
  private readonly duplicateNameValidator = validationUtils.duplicateNameValidator({
    getExisting: () => this.backends(),
    getEditingName: () => this.editingName() ?? undefined,
    getMode: () =>
      (this.formMode() === 'add' ? 'create' : this.formMode()) as 'create' | 'edit' | null,
  });
  private readonly duplicateHostValidator = validationUtils.duplicateHostValidator({
    getExisting: () => this.backends(),
    getEditingName: () => this.editingName() ?? undefined,
  });

  readonly backends = this.backendService.backends;
  readonly activeBackend = this.backendService.activeBackend;
  readonly isLoading = this.backendService.isLoading;

  readonly formMode = signal<'add' | 'edit' | null>(null);
  readonly editingName = signal<string | null>(null);
  readonly selectedTabIndex = signal(0);

  readonly isSaving = signal(false);

  readonly testingBackend = signal<string | null>(null);
  readonly switchingTo = signal<string | null>(null);
  readonly showPassword = signal(false);
  readonly showConfigPassword = signal(false);
  /** Settings a new backend can start from; the source is chosen per group. */
  readonly copyFields = [
    {
      key: 'copyBackendFrom',
      labelKey: 'modals.backend.copyOptions.backendConfig',
      icon: 'file-lines',
    },
    { key: 'copyRemotesFrom', labelKey: 'modals.backend.copyOptions.remotesConfig', icon: 'cloud' },
    { key: 'copyFlowFrom', labelKey: 'modals.backend.copyOptions.flowConfig', icon: 'workflow' },
  ] as const;
  readonly copySources = signal<Record<CopyKey, string>>(noCopySources());

  readonly testingForm = signal(false);
  readonly formTestResult = signal<TestConnectionResult | null>(null);
  private formTestRequest = 0;

  readonly backendForm: FormGroup;

  readonly backendsWithMetadata = computed(() =>
    this.backends().map(backend => {
      const status = backend.status?.type;
      return {
        ...backend,
        icon: backendIcon(backend),
        statusClass: status === 'connected' || status === 'error' ? status : 'unknown',
        statusKey: `modals.backend.status.${status === 'connected' || status === 'error' ? status : 'notTested'}`,
        statusMessage: backend.status?.type === 'error' ? backend.status.message : '',
      };
    })
  );

  private readonly editingBackend = computed(() =>
    this.formMode() === 'edit'
      ? this.backends().find(b => b.name === this.editingName())
      : undefined
  );
  readonly hasConfigPassword = computed(() => this.editingBackend()?.hasConfigPassword ?? false);
  readonly editingBackendRuntimePath = computed(
    () => this.editingBackend()?.runtimeConfigPath ?? null
  );
  readonly isActiveEditing = computed(() => this.editingBackend()?.isActive ?? false);

  /** Editing a backend that already has a custom password: an empty field keeps it. */
  readonly keepsStoredPassword = signal(false);

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
        host: [DEFAULT_HOST, [Validators.required]],
        port: [DEFAULT_PORT, [Validators.required, Validators.min(1024), Validators.max(65535)]],
        username: [''],
        password: [''],
        config_password: [''],
        config_path: [''],
        has_auth: [false],
      },
      { validators: [this.duplicateHostValidator] }
    );
  }

  async ngOnInit(): Promise<void> {
    await this.backendService.loadBackends();
    // The list is a snapshot; probe the remotes so every card shows their current state.
    void this.backendService.refreshStatuses();
  }

  setCopySource(key: CopyKey, source: string): void {
    this.copySources.update(current => ({ ...current, [key]: source }));
  }

  /** Only the groups with a chosen source, in the shape the add command takes. */
  private chosenCopySources(): Partial<Record<CopyKey, string>> {
    return Object.fromEntries(
      Object.entries(this.copySources()).filter(([, source]) => source !== NO_COPY_SOURCE)
    );
  }

  toggleAddForm(): void {
    if (this.formMode() !== null) {
      this.cancelEdit();
      return;
    }
    this.formMode.set('add');
    this.selectedTabIndex.set(0);
    this.copySources.set(noCopySources());
  }

  startEdit(backend: BackendInfo): void {
    const hasCustomAuth = backend.hasAuth && !backend.isAuthGenerated;
    this.formMode.set('edit');
    this.editingName.set(backend.name);
    this.selectedTabIndex.set(0);
    this.keepsStoredPassword.set(hasCustomAuth);

    // The stored password never reaches the UI; an empty field keeps it.
    this.backendForm.patchValue({
      name: backend.name,
      host: backend.host,
      port: backend.port,
      has_auth: hasCustomAuth,
      username: backend.username ?? '',
      password: '',
      config_password: '',
      config_path: backend.configPath ?? '',
    });

    this.updateAuthValidators(hasCustomAuth);
    this.backendForm.get('name')?.disable();
  }

  cancelEdit(): void {
    this.formMode.set(null);
    this.editingName.set(null);
    this.selectedTabIndex.set(0);
    this.resetForm();
    this.backendForm.get('name')?.enable();
  }

  private resetForm(): void {
    this.backendForm.reset({ host: DEFAULT_HOST, port: DEFAULT_PORT, has_auth: false });
    this.keepsStoredPassword.set(false);
    this.updateAuthValidators(false);
    this.showPassword.set(false);
    this.showConfigPassword.set(false);
    this.onConnectionFieldChange();
  }

  async testFormConnection(): Promise<void> {
    const { host, port, has_auth, username, password } = this.backendForm.getRawValue();
    if (!host || !Number(port)) return;

    const request = ++this.formTestRequest;
    this.testingForm.set(true);
    this.formTestResult.set(null);
    const result = await this.backendService.testConnectionDetails({
      host,
      port: Number(port),
      username: has_auth ? username || undefined : undefined,
      password: has_auth ? password || undefined : undefined,
      name: this.editingName() ?? undefined,
    });
    // A field changed while the test ran: its result describes other values.
    if (request !== this.formTestRequest) return;
    this.formTestResult.set(result);
    this.testingForm.set(false);
  }

  onConnectionFieldChange(): void {
    this.formTestRequest++;
    this.formTestResult.set(null);
    this.testingForm.set(false);
  }

  async switchToBackend(name: string): Promise<void> {
    if (name === this.activeBackend() || this.switchingTo()) return;
    this.switchingTo.set(name);
    try {
      await this.backendService.switchBackend(name);
    } catch {
      // The service has reported the failure; the list shows what the probe found.
      await this.backendService.loadBackends();
    } finally {
      this.switchingTo.set(null);
    }
  }

  async testBackend(name: string): Promise<void> {
    this.testingBackend.set(name);
    try {
      const result = await this.backendService.testConnection(name);
      if (result.success) {
        this.notificationService.showSuccess(
          this.translate.instant('modals.backend.notifications.connectionSuccess') +
            (result.version ? ` (${result.version})` : '')
        );
      } else {
        this.notificationService.showError(result.message ?? '');
      }
    } finally {
      this.testingBackend.set(null);
    }
  }

  async saveBackend(): Promise<void> {
    if (this.backendForm.invalid) return;

    const formValue = this.backendForm.getRawValue();
    const editingName = this.editingName();

    this.isSaving.set(true);
    try {
      if (this.formMode() === 'edit' && editingName) {
        await this.backendService.updateBackend(
          this.backendService.mapFormToConfig(formValue, editingName === 'Local', editingName)
        );
      } else {
        await this.backendService.addBackend({
          ...this.backendService.mapFormToConfig(formValue, false),
          ...this.chosenCopySources(),
        });
      }
      this.notificationService.showSuccess(
        this.translate.instant(
          `modals.backend.notifications.${this.formMode() === 'edit' ? 'updated' : 'added'}`
        )
      );
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

    usernameCtrl?.setValidators(enabled ? [Validators.required] : []);
    passwordCtrl?.setValidators(
      enabled && !this.keepsStoredPassword() ? [Validators.required] : []
    );

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
        configPath: backend.configPath,
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

  async selectConfigFile(): Promise<void> {
    if (!this.isActiveEditing()) return;

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
