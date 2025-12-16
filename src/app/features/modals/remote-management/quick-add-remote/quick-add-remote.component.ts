import {
  Component,
  HostListener,
  OnInit,
  OnDestroy,
  inject,
  ChangeDetectorRef,
} from '@angular/core';
import {
  FormBuilder,
  FormGroup,
  ReactiveFormsModule,
  Validators,
  FormControl,
} from '@angular/forms';
import { MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatInputModule } from '@angular/material/input';
import { MatDividerModule } from '@angular/material/divider';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatIconModule } from '@angular/material/icon';
import { MatExpansionModule } from '@angular/material/expansion';
import { takeUntil, Subject } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { MatTabsModule } from '@angular/material/tabs';
import { MatTooltipModule } from '@angular/material/tooltip';

// Services
import { AuthStateService } from '../../../../shared/services/auth-state.service';
import {
  RemoteManagementService,
  JobManagementService,
  MountManagementService,
  AppSettingsService,
  FileSystemService,
  NautilusService,
} from '@app/services';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import {
  RemoteType,
  RemoteConfigSections,
  InteractiveFlowState,
  INTERACTIVE_REMOTES,
} from '@app/types';
import { OperationConfigComponent } from '../../../../shared/remote-config/app-operation-config/app-operation-config.component';
import { ValidatorRegistryService } from 'src/app/shared/services/validator-registry.service';
import { InteractiveConfigStepComponent } from 'src/app/shared/remote-config/interactive-config-step/interactive-config-step.component';
import { IconService } from 'src/app/shared/services/icon.service';
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
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatDividerModule,
    MatProgressSpinnerModule,
    MatIconModule,
    MatButtonModule,
    MatExpansionModule,
    MatSlideToggleModule,
    MatTabsModule,
    InteractiveConfigStepComponent,
    MatTooltipModule,
    OperationConfigComponent,
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
  private readonly cdRef = inject(ChangeDetectorRef);
  private readonly validatorRegistry = inject(ValidatorRegistryService);
  readonly iconService = inject(IconService);
  private readonly nautilusService = inject(NautilusService);

  readonly quickAddForm: FormGroup;
  remoteTypes: RemoteType[] = [];
  existingRemotes: string[] = [];
  isAuthInProgress = false;
  isAuthCancelled = false;
  currentStep: WizardStep = 'setup';
  interactiveFlowState: InteractiveFlowState = createInitialInteractiveFlowState();

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
    this.setupAuthStateListeners();
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
    } catch (error) {
      console.error('Error initializing component:', error);
    }
  }

  private setupAuthStateListeners(): void {
    this.authStateService.isAuthInProgress$
      .pipe(takeUntil(this.destroy$))
      .subscribe(isInProgress => {
        this.isAuthInProgress = isInProgress;
        this.setFormState(isInProgress);
      });

    this.authStateService.isAuthCancelled$.pipe(takeUntil(this.destroy$)).subscribe(isCancelled => {
      this.isAuthCancelled = isCancelled;
      this.cdRef.markForCheck();
    });
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
        remoteName: [
          '',
          [
            Validators.required,
            this.validatorRegistry.createRemoteNameValidator(this.existingRemotes),
          ],
        ],
        remoteType: ['', Validators.required],
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
      .get('setup.remoteType')
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
    if (this.currentStep === 'setup') {
      this.quickAddForm.get('setup')?.markAllAsTouched();
      if (this.isSetupStepValid()) {
        this.currentStep = 'operations';
      }
    }
  }

  prevStep(): void {
    if (this.currentStep === 'operations') {
      this.currentStep = 'setup';
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

    if (this.quickAddForm.invalid || this.isAuthInProgress || !setup || !operations) {
      return;
    }

    await this.authStateService.startAuth(setup.remoteName, false);

    try {
      if (setup.useInteractiveMode) {
        await this.handleInteractiveCreation(setup, operations);
      } else {
        await this.handleStandardCreation(setup, operations);
        if (!this.isAuthCancelled) this.dialogRef.close(true);
      }
    } catch (error) {
      console.error('Error in onSubmit:', error);
    } finally {
      if (!setup.useInteractiveMode || !this.interactiveFlowState.isActive) {
        this.authStateService.resetAuthState();
      }
    }
  }

  private async handleStandardCreation(setup: any, operations: any): Promise<void> {
    const finalConfig = this.buildFinalConfig(setup.remoteName, operations);
    await this.remoteManagementService.createRemote(setup.remoteName, {
      name: setup.remoteName,
      type: setup.remoteType,
    });
    await this.appSettingsService.saveRemoteSettings(setup.remoteName, finalConfig);
    await this.triggerAutoStartOperations(setup.remoteName, finalConfig);
  }

  private async handleInteractiveCreation(setup: any, operations: any): Promise<void> {
    const finalConfig = this.buildFinalConfig(setup.remoteName, operations);
    this.pendingConfig = {
      remoteData: { name: setup.remoteName, type: setup.remoteType },
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
    } => ({
      source: buildPathString(op.source, remoteName),
      dest: buildPathString(op.dest, remoteName),
      autoStart: op.autoStart || false,
      cronEnabled: op.cronEnabled || false,
      cronExpression: op.cronExpression || null,
    });

    return {
      mountConfigs: { default: { ...createConfig(operations.mount), type: 'mount' } },
      copyConfigs: { default: createConfig(operations.copy) },
      syncConfigs: { default: createConfig(operations.sync) },
      bisyncConfigs: { default: createConfig(operations.bisync) },
      moveConfigs: { default: createConfig(operations.move) },
      filterConfigs: { default: {} },
      vfsConfigs: { default: { options: { CacheMode: 'full', ChunkSize: '32M' } } },
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
      this.currentStep = 'interactive';
      this.interactiveFlowState = {
        isActive: true,
        question: startResp,
        answer: getDefaultAnswerFromQuestion(startResp),
        isProcessing: false,
        isInteractive: true,
      } as InteractiveFlowState; // Cast to fix type if needed or just use object
      this.cdRef.markForCheck();
    } catch (error) {
      console.error('Error starting interactive config:', error);
      await this.finalizeRemoteCreation();
    }
  }

  async onInteractiveContinue(answer: string | number | boolean | null): Promise<void> {
    this.interactiveFlowState.answer = answer;
    this.interactiveFlowState.isProcessing = true;
    try {
      await this.submitRcAnswer();
    } finally {
      if (this.interactiveFlowState.isActive) {
        this.interactiveFlowState.isProcessing = false;
      }
      this.cdRef.markForCheck();
    }
  }

  private async submitRcAnswer(): Promise<void> {
    if (
      !this.interactiveFlowState.isActive ||
      !this.interactiveFlowState.question ||
      !this.pendingConfig
    ) {
      return;
    }
    try {
      let answer: unknown = this.interactiveFlowState.answer;
      if (this.interactiveFlowState.question?.Option?.Type === 'bool') {
        answer = convertBoolAnswerToString(answer);
      }
      const resp = await this.remoteManagementService.continueRemoteConfigNonInteractive(
        this.pendingConfig.remoteData.name,
        this.interactiveFlowState.question.State,
        answer,
        {},
        { nonInteractive: true }
      );
      if (!resp || resp.State === '') {
        this.interactiveFlowState.isActive = false;
        this.interactiveFlowState.question = null;
        await this.finalizeRemoteCreation();
      } else {
        this.interactiveFlowState.question = resp;
        this.interactiveFlowState.answer = getDefaultAnswerFromQuestion(resp);
      }
    } catch (error) {
      console.error('Interactive config error:', error);
      await this.finalizeRemoteCreation();
    }
  }

  isInteractiveContinueDisabled(): boolean {
    return isInteractiveContinueDisabled(this.interactiveFlowState, this.isAuthCancelled);
  }

  handleInteractiveAnswerUpdate(newAnswer: string | number | boolean | null): void {
    if (this.interactiveFlowState.isActive) {
      this.interactiveFlowState = updateInteractiveAnswer(this.interactiveFlowState, newAnswer);
      this.cdRef.markForCheck();
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
    this.dialogRef.close(true);
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
      await this.mountManagementService.mountRemoteProfile(remoteName, 'default');
    }

    if (copyConfig?.autoStart && copyConfig?.source && copyConfig?.dest) {
      await this.jobManagementService.startCopyProfile(remoteName, 'default');
    }

    if (syncConfig?.autoStart && syncConfig?.source && syncConfig?.dest) {
      await this.jobManagementService.startSyncProfile(remoteName, 'default');
    }

    if (bisyncConfig?.autoStart && bisyncConfig?.source && bisyncConfig?.dest) {
      await this.jobManagementService.startBisyncProfile(remoteName, 'default');
    }

    if (moveConfig?.autoStart && moveConfig?.source && moveConfig?.dest) {
      await this.jobManagementService.startMoveProfile(remoteName, 'default');
    }
  }

  async cancelAuth(): Promise<void> {
    await this.authStateService.cancelAuth();
    this.currentStep = 'operations';
    this.interactiveFlowState = createInitialInteractiveFlowState();
    this.cdRef.markForCheck();
  }

  private setFormState(disabled: boolean): void {
    if (disabled) {
      this.quickAddForm.disable();
    } else {
      this.quickAddForm.enable();
    }
  }

  getSubmitButtonText(): string {
    return this.isAuthInProgress && !this.isAuthCancelled ? 'Adding Remote...' : 'Create Remote';
  }

  get selectedRemoteLabel(): string {
    const remoteType = this.quickAddForm.get('setup.remoteType')?.value;
    const remote = this.remoteTypes.find(r => r.value === remoteType);
    return remote ? remote.label : 'Select Remote Type';
  }

  @HostListener('document:keydown.escape')
  close(): void {
    if (this.nautilusService.isNautilusOverlayOpen) {
      return;
    }
    this.dialogRef.close();
  }
}
