import {
  Component,
  HostListener,
  OnDestroy,
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
import { merge } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
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
  INTERACTIVE_REMOTES,
  DEFAULT_PROFILE_NAME,
  REMOTE_CONFIG_KEYS,
} from '@app/types';
import { OperationConfigComponent } from '../../../../shared/remote-config/app-operation-config/app-operation-config.component';
import { InteractiveConfigStepComponent } from 'src/app/shared/remote-config/interactive-config-step/interactive-config-step.component';
import { RemoteConfigStepComponent } from 'src/app/shared/remote-config/remote-config-step/remote-config-step.component';
import {
  buildPathString,
  getDefaultAnswerFromQuestion,
  createInitialInteractiveFlowState,
  isInteractiveContinueDisabled,
  convertBoolAnswerToString,
  updateInteractiveAnswer,
} from '../../../../services/remote/utils/remote-config.utils';

type WizardStep = 'setup' | 'operations' | 'interactive';

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
export class QuickAddRemoteComponent implements OnDestroy {
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
      type: 'mount',
      label: 'modals.quickAdd.operations.mount.label',
      description: 'modals.quickAdd.operations.mount.description',
    },
    {
      type: 'sync',
      label: 'modals.quickAdd.operations.sync.label',
      description: 'modals.quickAdd.operations.sync.description',
    },
    {
      type: 'copy',
      label: 'modals.quickAdd.operations.copy.label',
      description: 'modals.quickAdd.operations.copy.description',
    },
    {
      type: 'bisync',
      label: 'modals.quickAdd.operations.bisync.label',
      description: 'modals.quickAdd.operations.bisync.description',
    },
    {
      type: 'move',
      label: 'modals.quickAdd.operations.move.label',
      description: 'modals.quickAdd.operations.move.description',
    },
  ] as const;

  private readonly operationNames = this.operationTabs.map(t => t.type);

  readonly quickAddForm: FormGroup;

  readonly remoteTypes = signal<RemoteType[]>([]);
  readonly existingRemotes = signal<string[]>([]);

  readonly isAuthInProgress = this.authStateService.isAuthInProgress;
  readonly isAuthCancelled = this.authStateService.isAuthCancelled;

  readonly currentStep = signal<WizardStep>('setup');
  readonly interactiveFlowState = signal<InteractiveFlowState>(createInitialInteractiveFlowState());

  // FIX: was a plain method — broken in zoneless since form validity changes
  // wouldn't trigger change detection without a computed signal.
  readonly isSetupStepValid = computed(() => this.quickAddForm.get('setup')?.valid === true);

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
    this.quickAddForm = this.createQuickAddForm();
    this.setupFormListeners();
    this.initializeComponent();
  }

  ngOnDestroy(): void {
    this.authStateService.cancelAuth();
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

  private createOperationPathGroup(
    defaultType: 'local' | 'currentRemote' | 'otherRemote'
  ): FormGroup {
    return this.fb.group({
      pathType: new FormControl(defaultType),
      path: new FormControl(''),
      otherRemoteName: new FormControl(''),
    });
  }

  private createOperationGroup(opType: (typeof this.operationNames)[number]): FormGroup {
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
        useInteractiveMode: [false],
      }),
      operations: this.fb.group(
        Object.fromEntries(this.operationNames.map(name => [name, this.createOperationGroup(name)]))
      ),
    });
  }

  private setupFormListeners(): void {
    this.quickAddForm
      .get('setup.type')
      ?.valueChanges.pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(remoteType => {
        if (remoteType) this.onRemoteTypeChange(remoteType);
      });

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
      } else {
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

  private onRemoteTypeChange(remoteType: string): void {
    const control = this.quickAddForm.get('setup.useInteractiveMode');
    if (control && !control.dirty) {
      control.setValue(INTERACTIVE_REMOTES.includes(remoteType.toLowerCase()));
    }
    this.generateRemoteName(remoteType);
  }

  private generateRemoteName(remoteType: string): void {
    const baseName = remoteType.replace(/\s+/g, '');
    let counter = 0;
    let newName = baseName;
    while (this.existingRemotes().includes(newName)) {
      newName = `${baseName}-${++counter}`;
    }
    this.quickAddForm.get('setup')?.patchValue({ name: newName });
  }

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

  async onSubmit(): Promise<void> {
    const setup = this.quickAddForm.get('setup')?.value;
    const operations = this.quickAddForm.get('operations')?.value;

    if (this.quickAddForm.invalid || this.isAuthInProgress() || !setup || !operations) return;

    await this.authStateService.startAuth(setup.name, false);

    try {
      if (setup.useInteractiveMode) {
        await this.handleInteractiveCreation(setup, operations);
      } else {
        await this.handleStandardCreation(setup, operations);
        if (!this.isAuthCancelled()) this.modalService.animatedClose(this.dialogRef, true);
      }
    } catch (error) {
      console.error('Error in onSubmit:', error);
    } finally {
      if (!setup.useInteractiveMode || !this.interactiveFlowState().isActive) {
        this.authStateService.resetAuthState();
      }
    }
  }

  private async handleStandardCreation(setup: any, operations: any): Promise<void> {
    const finalConfig = this.buildFinalConfig(setup.name, operations);
    await this.remoteManagementService.createRemote(setup.name, {
      name: setup.name,
      type: setup.type,
    });
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

  private async startInteractiveRemoteConfig(): Promise<void> {
    if (!this.pendingConfig) return;
    try {
      const startResp = await this.remoteManagementService.startRemoteConfigInteractive(
        this.pendingConfig.remoteData.name,
        this.pendingConfig.remoteData.type,
        {},
        { nonInteractive: true }
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
      const resp = await this.remoteManagementService.continueRemoteConfigNonInteractive(
        this.pendingConfig.remoteData.name,
        state.question.State,
        answer,
        {},
        { nonInteractive: true }
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

  @HostListener('document:keydown.escape')
  close(): void {
    if (this.nautilusService.isNautilusOverlayOpen()) return;
    this.modalService.animatedClose(this.dialogRef);
  }
}
