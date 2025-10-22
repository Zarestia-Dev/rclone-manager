import { Component, HostListener, inject, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, FormGroup, ValidatorFn, Validators, FormControl } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { debounceTime, distinctUntilChanged, Subscription } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { RemoteConfigStepComponent } from '../../../../shared/remote-config/components/remote-config-step/remote-config-step.component';
import { FlagConfigStepComponent } from '../../../../shared/remote-config/components/flag-config-step/flag-config-step.component';
import {
  EditTarget,
  FlagType,
  REMOTE_NAME_REGEX,
  RemoteType,
} from '../../../../shared/remote-config/remote-config-types';
import { RcConfigQuestionResponse } from '@app/services';
import { InteractiveConfigStepComponent } from '../../../../shared/remote-config/components/interactive-config-step/interactive-config-step.component';

// Services
import { AnimationsService } from '../../../../shared/services/animations.service';
import { AuthStateService } from '../../../../shared/services/auth-state.service';
import { ValidatorRegistryService } from '../../../../shared/services/validator-registry.service';
import { FlagConfigService } from '@app/services';
import { PathSelectionService } from '@app/services';
import { RemoteManagementService } from '@app/services';
import { JobManagementService } from '@app/services';
import { MountManagementService } from '@app/services';
import { AppSettingsService } from '@app/services';
import { FileSystemService } from '@app/services';
import { UiStateService } from '@app/services';
import {
  BackendConfig,
  MountConfig,
  CopyConfig,
  SyncConfig,
  BisyncConfig,
  MoveConfig,
  FilterConfig,
  VfsConfig,
  RcConfigOption,
} from '@app/types';
import { MatProgressSpinner } from '@angular/material/progress-spinner';

@Component({
  selector: 'app-remote-config-modal',
  standalone: true,
  imports: [
    CommonModule,
    MatIconModule,
    MatButtonModule,
    RemoteConfigStepComponent,
    FlagConfigStepComponent,
    InteractiveConfigStepComponent,
    MatProgressSpinner,
  ],
  templateUrl: './remote-config-modal.component.html',
  styleUrls: ['./remote-config-modal.component.scss', '../../../../styles/_shared-modal.scss'],
  animations: [
    AnimationsService.getAnimations([
      'slideAnimation',
      'fadeInOutWithMove',
      'fadeInOut',
      'labelSlideIn',
    ]),
  ],
})
export class RemoteConfigModalComponent implements OnInit, OnDestroy {
  fb = inject(FormBuilder);
  dialogRef = inject(MatDialogRef<RemoteConfigModalComponent>);
  flagConfigService = inject(FlagConfigService);
  pathSelectionService = inject(PathSelectionService);
  authStateService = inject(AuthStateService);
  remoteManagementService = inject(RemoteManagementService);
  jobManagementService = inject(JobManagementService);
  mountManagementService = inject(MountManagementService);
  appSettingsService = inject(AppSettingsService);
  fileSystemService = inject(FileSystemService);
  uiStateService = inject(UiStateService);
  validatorRegistry = inject(ValidatorRegistryService);
  data = inject(MAT_DIALOG_DATA) as {
    editTarget?: EditTarget;
    cloneTarget?: boolean;
    existingConfig?: Record<string, unknown>;
    name?: string;
    restrictMode: boolean;
  };

  public readonly TOTAL_STEPS = 9;

  currentStep = 1;
  editTarget: EditTarget = null;
  useInteractiveMode = false;
  restrictMode!: boolean;
  cloneTarget!: boolean;

  remoteForm: FormGroup;
  remoteConfigForm: FormGroup;

  remoteTypes: RemoteType[] = [];
  dynamicRemoteFields: RcConfigOption[] = [];
  existingRemotes: string[] = [];
  mountTypes: string[] = [];

  // UPDATED: Type is now RcConfigOption[]
  dynamicFlagFields: Record<FlagType, RcConfigOption[]> = {
    mount: [],
    copy: [],
    sync: [],
    filter: [],
    vfs: [],
    bisync: [],
    move: [],
    backend: [],
  };
  // Simplified state management
  isRemoteConfigLoading = false;
  isAuthInProgress = false;
  isAuthCancelled = false;
  isProcessing = false;

  // Non-interactive RC flow state
  rcQuestion: RcConfigQuestionResponse | null = null;
  rcAnswer: string | boolean | number | null = null;
  isInteractiveActive = false;
  private pendingFinalConfig: {
    mountConfig: MountConfig;
    copyConfig: CopyConfig;
    syncConfig: SyncConfig;
    bisyncConfig: BisyncConfig;
    moveConfig: MoveConfig;
    filterConfig: FilterConfig;
    backendConfig: BackendConfig;
    vfsConfig: VfsConfig;
  } | null = null;
  private pendingRemoteData: { name: string; type: string; [k: string]: unknown } | null = null;

  private subscriptions: Subscription[] = [];

  constructor() {
    this.editTarget = this.data?.editTarget || null;
    this.cloneTarget = this.data?.cloneTarget || false;
    this.restrictMode = this.data?.restrictMode;
    this.remoteForm = this.createRemoteForm();
    this.remoteConfigForm = this.createRemoteConfigForm();
  }

  async ngOnInit(): Promise<void> {
    // initializeComponent now adds dynamic controls *before* populating
    await this.initializeComponent();
    this.setupFormListeners();
    this.mountTypes = await this.mountManagementService.getMountTypes();
    this.setupAuthStateListeners();
    await this.fetchInitialPathEntriesForEditMode();

    // Setup path selection listeners
    const subs = [
      this.remoteConfigForm
        .get('mountConfig.source')
        ?.valueChanges.pipe(debounceTime(300), distinctUntilChanged())
        .subscribe(value =>
          this.pathSelectionService.onInputChanged('mountConfig.source', value ?? '')
        ),
      this.remoteConfigForm
        .get('copyConfig.source')
        ?.valueChanges.pipe(debounceTime(300), distinctUntilChanged())
        .subscribe(value =>
          this.pathSelectionService.onInputChanged('copyConfig.source', value ?? '')
        ),
      this.remoteConfigForm
        .get('syncConfig.source')
        ?.valueChanges.pipe(debounceTime(300), distinctUntilChanged())
        .subscribe(value =>
          this.pathSelectionService.onInputChanged('syncConfig.source', value ?? '')
        ),
      this.remoteConfigForm
        .get('copyConfig.dest')
        ?.valueChanges.pipe(debounceTime(300), distinctUntilChanged())
        .subscribe(value =>
          this.pathSelectionService.onInputChanged('copyConfig.dest', value ?? '')
        ),
      this.remoteConfigForm
        .get('syncConfig.dest')
        ?.valueChanges.pipe(debounceTime(300), distinctUntilChanged())
        .subscribe(value =>
          this.pathSelectionService.onInputChanged('syncConfig.dest', value ?? '')
        ),
      this.remoteConfigForm
        .get('bisyncConfig.dest')
        ?.valueChanges.pipe(debounceTime(300), distinctUntilChanged())
        .subscribe(value =>
          this.pathSelectionService.onInputChanged('bisyncConfig.dest', value ?? '')
        ),
      this.remoteConfigForm
        .get('moveConfig.dest')
        ?.valueChanges.pipe(debounceTime(300), distinctUntilChanged())
        .subscribe(value =>
          this.pathSelectionService.onInputChanged('moveConfig.dest', value ?? '')
        ),
    ].filter((sub): sub is Subscription => !!sub);
    this.subscriptions.push(...subs);
  }

  stepLabels: string[] = [
    'Remote Config',
    'Mount',
    'Copy',
    'Sync',
    'Bisync',
    'Move',
    'Filter',
    'VFS',
    'Backend',
  ];

  /**
   * Get current step label for display
   */
  getCurrentStepLabel(): string {
    if (this.currentStep === 1) {
      return 'Remote Configuration';
    }

    const stepIndex = this.currentStep - 2;
    if (stepIndex >= 0 && stepIndex < this.flagConfigService.FLAG_TYPES.length) {
      const type = this.flagConfigService.FLAG_TYPES[stepIndex];
      return type.charAt(0).toUpperCase() + type.slice(1) + ' Configuration';
    }

    return '';
  }

  /**
   * Navigate to a specific step (used when clicking step indicators in edit mode)
   */
  goToStep(step: number): void {
    if (step >= 1 && step <= this.TOTAL_STEPS) {
      this.currentStep = step;
    }
  }

  /**
   * Get step information for accessibility
   */
  getStepProgress(): { current: number; total: number; percentage: number } {
    return {
      current: this.currentStep,
      total: this.TOTAL_STEPS,
      percentage: Math.round((this.currentStep / this.TOTAL_STEPS) * 100),
    };
  }

  /**
   * Get visual state for current step
   */
  getStepState(stepNumber: number): 'completed' | 'current' | 'future' {
    if (stepNumber < this.currentStep) {
      return 'completed';
    } else if (stepNumber === this.currentStep) {
      return 'current';
    } else {
      return 'future';
    }
  }

  getStepIcon(stepIndex: number): string {
    const iconMap: Record<number, string> = {
      0: 'hard-drive', // Remote Config
      1: 'mount', // Mount
      2: 'copy', // Copy
      3: 'sync', // Sync
      4: 'right-left', // Bisync (bidirectional sync)
      5: 'move', // Move
      6: 'filter', // Filter
      7: 'vfs', // VFS (Virtual File System)
      8: 'server', // Backend
    };

    return iconMap[stepIndex] || 'circle';
  }

  getStepProgressAriaLabel(): string {
    return `Step ${this.currentStep} of ${this.TOTAL_STEPS}: ${this.stepLabels[this.currentStep - 1]}`;
  }

  /**
   * Handle keyboard navigation for step indicators
   */
  handleStepKeydown(event: KeyboardEvent, stepNumber: number): void {
    if (!this.editTarget) return;

    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        if (stepNumber < this.TOTAL_STEPS) {
          this.goToStep(stepNumber + 1);
        }
        break;
      case 'ArrowLeft':
        event.preventDefault();
        if (stepNumber > 1) {
          this.goToStep(stepNumber - 1);
        }
        break;
      case 'Home':
        event.preventDefault();
        this.goToStep(1);
        break;
      case 'End':
        event.preventDefault();
        this.goToStep(this.TOTAL_STEPS);
        break;
    }
  }

  ngOnDestroy(): void {
    this.cleanupSubscriptions();
    this.authStateService.cancelAuth();
  }

  private async initializeComponent(): Promise<void> {
    await this.loadExistingRemotes();
    this.dynamicFlagFields = await this.flagConfigService.loadAllFlagFields();

    this.dynamicFlagFields.move = [...this.dynamicFlagFields.copy];
    this.dynamicFlagFields.bisync = [...this.dynamicFlagFields.copy];

    this.flagConfigService.FLAG_TYPES.forEach(flagType => {
      const optionsGroup = this.remoteConfigForm.get(`${flagType}Config.options`) as FormGroup;

      if (optionsGroup && this.dynamicFlagFields[flagType]) {
        this.dynamicFlagFields[flagType].forEach(field => {
          const defaultValue = field.Value !== undefined ? field.Value : field.Default;
          optionsGroup.addControl(field.Name, new FormControl(defaultValue));
        });
      }
    });

    if (this.data?.existingConfig) {
      this.populateForm(this.data.existingConfig);
    }

    this.loadRemoteTypes();
  }

  // Remote Config Service
  private async loadRemoteTypes(): Promise<void> {
    this.remoteTypes = await this.getRemoteTypes();
  }

  async onRemoteTypeChange(): Promise<void> {
    this.isRemoteConfigLoading = true;
    try {
      const remoteType = this.remoteForm.get('type')?.value;

      this.useInteractiveMode = ['iclouddrive', 'onedrive'].includes(remoteType?.toLowerCase());
      this.dynamicRemoteFields =
        await this.remoteManagementService.getRemoteConfigFields(remoteType);

      // 1. Clear out old dynamic fields from the form
      Object.keys(this.remoteForm.controls).forEach(key => {
        if (key !== 'name' && key !== 'type') {
          this.remoteForm.removeControl(key);
        }
      });

      this.dynamicRemoteFields.forEach(field => {
        this.remoteForm.addControl(field.Name, new FormControl(field.Value));
      });
    } catch (error) {
      console.error('Error loading remote config fields:', error);
    } finally {
      this.isRemoteConfigLoading = false;
    }
  }

  onInteractiveModeToggled(useInteractiveMode: boolean): void {
    this.useInteractiveMode = useInteractiveMode;
  }

  async getRemoteTypes(): Promise<RemoteType[]> {
    try {
      const providers = await this.remoteManagementService.getRemoteTypes();
      return providers.map(provider => ({
        value: provider.name,
        label: provider.description,
      }));
    } catch (error) {
      console.error('Error fetching remote types:', error);
      throw error;
    }
  }

  private setupAuthStateListeners(): void {
    this.subscriptions.push(
      this.authStateService.isAuthInProgress$.subscribe(isInProgress => {
        this.isAuthInProgress = isInProgress;
        this.setFormState(isInProgress);
      })
    );
    this.subscriptions.push(
      this.authStateService.isAuthCancelled$.subscribe(isCancelled => {
        this.isAuthCancelled = isCancelled;
      })
    );
  }

  private setupFormListeners(): void {
    // Mount path required if autoStart is enabled
    this.remoteConfigForm.get('mountConfig.autoStart')?.valueChanges.subscribe(enabled => {
      const destCtrl = this.remoteConfigForm.get('mountConfig.dest');
      if (enabled) {
        destCtrl?.setValidators([
          Validators.required,
          this.validatorRegistry.getValidator('crossPlatformPath')!,
        ]);
      } else {
        destCtrl?.setValidators([this.validatorRegistry.getValidator('crossPlatformPath')!]);
      }
      destCtrl?.updateValueAndValidity();
    });

    // Copy source/dest required if autoStart is enabled
    this.remoteConfigForm.get('copyConfig.autoStart')?.valueChanges.subscribe(enabled => {
      const destCtrl = this.remoteConfigForm.get('copyConfig.dest');
      if (enabled) {
        destCtrl?.setValidators([Validators.required]);
      } else {
        destCtrl?.clearValidators();
      }
      destCtrl?.updateValueAndValidity();
    });

    // Sync source/dest required if autoStart is enabled
    this.remoteConfigForm.get('syncConfig.autoStart')?.valueChanges.subscribe(enabled => {
      const destCtrl = this.remoteConfigForm.get('syncConfig.dest');
      if (enabled) {
        destCtrl?.setValidators([Validators.required]);
      } else {
        destCtrl?.clearValidators();
      }
      destCtrl?.updateValueAndValidity();
    });

    // Bisync source/dest required if autoStart is enabled
    this.remoteConfigForm.get('bisyncConfig.autoStart')?.valueChanges.subscribe(enabled => {
      const destCtrl = this.remoteConfigForm.get('bisyncConfig.dest');
      if (enabled) {
        destCtrl?.setValidators([Validators.required]);
      } else {
        destCtrl?.clearValidators();
      }
      destCtrl?.updateValueAndValidity();
    });

    // Move source/dest required if autoStart is enabled
    this.remoteConfigForm.get('moveConfig.autoStart')?.valueChanges.subscribe(enabled => {
      const destCtrl = this.remoteConfigForm.get('moveConfig.dest');
      if (enabled) {
        destCtrl?.setValidators([Validators.required]);
      } else {
        destCtrl?.clearValidators();
      }
      destCtrl?.updateValueAndValidity();
    });
  }

  async onSourceOptionSelectedField(entryName: string, formPath: string): Promise<void> {
    const control = this.remoteConfigForm.get(formPath);
    await this.pathSelectionService.onPathSelected(formPath, entryName, control);
  }

  async onDestOptionSelectedField(entryName: string, formPath: string): Promise<void> {
    const control = this.remoteConfigForm.get(formPath);
    await this.pathSelectionService.onPathSelected(formPath, entryName, control);
  }

  async onRemoteSelected(remoteWithColon: string, formPath: string): Promise<void> {
    const control = this.remoteConfigForm.get(formPath);
    await this.pathSelectionService.onRemoteSelected(formPath, remoteWithColon, control);
  }

  async onRemoteSelectedField(remoteWithColon: string, formPath: string): Promise<void> {
    const control = this.remoteConfigForm.get(formPath);
    await this.pathSelectionService.onRemoteSelected(formPath, remoteWithColon, control);
  }

  resetRemoteSelectionField(formPath: string): void {
    this.pathSelectionService.resetPathSelection(formPath);
    this.remoteConfigForm.get(formPath)?.setValue('');
  }

  private cleanupSubscriptions(): void {
    this.subscriptions.forEach(sub => sub.unsubscribe());
    this.subscriptions = [];
  }

  private createRemoteForm(): FormGroup {
    const isEditMode = this.editTarget === 'remote' && !!this.data?.existingConfig;
    const form = this.fb.group({
      name: [
        { value: '', disabled: isEditMode },
        [Validators.required, this.validateRemoteNameFactory()],
      ],
      type: [{ value: '', disabled: isEditMode }, [Validators.required]],
    });
    return form;
  }

  private createRemoteConfigForm(): FormGroup {
    return this.fb.group({
      mountConfig: this.fb.group({
        autoStart: [false],
        dest: [''],
        source: [''],
        type: [''],
        options: this.fb.group({}),
      }),
      copyConfig: this.fb.group({
        autoStart: [false],
        source: [''],
        dest: [''],
        createEmptySrcDirs: [false],
        options: this.fb.group({}),
      }),
      syncConfig: this.fb.group({
        autoStart: [false],
        source: [''],
        dest: [''],
        createEmptySrcDirs: [false],
        options: this.fb.group({}),
      }),
      bisyncConfig: this.fb.group({
        autoStart: [false],
        source: [''],
        dest: [''],
        dryRun: [false],
        resync: [false],
        checkAccess: [false],
        checkFilename: [''],
        maxDelete: [null],
        force: [false],
        checkSync: [false],
        createEmptySrcDirs: [false],
        removeEmptyDirs: [false],
        filtersFile: [''],
        ignoreListingChecksum: [false],
        resilient: [false],
        workdir: [''],
        backupdir1: [''],
        backupdir2: [''],
        noCleanup: [false],
        options: this.fb.group({}),
      }),
      moveConfig: this.fb.group({
        autoStart: [false],
        source: [''],
        dest: [''],
        createEmptySrcDirs: [false],
        deleteEmptySrcDirs: [false],
        options: this.fb.group({}),
      }),
      filterConfig: this.fb.group({
        options: this.fb.group({}),
      }),
      vfsConfig: this.fb.group({
        options: this.fb.group({}),
      }),
      backendConfig: this.fb.group({
        options: this.fb.group({}),
      }),
    });
  }

  //#region Remote Configuration Methods
  private async loadExistingRemotes(): Promise<void> {
    try {
      this.existingRemotes = await this.remoteManagementService.getRemotes();
    } catch (error) {
      console.error('Error loading existing remotes:', error);
    }
  }
  //#endregion

  //#region Form Population Methods
  populateForm(config: any): void {
    if (!this.editTarget && !this.cloneTarget) return;
    if (this.editTarget === 'remote') {
      this.populateRemoteForm(config);
    } else if (this.cloneTarget) {
      this.populateRemoteForm(config.remoteSpecs);
      this.populateFlagBasedForm('mount', config.mountConfig || {});
      this.populateFlagBasedForm('copy', config.copyConfig || {});
      this.populateFlagBasedForm('sync', config.syncConfig || {});
      this.populateFlagBasedForm('bisync', config.bisyncConfig || {});
      this.populateFlagBasedForm('move', config.moveConfig || {});
      this.populateFlagForm('filter', config.filterConfig || {});
      this.populateFlagForm('vfs', config.vfsConfig || {});
      this.populateFlagForm('backend', config.backendConfig || {});
    } else {
      switch (this.editTarget) {
        case 'mount':
        case 'copy':
        case 'sync':
        case 'bisync':
        case 'move':
          this.populateFlagBasedForm(this.editTarget, config);
          break;
        case 'filter':
        case 'vfs':
        case 'backend':
          this.populateFlagForm(this.editTarget, config);
          break;
      }
    }
  }

  private async populateRemoteForm(config: any): Promise<void> {
    this.remoteForm.patchValue({
      name: config.name,
      type: config.type,
    });
    await this.onRemoteTypeChange();
    // Use patchValue for dynamic fields
    this.remoteForm.patchValue(config);
  }

  private populateFlagBasedForm(flagType: FlagType, config: any): void {
    // Ensure config is a valid object to prevent errors on null/undefined data.
    if (!config) {
      config = {};
    }

    // Set a default source path if one isn't provided in the config.
    let source = config.source || '';
    if (!source || source.trim() === '') {
      source = `${this.getRemoteName()}:/`;
    }

    // 1. Prepare an object for the static fields common to most types.
    const baseConfig = {
      autoStart: config.autoStart ?? false,
      source: source,
      dest: config.dest || '',
    };

    // 2. Prepare an object for static fields specific to certain flag types.
    let specificConfig = {};
    switch (flagType) {
      case 'mount':
        specificConfig = {
          type: config.type || '',
        };
        break;
      case 'copy':
      case 'sync':
        specificConfig = {
          createEmptySrcDirs: config.createEmptySrcDirs ?? false,
        };
        break;
      case 'move':
        specificConfig = {
          createEmptySrcDirs: config.createEmptySrcDirs ?? false,
          deleteEmptySrcDirs: config.deleteEmptySrcDirs ?? false,
        };
        break;
      case 'bisync':
        specificConfig = {
          dryRun: config.dryRun ?? false,
          resync: config.resync ?? false,
          checkAccess: config.checkAccess ?? false,
          checkFilename: config.checkFilename || '',
          maxDelete: config.maxDelete ?? null,
          force: config.force ?? false,
          checkSync: config.checkSync ?? false,
          createEmptySrcDirs: config.createEmptySrcDirs ?? false,
          removeEmptyDirs: config.removeEmptyDirs ?? false,
          filtersFile: config.filtersFile || '',
          ignoreListingChecksum: config.ignoreListingChecksum ?? false,
          resilient: config.resilient ?? false,
          workdir: config.workdir || '',
          backupdir1: config.backupdir1 || '',
          backupdir2: config.backupdir2 || '',
          noCleanup: config.noCleanup ?? false,
        };
        break;
    }

    // 3. Combine the static configs and patch them into the parent form group.
    const staticConfigToPatch = {
      ...baseConfig,
      ...specificConfig,
    };
    this.remoteConfigForm.get(`${flagType}Config`)?.patchValue(staticConfigToPatch);

    // 4. Patch the dynamic flag options into the nested 'options' form group.
    const optionsGroup = this.remoteConfigForm.get(`${flagType}Config.options`);
    if (optionsGroup && config.options) {
      optionsGroup.patchValue(config.options);
    }
  }

  private populateFlagForm(flagType: FlagType, config: any): void {
    const optionsGroup = this.remoteConfigForm.get(`${flagType}Config.options`);
    if (optionsGroup) {
      optionsGroup.patchValue(config || {});
    }
  }

  //#endregion

  //#region Form Submission Methods
  async onSubmit(): Promise<void> {
    if (this.isAuthInProgress) return;

    try {
      const result = this.editTarget ? await this.handleEditMode() : await this.handleCreateMode();

      if (result.success && !this.isAuthCancelled) {
        this.close();
      }
    } catch (error) {
      console.error('Error during submission:', error);
    } finally {
      this.authStateService.resetAuthState();
    }
  }

  // UPDATED: Removed specific logic for 'options'
  private setFormState(disabled: boolean): void {
    if (disabled) {
      this.remoteConfigForm.disable();
      this.remoteForm.disable();
    } else {
      // Only enable controls that should be editable
      if (this.editTarget === 'remote') {
        // In remote edit mode, keep 'name' and 'type' disabled
        Object.keys(this.remoteForm.controls).forEach(key => {
          if (['name', 'type'].includes(key)) {
            this.remoteForm.get(key)?.disable();
          } else {
            this.remoteForm.get(key)?.enable();
          }
        });
      } else {
        // In other modes, enable all controls
        this.remoteForm.enable();
      }
      this.remoteConfigForm.enable();
    }
  }

  private async handleEditMode(): Promise<{ success: boolean }> {
    const updatedConfig: any = {};
    const remoteName = this.getRemoteName();

    await this.authStateService.startAuth(remoteName, true);

    // Check if this is a remote edit with interactive mode
    if (this.editTarget === 'remote' && this.useInteractiveMode) {
      return await this.handleInteractiveRemoteEdit(updatedConfig);
    }

    await this.updateConfigBasedOnEditTarget(updatedConfig);
    await this.appSettingsService.saveRemoteSettings(remoteName, updatedConfig);

    return { success: true };
  }

  private async handleInteractiveRemoteEdit(updatedConfig: any): Promise<{ success: boolean }> {
    const remoteData = this.cleanFormData(this.remoteForm.getRawValue(), true, this.remoteForm);

    // Store the updated config for later use
    updatedConfig.name = remoteData.name;
    updatedConfig.type = remoteData.type;

    // Store config for finalization
    this.pendingFinalConfig = {
      ...updatedConfig,
      mountConfig: {} as MountConfig,
      copyConfig: {} as CopyConfig,
      syncConfig: {} as SyncConfig,
      bisyncConfig: {} as BisyncConfig,
      moveConfig: {} as MoveConfig,
      filterConfig: {} as FilterConfig,
      vfsConfig: {} as VfsConfig,
      backendConfig: {} as BackendConfig,
    };
    this.pendingRemoteData = remoteData;

    // Start interactive configuration for the remote
    const { name, type, ...paramRest } = remoteData;
    const startResp = await this.remoteManagementService.startRemoteConfigInteractive(
      name,
      type,
      paramRest,
      { nonInteractive: true }
    );

    if (!startResp || startResp.State === '') {
      return { success: true };
    }

    // Interactive steps needed
    this.isInteractiveActive = true;
    this.rcQuestion = startResp;
    this.rcAnswer = this.getDefaultAnswerFromQuestion(startResp);
    return { success: false };
  }

  private getRemoteName(): string {
    return this.data.name || this.remoteForm.get('name')?.value;
  }

  private async updateConfigBasedOnEditTarget(updatedConfig: any): Promise<void> {
    if (!this.editTarget) return;

    const updateHandlers = {
      remote: this.handleRemoteUpdate.bind(this),
      mount: this.handleMountUpdate.bind(this),
      bisync: this.handleBisyncUpdate.bind(this),
      move: this.handleMoveUpdate.bind(this),
      copy: this.handleCopyUpdate.bind(this),
      sync: this.handleSyncUpdate.bind(this),
      filter: this.handleFlagUpdate.bind(this),
      backend: this.handleFlagUpdate.bind(this),
      vfs: this.handleFlagUpdate.bind(this),
    } as const;

    if (updateHandlers[this.editTarget]) {
      await updateHandlers[this.editTarget](updatedConfig);
    }
  }

  // UPDATED: All submission logic now uses extractFlagOptions
  private async handleCreateMode(): Promise<{ success: boolean }> {
    const remoteData = this.cleanFormData(this.remoteForm.getRawValue());
    const configData = this.remoteConfigForm.getRawValue();

    const mountConfig = configData.mountConfig;
    const copyConfig = configData.copyConfig;
    const syncConfig = configData.syncConfig;
    const bisyncConfig = configData.bisyncConfig;
    const moveConfig = configData.moveConfig;

    const finalConfig = {
      mountConfig: {
        autoStart: mountConfig.autoStart,
        dest: mountConfig.dest,
        source: mountConfig.source || `${remoteData.name}:/`,
        type: mountConfig.type,
        options: this.cleanData(configData.mountConfig.options, this.dynamicRemoteFields),
      },
      copyConfig: {
        autoStart: copyConfig.autoStart,
        source: copyConfig.source || `${remoteData.name}:/`,
        dest: copyConfig.dest,
        createEmptySrcDirs: copyConfig.createEmptySrcDirs,
        options: this.cleanData(configData.copyConfig.options, this.dynamicRemoteFields),
      },
      syncConfig: {
        autoStart: syncConfig.autoStart,
        source: syncConfig.source || `${remoteData.name}:/`,
        dest: syncConfig.dest,
        createEmptySrcDirs: syncConfig.createEmptySrcDirs,
        options: this.cleanData(configData.syncConfig.options, this.dynamicRemoteFields),
      },
      bisyncConfig: {
        autoStart: bisyncConfig.autoStart,
        source: bisyncConfig.source || `${remoteData.name}:/`,
        dest: bisyncConfig.dest,
        dryRun: bisyncConfig.dryRun,
        resync: bisyncConfig.resync,
        checkAccess: bisyncConfig.checkAccess,
        checkFilename: bisyncConfig.checkFilename,
        maxDelete: bisyncConfig.maxDelete,
        force: bisyncConfig.force,
        checkSync: bisyncConfig.checkSync,
        createEmptySrcDirs: bisyncConfig.createEmptySrcDirs,
        removeEmptyDirs: bisyncConfig.removeEmptyDirs,
        filtersFile: bisyncConfig.filtersFile,
        ignoreListingChecksum: bisyncConfig.ignoreListingChecksum,
        resilient: bisyncConfig.resilient,
        workdir: bisyncConfig.workdir,
        backupdir1: bisyncConfig.backupdir1,
        backupdir2: bisyncConfig.backupdir2,
        noCleanup: bisyncConfig.noCleanup,
        options: this.cleanData(configData.bisyncConfig.options, this.dynamicRemoteFields),
      },
      moveConfig: {
        autoStart: moveConfig.autoStart,
        source: moveConfig.source || `${remoteData.name}:/`,
        dest: moveConfig.dest,
        createEmptySrcDirs: moveConfig.createEmptySrcDirs,
        deleteEmptySrcDirs: moveConfig.deleteEmptySrcDirs,
        options: this.cleanData(configData.moveConfig.options, this.dynamicRemoteFields),
      },
      filterConfig: {
        options: this.cleanData(configData.filterConfig.options, this.dynamicRemoteFields),
      },
      vfsConfig: {
        options: this.cleanData(configData.vfsConfig.options, this.dynamicRemoteFields),
      },
      backendConfig: {
        options: this.cleanData(configData.backendConfig.options, this.dynamicRemoteFields),
      },
    };

    const interactive = this.useInteractiveMode;
    await this.authStateService.startAuth(remoteData.name, false);
    if (!interactive) {
      // Simple path
      const toCreate = { ...remoteData } as Record<string, unknown>;
      await this.remoteManagementService.createRemote(remoteData.name, toCreate);
      this.pendingFinalConfig = finalConfig;
      this.pendingRemoteData = remoteData;
      await this.finalizeRemoteCreation();
      return { success: true };
    }

    // Interactive path
    this.pendingFinalConfig = finalConfig;
    this.pendingRemoteData = remoteData;

    const { name, type, ...paramRest } = remoteData;
    const startResp = await this.remoteManagementService.startRemoteConfigInteractive(
      name,
      type,
      paramRest,
      { nonInteractive: true }
    );

    if (!startResp || startResp.State === '') {
      await this.finalizeRemoteCreation();
      return { success: true };
    }
    this.isInteractiveActive = true;
    this.rcQuestion = startResp;
    this.rcAnswer = this.getDefaultAnswerFromQuestion(startResp);
    return { success: false };
  }

  private async handleRemoteUpdate(updatedConfig: any): Promise<void> {
    const remoteData = this.cleanFormData(this.remoteForm.getRawValue(), true, this.remoteForm);
    updatedConfig.name = remoteData.name;
    updatedConfig.type = remoteData.type;
    await this.remoteManagementService.updateRemote(remoteData.name, remoteData);
  }

  private async handleMountUpdate(updatedConfig: any): Promise<void> {
    const mountData = this.cleanFormData(this.remoteConfigForm.getRawValue().mountConfig);
    if (!mountData.source || mountData.source.trim() === '') {
      mountData.source = `${this.getRemoteName()}:/`;
    }
    console.log('mountData options after check:', mountData);

    updatedConfig.mountConfig = {
      autoStart: mountData.autoStart,
      dest: mountData.dest,
      source: mountData.source,
      type: mountData.type,
      options: this.cleanData(mountData.options, this.dynamicRemoteFields),
    };
  }

  private async handleBisyncUpdate(updatedConfig: any): Promise<void> {
    const bisyncData = this.remoteConfigForm.getRawValue().bisyncConfig;
    if (!bisyncData.source || bisyncData.source.trim() === '') {
      bisyncData.source = `${this.getRemoteName()}:/`;
    }
    updatedConfig.bisyncConfig = {
      autoStart: bisyncData.autoStart,
      source: bisyncData.source,
      dest: bisyncData.dest,
      dryRun: bisyncData.dryRun,
      resync: bisyncData.resync,
      checkAccess: bisyncData.checkAccess,
      checkFilename: bisyncData.checkFilename,
      maxDelete: bisyncData.maxDelete,
      force: bisyncData.force,
      checkSync: bisyncData.checkSync,
      createEmptySrcDirs: bisyncData.createEmptySrcDirs,
      removeEmptyDirs: bisyncData.removeEmptyDirs,
      filtersFile: bisyncData.filtersFile,
      ignoreListingChecksum: bisyncData.ignoreListingChecksum,
      resilient: bisyncData.resilient,
      workdir: bisyncData.workdir,
      backupdir1: bisyncData.backupdir1,
      backupdir2: bisyncData.backupdir2,
      noCleanup: bisyncData.noCleanup,
      options: this.cleanData(bisyncData.options, this.dynamicRemoteFields),
    };
  }

  private async handleMoveUpdate(updatedConfig: any): Promise<void> {
    const moveData = this.remoteConfigForm.getRawValue().moveConfig;
    if (!moveData.source || moveData.source.trim() === '') {
      moveData.source = `${this.getRemoteName()}:/`;
    }
    updatedConfig.moveConfig = {
      autoStart: moveData.autoStart,
      source: moveData.source,
      dest: moveData.dest,
      createEmptySrcDirs: moveData.createEmptySrcDirs,
      deleteEmptySrcDirs: moveData.deleteEmptySrcDirs,
      options: this.cleanData(moveData.options, this.dynamicRemoteFields),
    };
  }

  private async handleCopyUpdate(updatedConfig: any): Promise<void> {
    const copyData = this.remoteConfigForm.getRawValue().copyConfig;
    if (!copyData.source || copyData.source.trim() === '') {
      copyData.source = `${this.getRemoteName()}:/`;
    }
    updatedConfig.copyConfig = {
      autoStart: copyData.autoStart,
      source: copyData.source,
      dest: copyData.dest,
      createEmptySrcDirs: copyData.createEmptySrcDirs,
      options: this.cleanData(copyData.options, this.dynamicRemoteFields),
    };
  }

  private async handleSyncUpdate(updatedConfig: any): Promise<void> {
    const syncData = this.remoteConfigForm.getRawValue().syncConfig;
    if (!syncData.source || syncData.source.trim() === '') {
      syncData.source = `${this.getRemoteName()}:/`;
    }
    updatedConfig.syncConfig = {
      autoStart: syncData.autoStart,
      source: syncData.source,
      dest: syncData.dest,
      createEmptySrcDirs: syncData.createEmptySrcDirs,
      options: this.cleanData(syncData.options, this.dynamicRemoteFields),
    };
  }

  private async handleFlagUpdate(updatedConfig: any): Promise<void> {
    if (
      !this.editTarget ||
      !this.flagConfigService.FLAG_TYPES.includes(this.editTarget as FlagType)
    ) {
      return;
    }
    // Get the raw value of the specific config group (e.g., filterConfig)
    const flagData = this.remoteConfigForm.getRawValue()[`${this.editTarget}Config`];

    // Extract only the dynamic flags, removing any static keys (which shouldn't be there, but good to be safe)
    updatedConfig[`${this.editTarget}Config`] = this.cleanData(
      flagData.options,
      this.dynamicRemoteFields
    );
  }
  //#endregion

  //#region Utility Methods
  private validateRemoteNameFactory(): ValidatorFn {
    return this.validatorRegistry.createRemoteNameValidator(
      this.existingRemotes,
      REMOTE_NAME_REGEX
    );
  }

  private cleanFormData(formData: any, isEditMode = false, formControl?: FormGroup): any {
    return Object.entries(formData)
      .filter(([key, value]) => {
        // Always filter null, undefined
        if (value === null || value === undefined) {
          return false;
        }

        // Keep 0 or '0' if it's a number/string, but not if it's the default for a number type
        if (value === 0 || value === '0') {
          const field = this.dynamicRemoteFields.find(f => f.Name === key);
          if (field && ['int', 'int64', 'uint32', 'SizeSuffix'].includes(field.Type)) {
            // It's a number type, check if it's default
          } else {
            return true; // Keep '0' for string fields etc.
          }
        }

        // Keep empty strings as they might be intentional unsets
        if (value === '') {
          return true;
        }

        if (isEditMode && formControl) {
          const control = formControl.get(key);
          if (control && control.dirty) {
            return true;
          }
        }

        return true;
      })
      .reduce((acc, [key, value]) => ({ ...acc, [key]: value }), {});
  }

  private cleanData(formData: any, fieldDefinitions: RcConfigOption[]): any {
    const cleanedData: Record<string, unknown> = {};
    if (!fieldDefinitions || !formData) return cleanedData;

    for (const field of fieldDefinitions) {
      const key = field.Name;
      if (Object.prototype.hasOwnProperty.call(formData, key)) {
        const currentValue = formData[key];
        const defaultValue = field.Default;
        let isDefault = false;

        if (field.Type === 'bool') {
          isDefault = currentValue === (defaultValue === true);
        } else if (
          Array.isArray(defaultValue) &&
          Array.isArray(currentValue) &&
          currentValue.length === 0 &&
          defaultValue.length === 0
        ) {
          isDefault = true;
        } else {
          const isCurrentEmpty =
            currentValue === null || currentValue === undefined || currentValue === '';
          const isDefaultEmpty =
            defaultValue === null || defaultValue === undefined || defaultValue === '';
          if (isCurrentEmpty && isDefaultEmpty) {
            isDefault = true;
          } else {
            // Use string comparison as a general fallback, handles numbers/strings ok
            isDefault = String(currentValue) === String(defaultValue);
          }
        }
        if (!isDefault) cleanedData[key] = currentValue;
      }
    }
    return cleanedData;
  }

  //#endregion

  //#region UI Helper Methods
  selectLocalFolder(whichFormPath: string, requireEmpty: boolean): void {
    this.fileSystemService.selectFolder(requireEmpty).then(selectedPath => {
      this.remoteConfigForm.get(whichFormPath)?.setValue(selectedPath);
    });
  }

  private scrollToTop(): void {
    const modalContent = document.querySelector('.modal-content');
    if (modalContent) {
      modalContent.scrollTop = 0;
    }
  }

  nextStep(): void {
    if (this.currentStep >= this.TOTAL_STEPS) {
      return;
    }

    if (this.currentStep === 1 && !this.remoteForm.valid) {
      this.remoteForm.markAllAsTouched();
      return;
    }

    this.currentStep++;
    this.scrollToTop();
  }

  prevStep(): void {
    if (this.currentStep > 1) {
      this.currentStep--;
      this.scrollToTop();
    }
  }

  async cancelAuth(): Promise<void> {
    await this.authStateService.cancelAuth();
    this.isInteractiveActive = false;
    this.rcQuestion = null;
    this.rcAnswer = null;
  }

  @HostListener('document:keydown.escape', ['$event'])
  close(): void {
    this.dialogRef.close(false);
  }
  //#endregion

  // Add getters for Save button logic
  get isSaveDisabled(): boolean {
    if (this.isAuthInProgress) return true;

    if (this.editTarget) {
      if (this.editTarget === 'remote') {
        return !this.remoteForm.valid;
      }
      // In edit mode for flags, check the specific config group
      const configGroup = this.remoteConfigForm.get(`${this.editTarget}Config`);
      return !configGroup?.valid;
    }
    // In create mode, both must be valid
    return !this.remoteForm.valid || !this.remoteConfigForm.valid;
  }

  get saveButtonLabel(): string {
    if (this.isAuthInProgress && !this.isAuthCancelled) {
      return 'Saving...';
    }
    return this.editTarget ? 'Save Changes' : 'Save';
  }

  // Helpers for non-interactive flow
  private getDefaultAnswerFromQuestion(q: RcConfigQuestionResponse): string | boolean | number {
    const opt = q.Option;
    if (!opt) return '';
    if (opt.Type === 'bool') {
      if (typeof opt.Value === 'boolean') return opt.Value;
      if (opt.ValueStr !== undefined) return opt.ValueStr.toLowerCase() === 'true';
      if (opt.DefaultStr !== undefined) return opt.DefaultStr.toLowerCase() === 'true';
      if (typeof opt.Default === 'boolean') return opt.Default;
      return true;
    }
    if (opt.ValueStr !== undefined) return opt.ValueStr as unknown as string;
    if (opt.DefaultStr !== undefined) return opt.DefaultStr as unknown as string;
    if (opt.Default !== undefined) return String(opt.Default);
    if (opt.Examples && opt.Examples.length > 0) return opt.Examples[0].Value;
    return '';
  }

  async submitRcAnswer(): Promise<void> {
    if (!this.isInteractiveActive || !this.rcQuestion || !this.pendingRemoteData) return;
    try {
      const name = this.pendingRemoteData.name;
      const stateToken = this.rcQuestion.State;
      let result: unknown = this.rcAnswer;
      if (this.rcQuestion?.Option?.Type === 'bool') {
        if (typeof result === 'boolean') result = result ? 'true' : 'false';
        else if (typeof result === 'string')
          result = result.toLowerCase() === 'true' ? 'true' : 'false';
        else result = 'true';
      }

      const { ...paramRest } = this.pendingRemoteData;
      const resp = await this.remoteManagementService.continueRemoteConfigNonInteractive(
        name,
        stateToken,
        result as unknown,
        paramRest,
        { nonInteractive: true }
      );

      if (!resp || resp.State === '') {
        this.isInteractiveActive = false;
        this.rcQuestion = null;
        await this.finalizeRemoteCreation();
      } else {
        this.rcQuestion = resp;
        this.rcAnswer = this.getDefaultAnswerFromQuestion(resp);
      }
    } catch (e) {
      console.error('Failed to continue config:', e);
    }
  }

  async onInteractiveContinue(answer: string | number | boolean | null): Promise<void> {
    this.isProcessing = true;
    try {
      this.rcAnswer = answer;
      await this.submitRcAnswer();
    } finally {
      this.isProcessing = false;
    }
  }

  private async finalizeRemoteCreation(): Promise<void> {
    if (!this.pendingRemoteData || !this.pendingFinalConfig) return;
    const remoteData = this.pendingRemoteData;
    const finalConfig = this.pendingFinalConfig;

    if (this.editTarget === 'remote' && !this.useInteractiveMode) {
      await this.remoteManagementService.updateRemote(remoteData.name, remoteData);
    }

    await this.appSettingsService.saveRemoteSettings(remoteData.name, finalConfig);
    await this.remoteManagementService.getRemotes();
    this.authStateService.resetAuthState();

    if (finalConfig.mountConfig.autoStart && finalConfig.mountConfig.dest) {
      const mountPath = finalConfig.mountConfig.dest;
      const remoteName = remoteData.name;
      const source = finalConfig.mountConfig?.source;
      const mountType = finalConfig.mountConfig.type;
      const mountOptions = finalConfig.mountConfig.options;
      const vfs = finalConfig.vfsConfig;
      const filter = finalConfig.filterConfig;
      const backend = finalConfig.backendConfig;
      await this.mountManagementService.mountRemote(
        remoteName,
        source,
        mountPath,
        mountType,
        mountOptions,
        vfs,
        filter,
        backend
      );
    }

    if (finalConfig.copyConfig.autoStart && finalConfig.copyConfig.dest) {
      const copySource = finalConfig.copyConfig.source;
      const copyDest = finalConfig.copyConfig.dest;
      const createEmptySrcDirs = finalConfig.copyConfig.createEmptySrcDirs;
      const copyOptions = finalConfig.copyConfig.options;
      const filter = finalConfig.filterConfig;
      const backend = finalConfig.backendConfig;
      await this.jobManagementService.startCopy(
        remoteData.name,
        copySource,
        copyDest,
        createEmptySrcDirs,
        copyOptions,
        filter,
        backend
      );
    }
    if (finalConfig.syncConfig.autoStart && finalConfig.syncConfig.dest) {
      const syncSource = finalConfig.syncConfig.source;
      const syncDest = finalConfig.syncConfig.dest;
      const createEmptySrcDirs = finalConfig.syncConfig.createEmptySrcDirs;
      const syncOptions = finalConfig.syncConfig.options;
      const filter = finalConfig.filterConfig;
      const backend = finalConfig.backendConfig;
      await this.jobManagementService.startSync(
        remoteData.name,
        syncSource,
        syncDest,
        createEmptySrcDirs,
        syncOptions,
        filter,
        backend
      );
    }
    if (finalConfig.bisyncConfig.autoStart && finalConfig.bisyncConfig.dest) {
      const bisyncSource = finalConfig.bisyncConfig.source;
      const bisyncDest = finalConfig.bisyncConfig.dest;
      const bisyncOptions = finalConfig.bisyncConfig.options;
      const filter = finalConfig.filterConfig;
      const backend = finalConfig.backendConfig;
      await this.jobManagementService.startBisync(
        remoteData.name,
        bisyncSource,
        bisyncDest,
        bisyncOptions,
        filter,
        backend
      );
    }
    if (finalConfig.moveConfig.autoStart && finalConfig.moveConfig.dest) {
      const moveSource = finalConfig.moveConfig.source;
      const moveDest = finalConfig.moveConfig.dest;
      const deleteEmptySrcDirs = finalConfig.moveConfig.deleteEmptySrcDirs;
      const createEmptySrcDirs = finalConfig.moveConfig.createEmptySrcDirs;
      const moveOptions = finalConfig.moveConfig.options;
      const filter = finalConfig.filterConfig;
      const backend = finalConfig.backendConfig;
      await this.jobManagementService.startMove(
        remoteData.name,
        moveSource,
        moveDest,
        createEmptySrcDirs,
        deleteEmptySrcDirs,
        moveOptions,
        filter,
        backend
      );
    }
    this.close();
  }

  private async fetchInitialPathEntriesForEditMode(): Promise<void> {
    const pathEditTargets: string[] = ['mount', 'copy', 'sync', 'bisync', 'move'];

    // Check if the current editTarget is one we care about
    if (this.editTarget && pathEditTargets.includes(this.editTarget)) {
      // 1. Construct the dynamic form path (e.g., "mountConfig.source")
      const formPath = `${this.editTarget}Config.source`;

      // 2. Get the remote name
      const remoteName = this.data?.name ?? '';

      // 3. Get the existing source path from the data
      const existingSource =
        typeof this.data?.existingConfig?.['source'] === 'string'
          ? this.data.existingConfig['source']
          : '';

      // 4. Call the service with the dynamic and static values
      await this.pathSelectionService.fetchEntriesForField(formPath, remoteName, existingSource);
    }
  }
}
