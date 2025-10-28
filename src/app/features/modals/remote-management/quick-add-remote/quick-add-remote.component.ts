import {
  Component,
  HostListener,
  OnInit,
  OnDestroy,
  inject,
  ChangeDetectorRef,
} from '@angular/core';
import {
  AbstractControl,
  FormBuilder,
  FormGroup,
  ReactiveFormsModule,
  ValidationErrors,
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
import { AnimationsService } from '../../../../shared/services/animations.service';
import { AuthStateService } from '../../../../shared/services/auth-state.service';
import {
  RemoteManagementService,
  JobManagementService,
  MountManagementService,
  AppSettingsService,
  FileSystemService,
} from '@app/services';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { RemoteType, RcConfigQuestionResponse, RemoteConfigSections } from '@app/types';
import { InteractiveConfigStepComponent } from 'src/app/shared/remote-config/interactive-config-step/interactive-config-step.component';
import { OperationConfigComponent } from '../app-operation-config/app-operation-config.component';

interface InteractiveFlowState {
  isActive: boolean;
  question: RcConfigQuestionResponse | null;
  answer: string | boolean | number | null;
  isProcessing: boolean;
}

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
    // MatCheckboxModule,
    MatProgressSpinnerModule,
    MatIconModule,
    MatButtonModule,
    MatExpansionModule,
    MatSlideToggleModule,
    MatTabsModule,
    InteractiveConfigStepComponent,
    MatTooltipModule,
    OperationConfigComponent, // Import the child component
  ],
  templateUrl: './quick-add-remote.component.html',
  styleUrls: ['./quick-add-remote.component.scss', '../../../../styles/_shared-modal.scss'],
  // Use the shared AnimationsService to attach multiple reusable animation triggers.
  animations: AnimationsService.getAnimations(['slideAnimation', 'slideInFromBottom', 'fadeInOut']),
})
export class QuickAddRemoteComponent implements OnInit, OnDestroy {
  // Services
  private readonly fb = inject(FormBuilder);
  private readonly dialogRef = inject(MatDialogRef<QuickAddRemoteComponent>);
  private readonly authStateService = inject(AuthStateService);
  private readonly remoteManagementService = inject(RemoteManagementService);
  private readonly jobManagementService = inject(JobManagementService);
  private readonly mountManagementService = inject(MountManagementService);
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly fileSystemService = inject(FileSystemService);
  private readonly cdRef = inject(ChangeDetectorRef);

  // Form and Data
  readonly quickAddForm: FormGroup;
  remoteTypes: RemoteType[] = [];
  existingRemotes: string[] = [];

  // State
  isAuthInProgress = false;
  isAuthCancelled = false;
  currentStep: WizardStep = 'setup';

  // Interactive Flow
  interactiveFlowState: InteractiveFlowState = {
    isActive: false,
    question: null,
    answer: null,
    isProcessing: false,
  };

  // Constants
  private readonly INTERACTIVE_REMOTES = ['iclouddrive', 'onedrive'];
  private readonly destroy$ = new Subject<void>();
  private pendingConfig: {
    remoteData: { name: string; type: string };
    finalConfig: RemoteConfigSections;
  } | null = null;

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

  // ============================================================================
  // INITIALIZATION
  // ============================================================================

  private async initializeComponent(): Promise<void> {
    try {
      const oauthSupportedRemotes = await this.remoteManagementService.getOAuthSupportedRemotes();
      this.remoteTypes = oauthSupportedRemotes.map(remote => ({
        value: remote.name,
        label: remote.description,
      }));
      // We load existing remotes here to pass to the child component
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

  // ============================================================================
  // FORM MANAGEMENT
  // ============================================================================

  private createOperationPathGroup(
    defaultType: 'local' | 'currentRemote' | 'otherRemote'
  ): FormGroup {
    return this.fb.group({
      pathType: new FormControl(defaultType),
      path: new FormControl(''),
      otherRemoteName: new FormControl(''), // For 'otherRemote' type
    });
  }

  private createOperationGroup(opType: 'mount' | 'sync' | 'copy' | 'bisync' | 'move'): FormGroup {
    if (opType === 'mount') {
      // Mount is special: source MUST be currentRemote, dest MUST be local
      return this.fb.group({
        autoStart: new FormControl(false),
        source: this.createOperationPathGroup('currentRemote'), // Locked to currentRemote
        dest: this.createOperationPathGroup('local'), // Locked to local
      });
    }

    // Other ops default to remote -> local
    return this.fb.group({
      autoStart: new FormControl(false),
      source: this.createOperationPathGroup('currentRemote'),
      dest: this.createOperationPathGroup('local'),
    });
  }

  private createQuickAddForm(): FormGroup {
    return this.fb.group({
      // Step 1: Setup
      setup: this.fb.group({
        remoteName: ['', [Validators.required, this.validateRemoteName.bind(this)]],
        remoteType: ['', Validators.required],
        useInteractiveMode: [false],
      }),

      // Step 2: Operations (now deeply nested)
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
    const operationNames = ['mount', 'sync', 'copy', 'bisync', 'move'];
    operationNames.forEach(opName => {
      const opGroup = this.quickAddForm.get(`operations.${opName}`);

      // Listen to autoStart toggle
      opGroup
        ?.get('autoStart')
        ?.valueChanges.pipe(takeUntil(this.destroy$))
        .subscribe((enabled: boolean) => {
          // Get the 'path' control inside 'dest' and 'source'
          const destPathControl = opGroup.get('dest.path');
          const sourcePathControl = opGroup.get('source.path');

          if (enabled) {
            // Mount is special, only dest is required (source is optional root)
            if (opName === 'mount') {
              destPathControl?.setValidators([Validators.required]);
            } else {
              // Other ops require both source and dest
              destPathControl?.setValidators([Validators.required]);
              sourcePathControl?.setValidators([Validators.required]);
            }
          } else {
            // Clear validators
            destPathControl?.clearValidators();
            sourcePathControl?.clearValidators();
          }
          destPathControl?.updateValueAndValidity();
          sourcePathControl?.updateValueAndValidity();
        });
    });
  }

  private onRemoteTypeChange(remoteType: string): void {
    const shouldUseInteractive = this.INTERACTIVE_REMOTES.includes(remoteType.toLowerCase());
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

  validateRemoteName(control: AbstractControl): ValidationErrors | null {
    const value = control.value?.trim();
    return value && this.existingRemotes.includes(value) ? { nameTaken: true } : null;
  }

  // ============================================================================
  // WIZARD NAVIGATION
  // ============================================================================

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

  // ============================================================================
  // UI INTERACTIONS (Updated)
  // ============================================================================

  async selectFolder(opName: string, pathType: 'source' | 'dest'): Promise<void> {
    try {
      const selectedPath = await this.fileSystemService.selectFolder(true);
      if (selectedPath) {
        // Set the value on the correct nested 'path' control
        this.quickAddForm.get(`operations.${opName}.${pathType}.path`)?.patchValue(selectedPath);
      }
    } catch (error) {
      console.error('Error selecting folder:', error);
    }
  }

  // ============================================================================
  // FORM SUBMISSION (Updated)
  // ============================================================================

  async onSubmit(): Promise<void> {
    const setup = this.quickAddForm.get('setup')?.value;
    const operations = this.quickAddForm.get('operations')?.value;

    if (this.quickAddForm.invalid || this.isAuthInProgress || !setup || !operations) {
      return;
    }

    await this.authStateService.startAuth(setup.remoteName, false);

    try {
      // We pass setup and operations values to the handlers
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
      remoteData: {
        name: setup.remoteName,
        type: setup.remoteType,
      },
      finalConfig,
    };

    await this.startInteractiveRemoteConfig();
  }

  private buildPathString(pathGroup: any, currentRemoteName: string): string {
    const { pathType, path, otherRemoteName } = pathGroup;
    const p = path || ''; // Use empty string if path is null/undefined

    switch (pathType) {
      case 'local':
        return p;
      case 'currentRemote':
        return `${currentRemoteName}:/${p}`;
      case 'otherRemote':
        return `${otherRemoteName}:/${p}`;
      default:
        return '';
    }
  }

  private buildFinalConfig(remoteName: string, operations: any): RemoteConfigSections {
    // Helper to create config from a single operation object
    const createConfig = (op: any) => ({
      source: this.buildPathString(op.source, remoteName),
      dest: this.buildPathString(op.dest, remoteName),
      autoStart: op.autoStart || false,
    });

    return {
      mountConfig: { ...createConfig(operations.mount), type: 'mount' },
      copyConfig: createConfig(operations.copy),
      syncConfig: createConfig(operations.sync),
      bisyncConfig: createConfig(operations.bisync),
      moveConfig: createConfig(operations.move),
      filterConfig: {},
      vfsConfig: { CacheMode: 'full', ChunkSize: '32M' },
      backendConfig: {},
      showOnTray: true,
    };
  }

  // ============================================================================
  // INTERACTIVE FLOW
  // ============================================================================
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
        answer: this.getDefaultAnswerFromQuestion(startResp),
        isProcessing: false,
      };
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
        answer = typeof answer === 'boolean' ? (answer ? 'true' : 'false') : String(answer);
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
        this.interactiveFlowState.answer = this.getDefaultAnswerFromQuestion(resp);
      }
    } catch (error) {
      console.error('Interactive config error:', error);
      await this.finalizeRemoteCreation();
    }
  }

  private getDefaultAnswerFromQuestion(q: RcConfigQuestionResponse): string | boolean | number {
    const opt = q.Option;
    if (!opt) return '';
    if (opt.Type === 'bool') {
      if (typeof opt.Value === 'boolean') return opt.Value;
      if (opt.ValueStr !== undefined) return opt.ValueStr.toLowerCase() === 'true';
      if (opt.DefaultStr !== undefined) return opt.DefaultStr.toLowerCase() === 'true';
      return typeof opt.Default === 'boolean' ? opt.Default : true;
    }
    return (
      opt.ValueStr || opt.DefaultStr || String(opt.Default || '') || opt.Examples?.[0]?.Value || ''
    );
  }

  isInteractiveContinueDisabled(): boolean {
    if (this.isAuthCancelled || this.interactiveFlowState.isProcessing) return true;
    if (!this.interactiveFlowState.question?.Option?.Required) return false;
    const answer = this.interactiveFlowState.answer;
    return (
      answer === null ||
      answer === undefined ||
      (typeof answer === 'string' && answer.trim() === '')
    );
  }

  handleInteractiveAnswerUpdate(newAnswer: string | number | boolean | null): void {
    if (this.interactiveFlowState.isActive) {
      this.interactiveFlowState.answer = newAnswer;
      this.cdRef.markForCheck();
    }
  }

  // ============================================================================
  // FINALIZATION (Updated)
  // ============================================================================

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
    const { mountConfig, copyConfig, syncConfig, bisyncConfig, moveConfig } = finalConfig;

    const operations = [
      {
        opName: 'mount',
        config: mountConfig,
        service: (): Promise<void> =>
          this.mountManagementService.mountRemote(
            remoteName, // Note: remoteName is for context, not the path
            mountConfig.source, // e.g., 'my-drive:/'
            mountConfig.dest, // e.g., 'C:/Mount'
            mountConfig.type
          ),
      },
      {
        opName: 'copy',
        config: copyConfig,
        service: (): Promise<number> =>
          this.jobManagementService.startCopy(remoteName, copyConfig.source, copyConfig.dest),
      },
      {
        opName: 'sync',
        config: syncConfig,
        service: (): Promise<number> =>
          this.jobManagementService.startSync(remoteName, syncConfig.source, syncConfig.dest),
      },
      {
        opName: 'bisync',
        config: bisyncConfig,
        service: (): Promise<number> =>
          this.jobManagementService.startBisync(remoteName, bisyncConfig.source, bisyncConfig.dest),
      },
      {
        opName: 'move',
        config: moveConfig,
        service: (): Promise<number> =>
          this.jobManagementService.startMove(remoteName, moveConfig.source, moveConfig.dest),
      },
    ];

    for (const { opName, config, service } of operations) {
      if (config.autoStart && (opName === 'mount' ? config.dest : config.source && config.dest)) {
        await service();
      }
    }
  }

  // ============================================================================
  // UTILITIES
  // ============================================================================

  async cancelAuth(): Promise<void> {
    await this.authStateService.cancelAuth();
    this.currentStep = 'operations';
    this.interactiveFlowState = {
      isActive: false,
      question: null,
      answer: null,
      isProcessing: false,
    };
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

  @HostListener('document:keydown.escape', ['$event'])
  close(): void {
    if (!this.isAuthInProgress) {
      this.dialogRef.close();
    }
  }
}
