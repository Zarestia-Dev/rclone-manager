import {
  Component,
  HostListener,
  OnInit,
  OnDestroy,
  inject,
  computed,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
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
import { takeUntil, Subject } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { MatTabsModule } from '@angular/material/tabs';
import { TranslateModule } from '@ngx-translate/core';

// Services
import { AuthStateService } from '@app/services';
import {
  RemoteManagementService,
  JobManagementService,
  MountManagementService,
  AppSettingsService,
  FileSystemService,
  NautilusService,
  ModalService,
} from '@app/services';
import {
  RemoteType,
  RemoteConfigSections,
  InteractiveFlowState,
  INTERACTIVE_REMOTES,
  DEFAULT_PROFILE_NAME,
} from '@app/types';
import { OperationConfigComponent } from '../../../../shared/remote-config/app-operation-config/app-operation-config.component';
import { ValidatorRegistryService } from '@app/services';
import { InteractiveConfigStepComponent } from 'src/app/shared/remote-config/interactive-config-step/interactive-config-step.component';
import { RemoteConfigStepComponent } from 'src/app/shared/remote-config/remote-config-step/remote-config-step.component';
import { IconService } from '@app/services';
import {
  buildPathString,
  getDefaultAnswerFromQuestion,
  createInitialInteractiveFlowState,
  isInteractiveContinueDisabled,
  convertBoolAnswerToString,
  updateInteractiveAnswer,
} from '../../../../shared/utils/remote-config.utils';

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
})
export class QuickAddRemoteComponent implements OnInit, OnDestroy {
  private readonly fb = inject(FormBuilder);
  private readonly dialogRef = inject(MatDialogRef<QuickAddRemoteComponent>);
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

  readonly quickAddForm: FormGroup;
  remoteTypes: RemoteType[] = [];
  existingRemotes: string[] = [];

  // Auth state signals (from service observables)
  readonly isAuthInProgress = toSignal(this.authStateService.isAuthInProgress$, {
    initialValue: false,
  });
  readonly isAuthCancelled = toSignal(this.authStateService.isAuthCancelled$, {
    initialValue: false,
  });

  // Component state signals
  readonly currentStep = signal<WizardStep>('setup');
  readonly interactiveFlowState = signal<InteractiveFlowState>(createInitialInteractiveFlowState());

  // Computed signals
  readonly submitButtonText = computed(() =>
    this.isAuthInProgress() && !this.isAuthCancelled()
      ? 'modals.quickAdd.buttons.creating'
      : 'modals.quickAdd.buttons.create'
  );

  readonly isInteractiveContinueDisabled = computed(() =>
    isInteractiveContinueDisabled(this.interactiveFlowState(), this.isAuthCancelled())
  );

  // Operation tabs configuration for DRY template
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

  private readonly destroy$ = new Subject<void>();
  private pendingConfig: {
    remoteData: { name: string; type: string };
    finalConfig: RemoteConfigSections;
  } | null = null;

  // Store cron expressions for each operation type
  private cronExpressions: {
    sync?: string | null;
    copy?: string | null;
    bisync?: string | null;
    move?: string | null;
  } = {};

  constructor() {
    this.quickAddForm = this.createQuickAddForm();
    this.setupFormListeners();
  }

  ngOnInit(): void {
    this.initializeComponent();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    this.authStateService.cancelAuth();
  }

  private async initializeComponent(): Promise<void> {
    try {
      const oauthSupportedRemotes = await this.remoteManagementService.getOAuthSupportedRemotes();
      this.remoteTypes = oauthSupportedRemotes.map(remote => ({
        value: remote.name,
        label: remote.description,
      }));
      this.existingRemotes = await this.remoteManagementService.getRemotes();

      // Update the remote name validator with the loaded remotes
      const remoteNameControl = this.quickAddForm.get('setup.name');
      if (remoteNameControl) {
        remoteNameControl.setValidators([
          Validators.required,
          this.validatorRegistry.createRemoteNameValidator(this.existingRemotes),
        ]);
        remoteNameControl.updateValueAndValidity();
      }
    } catch (error) {
      console.error('Error initializing component:', error);
    }
  }

  onInteractiveModeToggled(value: boolean): void {
    this.quickAddForm.get('setup.useInteractiveMode')?.setValue(value);
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

  private createOperationGroup(opType: 'mount' | 'sync' | 'copy' | 'bisync' | 'move'): FormGroup {
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
            this.validatorRegistry.createRemoteNameValidator(this.existingRemotes),
          ],
        ],
        type: ['', Validators.required],
        useInteractiveMode: [false],
      }),
      operations: this.fb.group({
        mount: this.createOperationGroup('mount'),
        sync: this.createOperationGroup('sync'),
        copy: this.createOperationGroup('copy'),
        bisync: this.createOperationGroup('bisync'),
        move: this.createOperationGroup('move'),
      }),
    });
  }

  private setupFormListeners(): void {
    // Remote type change listener
    this.quickAddForm
      .get('setup.type')
      ?.valueChanges.pipe(takeUntil(this.destroy$))
      .subscribe(remoteType => {
        if (remoteType) {
          this.onRemoteTypeChange(remoteType);
        }
      });

    // Auto-start validators
    const operationNames: ('mount' | 'sync' | 'copy' | 'bisync' | 'move')[] = [
      'mount',
      'sync',
      'copy',
      'bisync',
      'move',
    ];

    operationNames.forEach(opName => {
      const opGroup = this.quickAddForm.get(`operations.${opName}`);
      if (!opGroup) return;

      if (opName === 'mount') {
        // Handle mount separately - its logic is simpler and its dest is always local
        const autoStartControl = opGroup.get('autoStart');
        const destControl = opGroup.get('dest');
        autoStartControl?.valueChanges.pipe(takeUntil(this.destroy$)).subscribe(enabled => {
          if (enabled) {
            destControl?.setValidators(Validators.required);
          } else {
            destControl?.clearValidators();
          }
          destControl?.updateValueAndValidity();
        });
      } else {
        // Handle other operations with the new custom validator
        const sourcePathControl = opGroup.get('source.path');
        const destPathControl = opGroup.get('dest.path');

        // Apply the custom validator
        sourcePathControl?.setValidators(this.validatorRegistry.requiredIfLocal());
        destPathControl?.setValidators(this.validatorRegistry.requiredIfLocal());

        // Listen for changes that affect validation and trigger an update
        const autoStartControl = opGroup.get('autoStart');
        const sourcePathTypeControl = opGroup.get('source.pathType');
        const destPathTypeControl = opGroup.get('dest.pathType');

        autoStartControl?.valueChanges.pipe(takeUntil(this.destroy$)).subscribe(() => {
          sourcePathControl?.updateValueAndValidity();
          destPathControl?.updateValueAndValidity();
        });

        sourcePathTypeControl?.valueChanges.pipe(takeUntil(this.destroy$)).subscribe(() => {
          sourcePathControl?.updateValueAndValidity();
        });

        destPathTypeControl?.valueChanges.pipe(takeUntil(this.destroy$)).subscribe(() => {
          destPathControl?.updateValueAndValidity();
        });
      }
    });
  }

  private onRemoteTypeChange(remoteType: string): void {
    const shouldUseInteractive = INTERACTIVE_REMOTES.includes(remoteType.toLowerCase());
    const control = this.quickAddForm.get('setup.useInteractiveMode');
    if (control && !control.dirty) {
      control.setValue(shouldUseInteractive);
    }
    this.generateRemoteName(remoteType);
  }

  private generateRemoteName(remoteType: string): void {
    const baseName = remoteType.replace(/\s+/g, '');
    let newName = baseName;
    let counter = 1;
    while (this.existingRemotes.includes(newName)) {
      newName = `${baseName}-${counter}`;
      counter++;
    }
    this.quickAddForm.get('setup')?.patchValue({ remoteName: newName });
  }

  nextStep(): void {
    if (this.currentStep() === 'setup') {
      this.quickAddForm.get('setup')?.markAllAsTouched();
      if (this.isSetupStepValid()) {
        this.currentStep.set('operations');
      }
    }
  }

  prevStep(): void {
    if (this.currentStep() === 'operations') {
      this.currentStep.set('setup');
    }
  }

  isSetupStepValid(): boolean {
    return !!this.quickAddForm.get('setup')?.valid;
  }

  async selectFolder(opName: string, pathType: 'source' | 'dest'): Promise<void> {
    try {
      // Only require an empty folder when selecting a mount destination.
      // Other operations (sync/copy/etc.) do not need an empty local folder.
      const requireEmpty = opName === 'mount' && pathType === 'dest';
      const selectedPath = await this.fileSystemService.selectFolder(requireEmpty);
      if (selectedPath) {
        let controlPath: string;
        if (opName === 'mount' && pathType === 'dest') {
          controlPath = `operations.mount.dest`;
        } else {
          controlPath = `operations.${opName}.${pathType}.path`;
        }
        this.quickAddForm.get(controlPath)?.patchValue(selectedPath);
      }
    } catch (error) {
      console.error('Error selecting folder:', error);
    }
  }

  async onSubmit(): Promise<void> {
    const setup = this.quickAddForm.get('setup')?.value;
    const operations = this.quickAddForm.get('operations')?.value;

    if (this.quickAddForm.invalid || this.isAuthInProgress() || !setup || !operations) {
      return;
    }

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
    const finalConfig = this.buildFinalConfig(setup.name, operations);
    this.pendingConfig = {
      remoteData: { name: setup.name, type: setup.type },
      finalConfig,
    };
    await this.startInteractiveRemoteConfig();
  }

  private buildFinalConfig(remoteName: string, operations: any): RemoteConfigSections {
    const createConfig = (
      op: any
    ): {
      source: string;
      dest: string;
      autoStart: boolean;
      cronEnabled?: boolean;
      cronExpression?: string | null;
      filterProfile: string;
      backendProfile: string;
    } => ({
      source: buildPathString(op.source, remoteName),
      dest: buildPathString(op.dest, remoteName),
      autoStart: op.autoStart || false,
      cronEnabled: op.cronEnabled || false,
      cronExpression: op.cronExpression || null,
      filterProfile: DEFAULT_PROFILE_NAME,
      backendProfile: DEFAULT_PROFILE_NAME,
    });

    return {
      mountConfigs: {
        default: {
          ...createConfig(operations.mount),
          type: 'mount',
          vfsProfile: DEFAULT_PROFILE_NAME,
        },
      },
      copyConfigs: { default: createConfig(operations.copy) },
      syncConfigs: { default: createConfig(operations.sync) },
      bisyncConfigs: { default: createConfig(operations.bisync) },
      moveConfigs: { default: createConfig(operations.move) },
      filterConfigs: { default: {} },
      vfsConfigs: {
        default: {
          options: {
            CacheMode: 'writes',
            ChunkSize: '128M',
            DirCacheTime: '5m',
            VfsCacheMaxAge: '1h',
          },
        },
      },
      backendConfigs: { default: {} },
      showOnTray: true,
    };
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
    if (!state.isActive || !state.question || !this.pendingConfig) {
      return;
    }
    try {
      let answer: unknown = state.answer;
      if (state.question?.Option?.Type === 'bool') {
        answer = convertBoolAnswerToString(answer);
      }
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

  onCronExpressionChange(
    operationType: 'sync' | 'copy' | 'bisync' | 'move',
    cronExpression: string | null
  ): void {
    this.cronExpressions[operationType] = cronExpression;
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
    const { mountConfigs, copyConfigs, syncConfigs, bisyncConfigs, moveConfigs } = finalConfig;

    // Get default profiles
    const mountConfig = mountConfigs?.['default'];
    const copyConfig = copyConfigs?.['default'];
    const syncConfig = syncConfigs?.['default'];
    const bisyncConfig = bisyncConfigs?.['default'];
    const moveConfig = moveConfigs?.['default'];

    // Use profile-based methods - backend resolves options from saved config
    // This is simpler and ensures consistency with tray actions

    if (mountConfig?.autoStart && mountConfig?.dest) {
      void this.mountManagementService.mountRemoteProfile(remoteName, 'default');
    }

    if (copyConfig?.autoStart && copyConfig?.source && copyConfig?.dest) {
      void this.jobManagementService.startCopyProfile(remoteName, 'default');
    }

    if (syncConfig?.autoStart && syncConfig?.source && syncConfig?.dest) {
      void this.jobManagementService.startSyncProfile(remoteName, 'default');
    }

    if (bisyncConfig?.autoStart && bisyncConfig?.source && bisyncConfig?.dest) {
      void this.jobManagementService.startBisyncProfile(remoteName, 'default');
    }

    if (moveConfig?.autoStart && moveConfig?.source && moveConfig?.dest) {
      void this.jobManagementService.startMoveProfile(remoteName, 'default');
    }
  }

  async cancelAuth(): Promise<void> {
    await this.authStateService.cancelAuth();
    this.currentStep.set('operations');
    this.interactiveFlowState.set(createInitialInteractiveFlowState());
  }

  get selectedRemoteLabel(): string {
    const remoteType = this.quickAddForm.get('setup.type')?.value;
    const remote = this.remoteTypes.find(r => r.value === remoteType);
    return remote ? remote.label : 'Select Remote Type';
  }

  @HostListener('document:keydown.escape')
  close(): void {
    if (this.nautilusService.isNautilusOverlayOpen) {
      return;
    }
    this.modalService.animatedClose(this.dialogRef);
  }
}
