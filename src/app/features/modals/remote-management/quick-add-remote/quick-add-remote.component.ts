import {
  Component,
  inject,
  computed,
  signal,
  ChangeDetectionStrategy,
  DestroyRef,
} from '@angular/core';
import {
  FormBuilder,
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { MatDialogRef } from '@angular/material/dialog';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatIconModule } from '@angular/material/icon';
import { fromEvent, merge, startWith } from 'rxjs';
import { filter } from 'rxjs/operators';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatTabsModule } from '@angular/material/tabs';
import { TranslateModule } from '@ngx-translate/core';

import {
  AuthStateService,
  RemoteManagementService,
  JobManagementService,
  MountManagementService,
  AppSettingsService,
  FileSystemService,
  NautilusService,
  ModalService,
  ValidatorRegistryService,
  IconService,
} from '@app/services';
import {
  RemoteType,
  RemoteConfigSections,
  InteractiveFlowState,
  DEFAULT_PROFILE_NAME,
  REMOTE_CONFIG_KEYS,
  CommandOption,
} from '@app/types';
import { OperationConfigComponent } from '../../../../shared/remote-config/app-operation-config/app-operation-config.component';
import { InteractiveConfigStepComponent } from 'src/app/shared/remote-config/interactive-config-step/interactive-config-step.component';
import {
  RemoteConfigStepComponent,
  INITIAL_COMMAND_OPTIONS,
} from 'src/app/shared/remote-config/remote-config-step/remote-config-step.component';
import {
  buildPathString,
  getDefaultAnswerFromQuestion,
  createInitialInteractiveFlowState,
  isInteractiveContinueDisabled,
  convertBoolAnswerToString,
  updateInteractiveAnswer,
} from '../../../../services/remote/utils/remote-config.utils';

type WizardStep = 'setup' | 'operations' | 'interactive';
type OperationType = 'mount' | 'sync' | 'copy' | 'bisync' | 'move';

@Component({
  selector: 'app-quick-add-remote',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    MatProgressSpinnerModule,
    MatIconModule,
    MatButtonModule,
    MatTabsModule,
    InteractiveConfigStepComponent,
    RemoteConfigStepComponent,
    OperationConfigComponent,
    TranslateModule,
  ],
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
  private readonly jobManagementService = inject(JobManagementService);
  private readonly mountManagementService = inject(MountManagementService);
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly fileSystemService = inject(FileSystemService);
  private readonly validatorRegistry = inject(ValidatorRegistryService);
  readonly iconService = inject(IconService);
  private readonly nautilusService = inject(NautilusService);
  private readonly modalService = inject(ModalService);

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
  ] as const;

  private readonly operationNames = this.operationTabs.map(t => t.type);

  // ── Wizard state ─────────────────────────────────────────────────────────
  readonly currentStep = signal<WizardStep>('setup');
  readonly interactiveFlowState = signal<InteractiveFlowState>(createInitialInteractiveFlowState());
  readonly commandOptions = signal<CommandOption[]>(INITIAL_COMMAND_OPTIONS);
  readonly remoteTypes = signal<RemoteType[]>([]);
  readonly existingRemotes = signal<string[]>([]);

  // ── Form ─────────────────────────────────────────────────────────────────
  readonly quickAddForm = this.createQuickAddForm();

  // Stable references — quickAddForm never changes after construction
  readonly setupFormGroup = this.quickAddForm.get('setup') as FormGroup;

  readonly operationFormGroups = new Map<OperationType, FormGroup>(
    this.operationNames.map(name => [
      name,
      this.quickAddForm.get(`operations.${name}`) as FormGroup,
    ])
  );

  // ── Signals derived from form ─────────────────────────────────────────────

  readonly setupFormStatus = toSignal(
    this.setupFormGroup.statusChanges.pipe(startWith(this.setupFormGroup.status))
  );

  readonly quickAddFormStatus = toSignal(
    this.quickAddForm.statusChanges.pipe(startWith(this.quickAddForm.status))
  );

  readonly setupTypeValue = toSignal(
    this.quickAddForm
      .get('setup.type')!
      .valueChanges.pipe(startWith(this.quickAddForm.get('setup.type')!.value as string))
  );

  readonly setupNameValue = toSignal(
    this.quickAddForm
      .get('setup.name')!
      .valueChanges.pipe(startWith(this.quickAddForm.get('setup.name')!.value as string))
  );

  // ── Auth state ───────────────────────────────────────────────────────────

  readonly isAuthInProgress = this.authStateService.isAuthInProgress;
  readonly isAuthCancelled = this.authStateService.isAuthCancelled;

  // ── Computed ─────────────────────────────────────────────────────────────

  readonly isSetupStepValid = computed(() => this.setupFormStatus() === 'VALID');

  readonly submitButtonText = computed(() =>
    this.isAuthInProgress() && !this.isAuthCancelled()
      ? 'modals.quickAdd.buttons.creating'
      : 'modals.quickAdd.buttons.create'
  );

  readonly isInteractiveContinueDisabled = computed(() =>
    isInteractiveContinueDisabled(this.interactiveFlowState(), this.isAuthCancelled())
  );

  private pendingConfig: {
    remoteData: { name: string; type: string };
    finalConfig: RemoteConfigSections;
  } | null = null;

  constructor() {
    this.setupFormListeners();

    fromEvent<KeyboardEvent>(document, 'keydown')
      .pipe(
        filter(e => e.key === 'Escape'),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe(() => {
        if (!this.nautilusService.isNautilusOverlayOpen()) {
          this.modalService.animatedClose(this.dialogRef);
        }
      });

    this.destroyRef.onDestroy(() => {
      void this.authStateService.cancelAuth();
    });

    void this.initializeComponent();
  }

  private async initializeComponent(): Promise<void> {
    try {
      const [oauthSupportedRemotes, existingRemotes] = await Promise.all([
        this.remoteManagementService.getOAuthSupportedRemotes(),
        this.remoteManagementService.getRemotes(),
      ]);

      this.remoteTypes.set(
        oauthSupportedRemotes.map(remote => ({
          value: remote.name,
          label: remote.description,
        }))
      );
      this.existingRemotes.set(existingRemotes);

      const remoteNameControl = this.quickAddForm.get('setup.name');
      if (remoteNameControl) {
        remoteNameControl.setValidators([
          Validators.required,
          this.validatorRegistry.createRemoteNameValidator(existingRemotes),
        ]);
        remoteNameControl.updateValueAndValidity();
      }
    } catch (error) {
      console.error('Error initializing component:', error);
    }
  }

  // ── Form builders ─────────────────────────────────────────────────────────

  private createOperationPathGroup(
    defaultType: 'local' | 'currentRemote' | 'otherRemote'
  ): FormGroup {
    return this.fb.group({
      pathType: new FormControl(defaultType),
      path: new FormControl(''),
      otherRemoteName: new FormControl(''),
    });
  }

  private createOperationGroup(opType: OperationType): FormGroup {
    if (opType === 'mount') {
      return this.fb.group({
        autoStart: new FormControl(false),
        source: this.createOperationPathGroup('currentRemote'),
        dest: new FormControl(''),
      });
    }
    return this.fb.group({
      autoStart: new FormControl(false),
      cronEnabled: new FormControl(false),
      cronExpression: new FormControl(''),
      source: this.createOperationPathGroup('currentRemote'),
      dest: this.createOperationPathGroup('local'),
    });
  }

  private createQuickAddForm(): FormGroup {
    return this.fb.group({
      setup: this.fb.group({
        name: [
          '',
          [
            Validators.required,
            this.validatorRegistry.createRemoteNameValidator(this.existingRemotes()),
          ],
        ],
        type: ['', Validators.required],
      }),
      operations: this.fb.group(
        Object.fromEntries(this.operationNames.map(name => [name, this.createOperationGroup(name)]))
      ),
    });
  }

  // ── Listeners ─────────────────────────────────────────────────────────────

  private static readonly SOURCE_DEST_OP_TYPES = new Set<OperationType>([
    'sync',
    'copy',
    'bisync',
    'move',
  ]);

  private setupFormListeners(): void {
    for (const opName of this.operationNames) {
      const opGroup = this.quickAddForm.get(`operations.${opName}`);
      if (!opGroup) continue;

      if (opName === 'mount') {
        const destControl = opGroup.get('dest');
        opGroup
          .get('autoStart')
          ?.valueChanges.pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe(enabled => {
            if (enabled) {
              destControl?.setValidators(Validators.required);
            } else {
              destControl?.clearValidators();
            }
            destControl?.updateValueAndValidity();
          });
      } else if (QuickAddRemoteComponent.SOURCE_DEST_OP_TYPES.has(opName)) {
        const sourcePathControl = opGroup.get('source.path');
        const destPathControl = opGroup.get('dest.path');

        sourcePathControl?.setValidators(this.validatorRegistry.requiredIfLocal());
        destPathControl?.setValidators(this.validatorRegistry.requiredIfLocal());

        merge(
          opGroup.get('autoStart')!.valueChanges,
          opGroup.get('source.pathType')!.valueChanges,
          opGroup.get('dest.pathType')!.valueChanges
        )
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe(() => {
            sourcePathControl?.updateValueAndValidity();
            destPathControl?.updateValueAndValidity();
          });
      }
    }
  }

  // ── Wizard navigation ─────────────────────────────────────────────────────

  nextStep(): void {
    if (this.currentStep() !== 'setup') return;
    this.quickAddForm.get('setup')?.markAllAsTouched();
    if (this.isSetupStepValid()) {
      this.currentStep.set('operations');
    }
  }

  prevStep(): void {
    if (this.currentStep() === 'operations') {
      this.currentStep.set('setup');
    }
  }

  // ── Folder selection ──────────────────────────────────────────────────────

  async selectFolder(opName: string, pathType: 'source' | 'dest'): Promise<void> {
    try {
      const requireEmpty = opName === 'mount' && pathType === 'dest';
      const selectedPath = await this.fileSystemService.selectFolder(requireEmpty);
      if (!selectedPath) return;

      const controlPath =
        opName === 'mount' && pathType === 'dest'
          ? 'operations.mount.dest'
          : `operations.${opName}.${pathType}.path`;
      this.quickAddForm.get(controlPath)?.patchValue(selectedPath);
    } catch (error) {
      console.error('Error selecting folder:', error);
    }
  }

  // ── Submit ────────────────────────────────────────────────────────────────

  async onSubmit(): Promise<void> {
    const setup = this.quickAddForm.get('setup')?.value;
    const operations = this.quickAddForm.get('operations')?.value;

    if (this.quickAddForm.invalid || this.isAuthInProgress() || !setup || !operations) return;

    await this.authStateService.startAuth(setup.name, false);

    const requiresInteractiveFlow = this.commandOptions().some(
      o => o.key === 'nonInteractive' && o.value === true
    );

    try {
      if (requiresInteractiveFlow) {
        await this.handleInteractiveCreation(setup, operations);
      } else {
        await this.handleStandardCreation(setup, operations);
        if (!this.isAuthCancelled()) this.modalService.animatedClose(this.dialogRef, true);
      }
    } catch (error) {
      console.error('Error in onSubmit:', error);
    } finally {
      if (!requiresInteractiveFlow || !this.interactiveFlowState().isActive) {
        this.authStateService.resetAuthState();
      }
    }
  }

  private async handleStandardCreation(setup: any, operations: any): Promise<void> {
    const finalConfig = this.buildFinalConfig(setup.name, operations);
    await this.remoteManagementService.createRemote(
      setup.name,
      { name: setup.name, type: setup.type },
      this.remoteManagementService.buildOpt(this.commandOptions())
    );
    await this.appSettingsService.saveRemoteSettings(setup.name, finalConfig);
    await this.triggerAutoStartOperations(setup.name, finalConfig);
  }

  private async handleInteractiveCreation(setup: any, operations: any): Promise<void> {
    this.pendingConfig = {
      remoteData: { name: setup.name, type: setup.type },
      finalConfig: this.buildFinalConfig(setup.name, operations),
    };
    await this.startInteractiveRemoteConfig();
  }

  private buildFinalConfig(remoteName: string, operations: any): RemoteConfigSections {
    const createBaseOpConfig = (op: any) => ({
      source: buildPathString(op.source, remoteName),
      dest: buildPathString(op.dest, remoteName),
      autoStart: op.autoStart ?? false,
      cronEnabled: op.cronEnabled ?? false,
      cronExpression: op.cronExpression ?? null,
      filterProfile: DEFAULT_PROFILE_NAME,
      backendProfile: DEFAULT_PROFILE_NAME,
    });

    return {
      [REMOTE_CONFIG_KEYS.mount]: {
        [DEFAULT_PROFILE_NAME]: {
          ...createBaseOpConfig(operations.mount),
          type: 'mount',
          vfsProfile: DEFAULT_PROFILE_NAME,
        },
      },
      [REMOTE_CONFIG_KEYS.copy]: { [DEFAULT_PROFILE_NAME]: createBaseOpConfig(operations.copy) },
      [REMOTE_CONFIG_KEYS.sync]: { [DEFAULT_PROFILE_NAME]: createBaseOpConfig(operations.sync) },
      [REMOTE_CONFIG_KEYS.bisync]: {
        [DEFAULT_PROFILE_NAME]: createBaseOpConfig(operations.bisync),
      },
      [REMOTE_CONFIG_KEYS.move]: { [DEFAULT_PROFILE_NAME]: createBaseOpConfig(operations.move) },
      [REMOTE_CONFIG_KEYS.filter]: { [DEFAULT_PROFILE_NAME]: {} },
      [REMOTE_CONFIG_KEYS.vfs]: {
        [DEFAULT_PROFILE_NAME]: {
          options: {
            CacheMode: 'writes',
            ChunkSize: '128M',
            DirCacheTime: '5m',
            VfsCacheMaxAge: '1h',
            ReadOnly: false,
          },
        },
      },
      [REMOTE_CONFIG_KEYS.backend]: { [DEFAULT_PROFILE_NAME]: {} },
      showOnTray: true,
    } as RemoteConfigSections;
  }

  // ── Interactive OAuth flow ─────────────────────────────────────────────────

  private async startInteractiveRemoteConfig(): Promise<void> {
    if (!this.pendingConfig) return;
    try {
      const startResp = await this.remoteManagementService.startRemoteConfigInteractive(
        this.pendingConfig.remoteData.name,
        this.pendingConfig.remoteData.type,
        {},
        this.remoteManagementService.buildOpt(this.commandOptions())
      );
      if (!startResp || startResp.State === '') {
        await this.finalizeRemoteCreation();
        return;
      }
      this.currentStep.set('interactive');
      this.interactiveFlowState.set({
        isActive: true,
        question: startResp,
        answer: getDefaultAnswerFromQuestion(startResp),
        isProcessing: false,
      });
    } catch (error) {
      console.error('Error starting interactive config:', error);
      await this.finalizeRemoteCreation();
    }
  }

  async onInteractiveContinue(answer: string | number | boolean | null): Promise<void> {
    this.interactiveFlowState.update(state => ({ ...state, answer, isProcessing: true }));
    try {
      await this.submitRcAnswer();
    } finally {
      if (this.interactiveFlowState().isActive) {
        this.interactiveFlowState.update(state => ({ ...state, isProcessing: false }));
      }
    }
  }

  private async submitRcAnswer(): Promise<void> {
    const state = this.interactiveFlowState();
    if (!state.isActive || !state.question || !this.pendingConfig) return;

    let answer: unknown = state.answer;
    if (state.question?.Option?.Type === 'bool') {
      answer = convertBoolAnswerToString(answer);
    }

    try {
      const resp = await this.remoteManagementService.continueRemoteConfigInteractive(
        this.pendingConfig.remoteData.name,
        state.question.State,
        answer,
        {},
        this.remoteManagementService.buildOpt(this.commandOptions())
      );
      if (!resp || resp.State === '') {
        this.interactiveFlowState.update(s => ({ ...s, isActive: false, question: null }));
        await this.finalizeRemoteCreation();
      } else {
        this.interactiveFlowState.update(s => ({
          ...s,
          question: resp,
          answer: getDefaultAnswerFromQuestion(resp),
        }));
      }
    } catch (error) {
      console.error('Interactive config error:', error);
      await this.finalizeRemoteCreation();
    }
  }

  handleInteractiveAnswerUpdate(newAnswer: string | number | boolean | null): void {
    if (this.interactiveFlowState().isActive) {
      this.interactiveFlowState.update(state => updateInteractiveAnswer(state, newAnswer));
    }
  }

  private async finalizeRemoteCreation(): Promise<void> {
    if (!this.pendingConfig) return;
    const { remoteData, finalConfig } = this.pendingConfig;
    await this.appSettingsService.saveRemoteSettings(remoteData.name, finalConfig);
    await this.triggerAutoStartOperations(remoteData.name, finalConfig);
    this.authStateService.resetAuthState();
    this.modalService.animatedClose(this.dialogRef, true);
  }

  private async triggerAutoStartOperations(
    remoteName: string,
    finalConfig: RemoteConfigSections
  ): Promise<void> {
    const mountConfig = finalConfig[REMOTE_CONFIG_KEYS.mount]?.[DEFAULT_PROFILE_NAME] as any;
    if (mountConfig?.autoStart && mountConfig?.dest) {
      void this.mountManagementService.mountRemoteProfile(remoteName, DEFAULT_PROFILE_NAME, 'ui');
    }

    const jobOps = [
      {
        key: REMOTE_CONFIG_KEYS.copy,
        start: (): Promise<number> =>
          this.jobManagementService.startCopyProfile(remoteName, DEFAULT_PROFILE_NAME, 'ui'),
      },
      {
        key: REMOTE_CONFIG_KEYS.sync,
        start: (): Promise<number> =>
          this.jobManagementService.startSyncProfile(remoteName, DEFAULT_PROFILE_NAME, 'ui'),
      },
      {
        key: REMOTE_CONFIG_KEYS.bisync,
        start: (): Promise<number> =>
          this.jobManagementService.startBisyncProfile(remoteName, DEFAULT_PROFILE_NAME, 'ui'),
      },
      {
        key: REMOTE_CONFIG_KEYS.move,
        start: (): Promise<number> =>
          this.jobManagementService.startMoveProfile(remoteName, DEFAULT_PROFILE_NAME, 'ui'),
      },
    ] as const;

    for (const { key, start } of jobOps) {
      const cfg = finalConfig[key]?.[DEFAULT_PROFILE_NAME] as any;
      if (cfg?.autoStart && cfg?.source && cfg?.dest) {
        void start();
      }
    }
  }

  async cancelAuth(): Promise<void> {
    await this.authStateService.cancelAuth();
    this.currentStep.set('operations');
    this.interactiveFlowState.set(createInitialInteractiveFlowState());
  }

  close(): void {
    if (this.nautilusService.isNautilusOverlayOpen()) return;
    this.modalService.animatedClose(this.dialogRef);
  }
}
