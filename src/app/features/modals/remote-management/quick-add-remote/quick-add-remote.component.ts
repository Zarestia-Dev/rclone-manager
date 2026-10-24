import {
  Component,
  inject,
  computed,
  signal,
  ChangeDetectionStrategy,
  DestroyRef,
} from '@angular/core';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { of } from 'rxjs';
import { MatDialogRef } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatTabsModule } from '@angular/material/tabs';
import { TranslatePipe } from '@ngx-translate/core';

import { AuthStateService } from 'src/app/services/security/auth-state.service';
import { RemoteManagementService } from 'src/app/services/remote/remote-management.service';
import { RemoteCreationOrchestrator } from 'src/app/services/remote/remote-creation-orchestrator.service';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { ValidatorRegistryService } from 'src/app/services/ui/validation/validator-registry.service';
import { IconService } from 'src/app/services/ui/icon.service';

import { RemotePresetsService, PresetValues } from 'src/app/services/remote/remote-presets';
import { CopyToClipboardDirective } from '../../../../shared/directives/copy-to-clipboard.directive';
import { EscapeCloseDirective } from '../../../../shared/directives/escape-close.directive';
import {
  RemoteType,
  RemoteConfigSections,
  REMOTE_CONFIG_KEYS,
  CommandOption,
  WizardStep,
  OperationType,
  DEFAULT_PROFILE_NAME,
} from '@app/types';
import { OperationConfigComponent } from '../../../../shared/remote-config/app-operation-config/app-operation-config.component';
import { InteractiveConfigStepComponent } from 'src/app/shared/remote-config/interactive-config-step/interactive-config-step.component';
import { RemoteConfigStepComponent } from 'src/app/shared/remote-config/remote-config-step/remote-config-step.component';
import { INITIAL_COMMAND_OPTIONS } from 'src/app/services/remote/utils/command-options.util';
import { mapFormToConfigProfile } from '../../../../services/remote/utils/profile-mapper.utils';
import { createConfigFormGroup } from 'src/app/services/remote/utils/config-form.utils';

const QUICK_SYNC_OPS = ['sync', 'copy', 'bisync', 'move'] as const;

interface OperationsFormValue {
  mount: Record<string, unknown>;
  sync: Record<string, unknown>;
  copy: Record<string, unknown>;
  bisync: Record<string, unknown>;
  move: Record<string, unknown>;
  serve: Record<string, unknown>;
}

interface SetupFormValue {
  name: string;
  type: string;
  vendor?: string;
  [key: string]: unknown;
}

import { ConfigFormSkeletonComponent } from 'src/app/shared/remote-config/config-form-skeleton/config-form-skeleton.component';

@Component({
  selector: 'app-quick-add-remote',
  hostDirectives: [EscapeCloseDirective],
  imports: [
    ConfigFormSkeletonComponent,
    ReactiveFormsModule,
    MatIconModule,
    MatButtonModule,
    MatTabsModule,
    InteractiveConfigStepComponent,
    RemoteConfigStepComponent,
    OperationConfigComponent,
    TranslatePipe,
    CopyToClipboardDirective,
  ],
  providers: [RemoteCreationOrchestrator],
  templateUrl: './quick-add-remote.component.html',
  styleUrls: ['./quick-add-remote.component.scss', '../../../../styles/_shared-modal.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QuickAddRemoteComponent {
  private readonly fb = inject(FormBuilder);
  private readonly dialogRef = inject(MatDialogRef<QuickAddRemoteComponent>);
  private readonly destroyRef = inject(DestroyRef);
  private readonly authStateService = inject(AuthStateService);
  private readonly remoteManagementService = inject(RemoteManagementService);
  private readonly notificationService = inject(NotificationService);
  private readonly validatorRegistry = inject(ValidatorRegistryService);
  readonly iconService = inject(IconService);
  private readonly presetsService = inject(RemotePresetsService);
  private readonly orchestrator = inject(RemoteCreationOrchestrator);

  readonly operationTabs = [
    {
      type: 'mount' as OperationType,
      label: 'modals.quickAdd.operations.mount.label',
      description: 'modals.quickAdd.operations.mount.description',
    },
    {
      type: 'sync' as OperationType,
      label: 'modals.quickAdd.operations.sync.label',
      description: 'modals.quickAdd.operations.sync.description',
    },
    {
      type: 'copy' as OperationType,
      label: 'modals.quickAdd.operations.copy.label',
      description: 'modals.quickAdd.operations.copy.description',
    },
    {
      type: 'bisync' as OperationType,
      label: 'modals.quickAdd.operations.bisync.label',
      description: 'modals.quickAdd.operations.bisync.description',
    },
    {
      type: 'move' as OperationType,
      label: 'modals.quickAdd.operations.move.label',
      description: 'modals.quickAdd.operations.move.description',
    },
    {
      type: 'serve' as OperationType,
      label: 'modals.quickAdd.operations.serve.label',
      description: 'modals.quickAdd.operations.serve.description',
    },
  ] as const;

  private readonly operationNames = this.operationTabs.map(t => t.type);

  // ── Wizard state ─────────────────────────────────────────────────────────
  readonly currentStep = signal<WizardStep>('setup');
  readonly isInitializing = signal(true);
  readonly loadFailed = signal(false);
  readonly interactiveFlowState = this.orchestrator.interactiveFlowState;
  readonly commandOptions = signal<CommandOption[]>(INITIAL_COMMAND_OPTIONS);
  readonly remoteTypes = signal<RemoteType[]>([]);
  readonly existingRemotes = signal<string[]>([]);

  // ── Form ─────────────────────────────────────────────────────────────────
  readonly quickAddForm = this.createQuickAddForm();
  readonly setupFormGroup = this.quickAddForm.get('setup') as FormGroup;

  readonly operationFormGroups = new Map<OperationType, FormGroup>(
    this.operationNames.map(name => [
      name,
      this.quickAddForm.get(`operations.${name}`) as FormGroup,
    ])
  );

  // ── Signals derived from form ─────────────────────────────────────────────
  readonly setupFormStatus = toSignal(this.setupFormGroup.statusChanges, {
    initialValue: this.setupFormGroup.status,
  });

  readonly quickAddFormStatus = toSignal(this.quickAddForm.statusChanges, {
    initialValue: this.quickAddForm.status,
  });

  readonly setupTypeValue = toSignal(this.setupFormGroup.get('type')?.valueChanges ?? of(''), {
    initialValue: (this.setupFormGroup.get('type')?.value ?? '') as string,
  });

  readonly setupNameValue = toSignal(this.setupFormGroup.get('name')?.valueChanges ?? of(''), {
    initialValue: (this.setupFormGroup.get('name')?.value ?? '') as string,
  });

  // ── Auth state ───────────────────────────────────────────────────────────
  readonly isAuthInProgress = this.authStateService.isAuthInProgress;
  readonly isAuthCancelled = this.authStateService.isAuthCancelled;
  readonly oauthHelperUrl = this.orchestrator.oauthHelperUrl;

  // ── Computed ─────────────────────────────────────────────────────────────
  readonly isSetupStepValid = computed(
    () => !this.isInitializing() && !this.loadFailed() && this.setupFormStatus() === 'VALID'
  );

  readonly submitButtonText = computed(() =>
    this.isAuthInProgress() && !this.isAuthCancelled()
      ? 'modals.quickAdd.buttons.creating'
      : 'modals.quickAdd.buttons.create'
  );

  readonly isInteractiveContinueDisabled = this.orchestrator.isInteractiveContinueDisabled;

  constructor() {
    this.destroyRef.onDestroy(() => {
      void this.orchestrator.cancelAuth();
    });

    void this.initializeComponent();
  }

  async initializeComponent(): Promise<void> {
    this.isInitializing.set(true);
    this.loadFailed.set(false);
    try {
      const [oauthSupportedRemotes, existingRemotes] = await Promise.all([
        this.remoteManagementService.getOAuthSupportedRemotes(),
        this.remoteManagementService.getRemotes(),
      ]);

      this.remoteTypes.set(
        oauthSupportedRemotes.map(remote => ({
          value: remote.name,
          label: remote.description,
          overview: remote.overview,
        }))
      );
      this.existingRemotes.set(existingRemotes);

      const remoteNameControl = this.setupFormGroup.get('name');
      if (remoteNameControl) {
        remoteNameControl.setValidators([
          Validators.required,
          this.validatorRegistry.createRemoteNameValidator(existingRemotes),
        ]);
        remoteNameControl.updateValueAndValidity();
      }
    } catch (error) {
      console.error('Error initializing quick add remote:', error);
      this.loadFailed.set(true);
      this.notificationService.showError(error);
    } finally {
      this.isInitializing.set(false);
    }
  }

  // ── Form builders ─────────────────────────────────────────────────────────

  private createQuickAddForm(): FormGroup {
    return this.fb.group({
      setup: this.fb.group({
        name: ['', Validators.required],
        type: ['', Validators.required],
      }),
      operations: this.fb.group(
        Object.fromEntries(
          this.operationNames.map(name => [
            name,
            createConfigFormGroup(this.fb, name, this.destroyRef),
          ])
        )
      ),
    });
  }

  // ── Wizard navigation ─────────────────────────────────────────────────────

  nextStep(): void {
    if (this.currentStep() !== 'setup') return;
    this.setupFormGroup.markAllAsTouched();
    if (this.isSetupStepValid()) {
      this.currentStep.set('operations');
    }
  }

  prevStep(): void {
    if (this.currentStep() === 'operations') {
      this.currentStep.set('setup');
    }
  }

  // ── Submit ────────────────────────────────────────────────────────────────

  async onSubmit(): Promise<void> {
    if (
      this.isInitializing() ||
      this.loadFailed() ||
      this.quickAddForm.invalid ||
      this.isAuthInProgress()
    )
      return;
    const setup = this.setupFormGroup.getRawValue() as SetupFormValue;
    const operations = this.quickAddForm.controls[
      'operations'
    ].getRawValue() as OperationsFormValue;
    try {
      const preset = this.presetsService.resolvePresets(setup.type);
      const completed = await this.orchestrator.createRemote(
        { name: setup.name, type: setup.type, ...(preset.remote ?? {}) },
        this.buildFinalConfig(setup.name, operations, preset),
        this.commandOptions()
      );
      if (completed) this.dialogRef.close(true);
      else if (this.interactiveFlowState().isActive) this.currentStep.set('interactive');
    } catch (error) {
      if (this.interactiveFlowState().isActive) this.currentStep.set('interactive');
      this.notificationService.showError(error);
    }
  }

  private buildFinalConfig(
    remoteName: string,
    operations: OperationsFormValue,
    preset: PresetValues
  ): RemoteConfigSections {
    const buildProfile = (
      type: string,
      opData: Record<string, unknown>
    ): Record<string, unknown> => {
      return mapFormToConfigProfile(type, opData, {
        remoteName,
      });
    };

    const mountProfile = buildProfile('mount', operations.mount);
    if (preset.mount && Object.keys(preset.mount).length) {
      const rclone = (mountProfile['rclone'] as Record<string, unknown> | undefined) ?? {};
      mountProfile['rclone'] = rclone;
      const { mountType, ...otherMountOpts } = preset.mount;
      if (mountType) {
        rclone['mountType'] = mountType;
      }
      if (Object.keys(otherMountOpts).length) {
        Object.assign(rclone, otherMountOpts);
      }
    }

    return {
      [REMOTE_CONFIG_KEYS.mount]: {
        [DEFAULT_PROFILE_NAME]: mountProfile,
      },
      ...Object.fromEntries(
        QUICK_SYNC_OPS.map(type => [
          REMOTE_CONFIG_KEYS[type],
          { [DEFAULT_PROFILE_NAME]: buildProfile(type, operations[type]) },
        ])
      ),
      [REMOTE_CONFIG_KEYS.serve]: {
        [DEFAULT_PROFILE_NAME]: buildProfile('serve', operations.serve),
      },
      ...(preset.vfs && Object.keys(preset.vfs).length
        ? { [REMOTE_CONFIG_KEYS.vfs]: { [DEFAULT_PROFILE_NAME]: preset.vfs } }
        : {}),
      ...(preset.backend && Object.keys(preset.backend).length
        ? { [REMOTE_CONFIG_KEYS.backend]: { [DEFAULT_PROFILE_NAME]: preset.backend } }
        : {}),
      showOnTray: true,
    } as unknown as RemoteConfigSections;
  }

  // ── Interactive OAuth flow ─────────────────────────────────────────────────

  async onInteractiveContinue(answer: string | number | boolean | null): Promise<void> {
    if (this.interactiveFlowState().isProcessing) return;
    this.interactiveFlowState.update(state => ({ ...state, answer, isProcessing: true }));
    const completed = await this.orchestrator.submitInteractiveAnswer(
      answer,
      this.commandOptions()
    );
    if (completed) this.dialogRef.close(true);
  }

  handleInteractiveAnswerUpdate(newAnswer: string | number | boolean | null): void {
    this.orchestrator.updateInteractiveAnswer(newAnswer);
  }

  async cancelAuth(): Promise<void> {
    await this.orchestrator.cancelAuth();
    this.currentStep.set('operations');
  }

  close(): void {
    this.dialogRef.close();
  }
}
