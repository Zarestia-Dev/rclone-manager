import { Component, HostListener, inject, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, FormGroup, ValidatorFn, Validators, FormControl } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { debounceTime, distinctUntilChanged, Subject, takeUntil } from 'rxjs';
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

interface DialogData {
  editTarget?: EditTarget;
  cloneTarget?: boolean;
  existingConfig?: Record<string, unknown>;
  name?: string;
  restrictMode: boolean;
}

interface InteractiveFlowState {
  isActive: boolean;
  question: RcConfigQuestionResponse | null;
  answer: string | boolean | number | null;
  isProcessing: boolean;
}

interface RemoteData {
  name: string;
  type: string;
  [key: string]: unknown;
}

interface FinalConfig {
  mountConfig: MountConfig;
  copyConfig: CopyConfig;
  syncConfig: SyncConfig;
  bisyncConfig: BisyncConfig;
  moveConfig: MoveConfig;
  filterConfig: FilterConfig;
  vfsConfig: VfsConfig;
  backendConfig: BackendConfig;
}

interface PendingConfig {
  remoteData: RemoteData;
  finalConfig: FinalConfig;
}

interface AutoStartValidator {
  autoStartPath: string;
  destPath: string;
  validators: ValidatorFn[];
}

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
  // ============================================================================
  // DEPENDENCY INJECTION
  // ============================================================================
  private readonly fb = inject(FormBuilder);
  private readonly dialogRef = inject(MatDialogRef<RemoteConfigModalComponent>);
  private readonly authStateService = inject(AuthStateService);
  private readonly remoteManagementService = inject(RemoteManagementService);
  private readonly jobManagementService = inject(JobManagementService);
  private readonly mountManagementService = inject(MountManagementService);
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly fileSystemService = inject(FileSystemService);
  private readonly validatorRegistry = inject(ValidatorRegistryService);
  private readonly dialogData = inject(MAT_DIALOG_DATA) as DialogData;
  readonly flagConfigService = inject(FlagConfigService);
  readonly pathSelectionService = inject(PathSelectionService);

  // ============================================================================
  // LIFECYCLE MANAGEMENT
  // ============================================================================
  private destroy$ = new Subject<void>();

  // ============================================================================
  // CONFIGURATION CONSTANTS
  // ============================================================================
  readonly TOTAL_STEPS = 9;
  readonly stepLabels: string[] = [
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

  private readonly FLAG_BASED_TYPES: FlagType[] = ['mount', 'copy', 'sync', 'bisync', 'move'];
  private readonly FLAG_ONLY_TYPES: FlagType[] = ['filter', 'vfs', 'backend'];
  private readonly INTERACTIVE_REMOTES = ['iclouddrive', 'onedrive'];
  private readonly PATH_EDIT_TARGETS = ['mount', 'copy', 'sync', 'bisync', 'move'];

  // ============================================================================
  // FORM STATE
  // ============================================================================
  remoteForm!: FormGroup;
  remoteConfigForm!: FormGroup;

  // ============================================================================
  // CONFIGURATION STATE
  // ============================================================================
  remoteTypes: RemoteType[] = [];
  dynamicRemoteFields: RcConfigOption[] = [];
  existingRemotes: string[] = [];
  mountTypes: string[] = [];
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

  // ============================================================================
  // EDIT/CREATE MODE STATE
  // ============================================================================
  editTarget: EditTarget = null;
  cloneTarget = false;
  restrictMode = false;
  useInteractiveMode = false;

  // ============================================================================
  // LOADING & ASYNC STATE
  // ============================================================================
  isRemoteConfigLoading = false;
  isAuthInProgress = false;
  isAuthCancelled = false;

  // ============================================================================
  // INTERACTIVE FLOW STATE
  // ============================================================================
  interactiveFlowState: InteractiveFlowState = {
    isActive: false,
    question: null,
    answer: null,
    isProcessing: false,
  };

  private pendingConfig: PendingConfig | null = null;

  // ============================================================================
  // UI STATE
  // ============================================================================
  currentStep = 1;

  constructor() {
    this.initializeFromDialogData();
    this.createForms();
  }

  // ============================================================================
  // LIFECYCLE HOOKS
  // ============================================================================
  async ngOnInit(): Promise<void> {
    await this.initializeComponent();
    this.setupFormListeners();
    this.setupAuthStateListeners();
    this.mountTypes = await this.mountManagementService.getMountTypes();
    await this.fetchInitialPathEntriesForEditMode();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    this.authStateService.cancelAuth();
  }

  // ============================================================================
  // INITIALIZATION
  // ============================================================================
  private initializeFromDialogData(): void {
    this.editTarget = this.dialogData?.editTarget || null;
    this.cloneTarget = this.dialogData?.cloneTarget || false;
    this.restrictMode = this.dialogData?.restrictMode;
  }

  private createForms(): void {
    this.remoteForm = this.createRemoteForm();
    this.remoteConfigForm = this.createRemoteConfigForm();
  }

  private async initializeComponent(): Promise<void> {
    await this.loadExistingRemotes();
    await this.loadRemoteTypes();
    await this.loadAllFlagFields();
    this.populateFormIfEditingOrCloning();
    this.setupPathSelectionListeners();
  }

  private async loadRemoteTypes(): Promise<void> {
    this.remoteTypes = await this.getRemoteTypes();
  }

  private async loadAllFlagFields(): Promise<void> {
    this.dynamicFlagFields = await this.flagConfigService.loadAllFlagFields();
    this.dynamicFlagFields.move = [...this.dynamicFlagFields.copy];
    this.dynamicFlagFields.bisync = [...this.dynamicFlagFields.copy];
    this.addDynamicFieldsToForm();
  }

  private addDynamicFieldsToForm(): void {
    this.flagConfigService.FLAG_TYPES.forEach(flagType => {
      const optionsGroup = this.remoteConfigForm.get(`${flagType}Config`) as FormGroup;

      if (optionsGroup && this.dynamicFlagFields[flagType]) {
        this.dynamicFlagFields[flagType].forEach(field => {
          const defaultValue = field.Value !== undefined ? field.Value : field.Default;
          optionsGroup.addControl(field.Name, new FormControl(defaultValue));
        });
      }
    });
  }

  private populateFormIfEditingOrCloning(): void {
    if (this.dialogData?.existingConfig) {
      this.populateForm(this.dialogData.existingConfig);
    }
  }

  private async loadExistingRemotes(): Promise<void> {
    try {
      this.existingRemotes = await this.remoteManagementService.getRemotes();
      // Ensure the name control uses the up-to-date list for uniqueness checks
      this.refreshRemoteNameValidator();
    } catch (error) {
      console.error('Error loading existing remotes:', error);
    }
  }

  /**
   * Rebuilds the validator for the "name" control so it captures the current
   * list of existing remotes (the validator factory captures the array by
   * reference at creation time). Call this after existingRemotes is updated.
   */
  private refreshRemoteNameValidator(): void {
    const nameCtrl = this.remoteForm?.get('name');
    if (!nameCtrl) return;

    nameCtrl.setValidators([Validators.required, this.validateRemoteNameFactory()]);
    nameCtrl.updateValueAndValidity({ onlySelf: true, emitEvent: false });
  }

  // ============================================================================
  // FORM CREATION
  // ============================================================================
  private createRemoteForm(): FormGroup {
    const isEditMode = this.editTarget === 'remote' && !!this.dialogData?.existingConfig;
    return this.fb.group({
      name: [
        { value: '', disabled: isEditMode },
        [Validators.required, this.validateRemoteNameFactory()],
      ],
      type: [{ value: '', disabled: isEditMode }, [Validators.required]],
    });
  }

  private createRemoteConfigForm(): FormGroup {
    return this.fb.group({
      mountConfig: this.fb.group({
        autoStart: [false],
        dest: [''],
        source: [''],
        type: [''],
        options: {},
      }),
      copyConfig: this.fb.group({
        autoStart: [false],
        source: [''],
        dest: [''],
        createEmptySrcDirs: [false],
        options: {},
      }),
      syncConfig: this.fb.group({
        autoStart: [false],
        source: [''],
        dest: [''],
        createEmptySrcDirs: [false],
        options: {},
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
        options: {},
      }),
      moveConfig: this.fb.group({
        autoStart: [false],
        source: [''],
        dest: [''],
        createEmptySrcDirs: [false],
        deleteEmptySrcDirs: [false],
        options: {},
      }),
      filterConfig: this.fb.group({
        options: {},
      }),
      vfsConfig: this.fb.group({
        options: {},
      }),
      backendConfig: this.fb.group({
        options: {},
      }),
    });
  }

  // ============================================================================
  // FORM LISTENERS SETUP
  // ============================================================================
  private setupFormListeners(): void {
    this.setupAutoStartValidators();
  }

  private setupAutoStartValidators(): void {
    const autoStartConfigs: AutoStartValidator[] = [
      {
        autoStartPath: 'mountConfig.autoStart',
        destPath: 'mountConfig.dest',
        validators: [
          Validators.required,
          this.validatorRegistry.getValidator('crossPlatformPath')!,
        ],
      },
      {
        autoStartPath: 'copyConfig.autoStart',
        destPath: 'copyConfig.dest',
        validators: [Validators.required],
      },
      {
        autoStartPath: 'syncConfig.autoStart',
        destPath: 'syncConfig.dest',
        validators: [Validators.required],
      },
      {
        autoStartPath: 'bisyncConfig.autoStart',
        destPath: 'bisyncConfig.dest',
        validators: [Validators.required],
      },
      {
        autoStartPath: 'moveConfig.autoStart',
        destPath: 'moveConfig.dest',
        validators: [Validators.required],
      },
    ];

    autoStartConfigs.forEach(config => {
      this.remoteConfigForm
        .get(config.autoStartPath)
        ?.valueChanges.pipe(takeUntil(this.destroy$))
        .subscribe(enabled => {
          const destCtrl = this.remoteConfigForm.get(config.destPath);
          if (enabled) {
            destCtrl?.setValidators(config.validators);
          } else {
            destCtrl?.clearValidators();
          }
          destCtrl?.updateValueAndValidity();
        });
    });
  }

  private setupPathSelectionListeners(): void {
    const pathConfigs = [
      'mountConfig.source',
      'copyConfig.source',
      'copyConfig.dest',
      'syncConfig.source',
      'syncConfig.dest',
      'bisyncConfig.dest',
      'moveConfig.dest',
    ];

    pathConfigs.forEach(path => {
      this.remoteConfigForm
        .get(path)
        ?.valueChanges.pipe(debounceTime(300), distinctUntilChanged(), takeUntil(this.destroy$))
        .subscribe(value => {
          this.pathSelectionService.onInputChanged(path, value ?? '');
        });
    });
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
    });
  }

  // ============================================================================
  // FORM POPULATION
  // ============================================================================
  private populateForm(config: any): void {
    if (!this.editTarget && !this.cloneTarget) return;

    if (this.editTarget === 'remote') {
      this.populateRemoteForm(config);
    } else if (this.cloneTarget) {
      this.populateRemoteForm(config.remoteSpecs);
      this.populateFlagBasedConfigs(config);
      this.populateFlagOnlyConfigs(config);
    } else {
      this.populateByEditTarget(config);
    }
  }

  private async populateRemoteForm(config: any): Promise<void> {
    this.remoteForm.patchValue({
      name: config.name,
      type: config.type,
    });
    await this.onRemoteTypeChange();
    this.remoteForm.patchValue(config);
  }

  private populateFlagBasedConfigs(config: any): void {
    this.FLAG_BASED_TYPES.forEach(flagType => {
      this.populateFlagBasedForm(flagType, config[`${flagType}Config`] || {});
    });
  }

  private populateFlagOnlyConfigs(config: any): void {
    this.FLAG_ONLY_TYPES.forEach(flagType => {
      this.populateFlagForm(flagType, config[`${flagType}Config`] || {});
    });
  }

  private populateByEditTarget(config: any): void {
    if (this.editTarget && (this.FLAG_BASED_TYPES as string[]).includes(this.editTarget)) {
      this.populateFlagBasedForm(this.editTarget as FlagType, config);
    } else if (this.editTarget && (this.FLAG_ONLY_TYPES as string[]).includes(this.editTarget)) {
      this.populateFlagForm(this.editTarget as FlagType, config);
    }
  }

  private populateFlagBasedForm(flagType: FlagType, config: any): void {
    config = config || {};

    let source = config.source || '';
    if (!source || source.trim() === '') {
      source = `${this.getRemoteName()}:/`;
    }

    const baseConfig = {
      autoStart: config.autoStart ?? false,
      source,
      dest: config.dest || '',
    };

    const specificConfig = this.getSpecificFlagConfig(flagType, config);
    const staticConfigToPatch = { ...baseConfig, ...specificConfig };

    this.remoteConfigForm.get(`${flagType}Config`)?.patchValue(staticConfigToPatch);

    const optionsGroup = this.remoteConfigForm.get(`${flagType}Config`);
    if (optionsGroup && config.options) {
      optionsGroup.patchValue(config.options);
    }
  }

  private getSpecificFlagConfig(flagType: FlagType, config: any): Record<string, any> {
    const specificConfigs: Record<FlagType, Record<string, any>> = {
      mount: { type: config.type || '' },
      copy: { createEmptySrcDirs: config.createEmptySrcDirs ?? false },
      sync: { createEmptySrcDirs: config.createEmptySrcDirs ?? false },
      filter: {},
      vfs: {},
      backend: {},
      move: {
        createEmptySrcDirs: config.createEmptySrcDirs ?? false,
        deleteEmptySrcDirs: config.deleteEmptySrcDirs ?? false,
      },
      bisync: {
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
      },
    };
    return specificConfigs[flagType] || {};
  }

  private populateFlagForm(flagType: FlagType, config: any): void {
    const optionsGroup = this.remoteConfigForm.get(`${flagType}Config`);
    if (optionsGroup) {
      optionsGroup.patchValue(config || {});
    }
  }

  // ============================================================================
  // REMOTE TYPE MANAGEMENT
  // ============================================================================
  async onRemoteTypeChange(): Promise<void> {
    this.isRemoteConfigLoading = true;
    try {
      const remoteType = this.remoteForm.get('type')?.value;
      this.useInteractiveMode = this.INTERACTIVE_REMOTES.includes(remoteType?.toLowerCase());
      this.dynamicRemoteFields =
        await this.remoteManagementService.getRemoteConfigFields(remoteType);
      this.replaceDynamicFormControls();
    } catch (error) {
      console.error('Error loading remote config fields:', error);
    } finally {
      this.isRemoteConfigLoading = false;
    }
  }

  private replaceDynamicFormControls(): void {
    Object.keys(this.remoteForm.controls).forEach(key => {
      if (!['name', 'type'].includes(key)) {
        this.remoteForm.removeControl(key);
      }
    });

    this.dynamicRemoteFields.forEach(field => {
      this.remoteForm.addControl(field.Name, new FormControl(field.Value));
    });
  }

  private async getRemoteTypes(): Promise<RemoteType[]> {
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

  onInteractiveModeToggled(useInteractiveMode: boolean): void {
    this.useInteractiveMode = useInteractiveMode;
  }

  // ============================================================================
  // PATH SELECTION
  // ============================================================================
  async onSourceOptionSelectedField(entryName: string, formPath: string): Promise<void> {
    const control = this.remoteConfigForm.get(formPath);
    await this.pathSelectionService.onPathSelected(formPath, entryName, control);
  }

  async onDestOptionSelectedField(entryName: string, formPath: string): Promise<void> {
    const control = this.remoteConfigForm.get(formPath);
    await this.pathSelectionService.onPathSelected(formPath, entryName, control);
  }

  async onRemoteSelectedField(remoteWithColon: string, formPath: string): Promise<void> {
    const control = this.remoteConfigForm.get(formPath);
    await this.pathSelectionService.onRemoteSelected(formPath, remoteWithColon, control);
  }

  resetRemoteSelectionField(formPath: string): void {
    this.pathSelectionService.resetPathSelection(formPath);
    this.remoteConfigForm.get(formPath)?.setValue('');
  }

  selectLocalFolder(formPath: string, requireEmpty: boolean): void {
    this.fileSystemService.selectFolder(requireEmpty).then(selectedPath => {
      this.remoteConfigForm.get(formPath)?.setValue(selectedPath);
    });
  }

  private async fetchInitialPathEntriesForEditMode(): Promise<void> {
    if (this.editTarget && this.PATH_EDIT_TARGETS.includes(this.editTarget)) {
      const formPath = `${this.editTarget}Config.source`;
      const remoteName = this.dialogData?.name ?? '';
      const existingSource =
        typeof this.dialogData?.existingConfig?.['source'] === 'string'
          ? this.dialogData.existingConfig['source']
          : '';

      await this.pathSelectionService.fetchEntriesForField(formPath, remoteName, existingSource);
    }
  }

  // ============================================================================
  // FORM SUBMISSION & STATE MANAGEMENT
  // ============================================================================
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

  private async handleCreateMode(): Promise<{ success: boolean }> {
    const remoteData = this.cleanFormData(this.remoteForm.getRawValue());
    const configData = this.remoteConfigForm.getRawValue();
    const finalConfig = this.buildFinalConfig(remoteData, configData);

    const interactive = this.useInteractiveMode;
    await this.authStateService.startAuth(remoteData.name, false);

    if (!interactive) {
      await this.remoteManagementService.createRemote(remoteData.name, remoteData);
      this.pendingConfig = { remoteData, finalConfig };
      await this.finalizeRemoteCreation();
      return { success: true };
    }

    this.pendingConfig = { remoteData, finalConfig };
    return await this.startInteractiveRemoteConfig(remoteData);
  }

  private async handleEditMode(): Promise<{ success: boolean }> {
    const remoteName = this.getRemoteName();
    await this.authStateService.startAuth(remoteName, true);

    if (this.editTarget === 'remote' && this.useInteractiveMode) {
      return await this.handleInteractiveRemoteEdit();
    }

    const updatedConfig = await this.buildUpdateConfig();
    await this.appSettingsService.saveRemoteSettings(remoteName, updatedConfig);
    return { success: true };
  }

  private async handleInteractiveRemoteEdit(): Promise<{ success: boolean }> {
    const remoteData = this.cleanFormData(this.remoteForm.getRawValue(), true, this.remoteForm);

    this.pendingConfig = {
      remoteData,
      finalConfig: this.createEmptyFinalConfig(),
    };

    return await this.startInteractiveRemoteConfig(remoteData);
  }

  private async startInteractiveRemoteConfig(remoteData: any): Promise<{ success: boolean }> {
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

    this.interactiveFlowState = {
      isActive: true,
      question: startResp,
      answer: this.getDefaultAnswerFromQuestion(startResp),
      isProcessing: false,
    };

    return { success: false };
  }

  private setFormState(disabled: boolean): void {
    if (disabled) {
      this.remoteConfigForm.disable();
      this.remoteForm.disable();
    } else {
      if (this.editTarget === 'remote') {
        Object.keys(this.remoteForm.controls).forEach(key => {
          if (['name', 'type'].includes(key)) {
            this.remoteForm.get(key)?.disable();
          } else {
            this.remoteForm.get(key)?.enable();
          }
        });
      } else {
        this.remoteForm.enable();
      }
      this.remoteConfigForm.enable();
    }
  }

  private async buildUpdateConfig(): Promise<Record<string, any>> {
    const updatedConfig: Record<string, any> = {};

    const updateHandlers: Record<string, (config: any) => Promise<void>> = {
      remote: config => this.handleRemoteUpdate(config),
      mount: config => this.handleMountUpdate(config),
      bisync: config => this.handleBisyncUpdate(config),
      move: config => this.handleMoveUpdate(config),
      copy: config => this.handleCopyUpdate(config),
      sync: config => this.handleSyncUpdate(config),
      filter: config => this.handleFlagUpdate(config),
      backend: config => this.handleFlagUpdate(config),
      vfs: config => this.handleFlagUpdate(config),
    };

    if (this.editTarget && updateHandlers[this.editTarget]) {
      await updateHandlers[this.editTarget](updatedConfig);
    }

    return updatedConfig;
  }

  // ============================================================================
  // CONFIGURATION BUILDING
  // ============================================================================
  private buildFinalConfig(remoteData: any, configData: any): FinalConfig {
    return {
      mountConfig: this.buildMountConfig(remoteData, configData.mountConfig),
      copyConfig: this.buildCopyConfig(remoteData, configData.copyConfig),
      syncConfig: this.buildSyncConfig(remoteData, configData.syncConfig),
      bisyncConfig: this.buildBisyncConfig(remoteData, configData.bisyncConfig),
      moveConfig: this.buildMoveConfig(remoteData, configData.moveConfig),
      filterConfig: this.buildFilterConfig(configData.filterConfig),
      vfsConfig: this.buildVfsConfig(configData.vfsConfig),
      backendConfig: this.buildBackendConfig(configData.backendConfig),
    };
  }

  private createEmptyFinalConfig(): FinalConfig {
    return {
      mountConfig: {} as MountConfig,
      copyConfig: {} as CopyConfig,
      syncConfig: {} as SyncConfig,
      bisyncConfig: {} as BisyncConfig,
      moveConfig: {} as MoveConfig,
      filterConfig: {} as FilterConfig,
      vfsConfig: {} as VfsConfig,
      backendConfig: {} as BackendConfig,
    };
  }

  private buildMountConfig(remoteData: any, mountData: any): MountConfig {
    return {
      autoStart: mountData.autoStart || false,
      dest: mountData.dest || '',
      source: mountData.source || `${remoteData.name}:/`,
      type: mountData.type || '',
      options: this.cleanData(mountData.options, this.dynamicFlagFields.mount),
    };
  }

  private buildCopyConfig(remoteData: any, copyData: any): CopyConfig {
    return {
      autoStart: copyData.autoStart || false,
      source: copyData.source || `${remoteData.name}:/`,
      dest: copyData.dest || '',
      createEmptySrcDirs: copyData.createEmptySrcDirs || false,
      options: this.cleanData(copyData.options, this.dynamicFlagFields.copy),
    };
  }

  private buildSyncConfig(remoteData: any, syncData: any): SyncConfig {
    return {
      autoStart: syncData.autoStart || false,
      source: syncData.source || `${remoteData.name}:/`,
      dest: syncData.dest || '',
      createEmptySrcDirs: syncData.createEmptySrcDirs || false,
      options: this.cleanData(syncData.options, this.dynamicFlagFields.sync),
    };
  }

  private buildBisyncConfig(remoteData: any, bisyncData: any): BisyncConfig {
    return {
      autoStart: bisyncData.autoStart || false,
      source: bisyncData.source || `${remoteData.name}:/`,
      dest: bisyncData.dest || '',
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
      options: this.cleanData(bisyncData.options, this.dynamicFlagFields.bisync),
    };
  }

  private buildMoveConfig(remoteData: any, moveData: any): MoveConfig {
    return {
      autoStart: moveData.autoStart,
      source: moveData.source || `${remoteData.name}:/`,
      dest: moveData.dest,
      createEmptySrcDirs: moveData.createEmptySrcDirs,
      deleteEmptySrcDirs: moveData.deleteEmptySrcDirs,
      options: this.cleanData(moveData.options, this.dynamicFlagFields.move),
    };
  }

  private buildFilterConfig(filterData: any): FilterConfig {
    return {
      ...this.cleanData(filterData.options, this.dynamicFlagFields.filter),
    };
  }

  private buildVfsConfig(vfsData: any): VfsConfig {
    return {
      ...this.cleanData(vfsData.options, this.dynamicFlagFields.vfs),
    };
  }

  private buildBackendConfig(backendData: any): BackendConfig {
    return {
      ...this.cleanData(backendData.options, this.dynamicFlagFields.backend),
    };
  }

  // ============================================================================
  // UPDATE HANDLERS
  // ============================================================================
  private async handleRemoteUpdate(updatedConfig: any): Promise<void> {
    const remoteData = this.cleanFormData(this.remoteForm.getRawValue(), true, this.remoteForm);
    updatedConfig.name = remoteData.name;
    updatedConfig.type = remoteData.type;
    await this.remoteManagementService.updateRemote(remoteData.name, remoteData);
  }

  private async handleMountUpdate(updatedConfig: any): Promise<void> {
    const mountData = this.remoteConfigForm.getRawValue().mountConfig;
    if (!mountData.source || mountData.source.trim() === '') {
      mountData.source = `${this.getRemoteName()}:/`;
    }

    updatedConfig.mountConfig = {
      autoStart: mountData.autoStart,
      dest: mountData.dest,
      source: mountData.source,
      type: mountData.type,
      options: this.cleanData(mountData.options, this.dynamicFlagFields.mount),
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
      options: this.cleanData(copyData.options, this.dynamicFlagFields.copy),
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
      options: this.cleanData(syncData.options, this.dynamicFlagFields.sync),
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
      options: this.cleanData(bisyncData.options, this.dynamicFlagFields.bisync),
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
      options: this.cleanData(moveData.options, this.dynamicFlagFields.move),
    };
  }

  private async handleFlagUpdate(updatedConfig: any): Promise<void> {
    if (
      !this.editTarget ||
      !this.flagConfigService.FLAG_TYPES.includes(this.editTarget as FlagType)
    ) {
      return;
    }

    const flagData = this.remoteConfigForm.getRawValue()[`${this.editTarget}Config`];
    updatedConfig[`${this.editTarget}Config`] = this.cleanData(
      flagData.options,
      this.dynamicFlagFields[this.editTarget as FlagType]
    );
  }

  // ============================================================================
  // DATA CLEANING & VALIDATION
  // ============================================================================
  private cleanFormData(formData: any, isEditMode = false, formControl?: FormGroup): any {
    const staticRequiredFields =
      isEditMode && formControl === this.remoteForm ? ['name', 'type'] : [];

    return Object.entries(formData)
      .filter(([key, value]) => {
        // Always keep required static fields
        if (staticRequiredFields.includes(key)) {
          return true;
        }

        if (value === null || value === undefined) {
          return false;
        }

        if (isEditMode && formControl) {
          const control = formControl.get(key);
          if (control && !control.dirty) {
            return false;
          }
        }

        return true;
      })
      .reduce((acc, [key, value]) => ({ ...acc, [key]: value }), {});
  }

  private cleanData(formData: any, fieldDefinitions: RcConfigOption[]): Record<string, unknown> {
    const cleanedData: Record<string, unknown> = {};
    if (!fieldDefinitions || !formData) return cleanedData;

    for (const field of fieldDefinitions) {
      const key = field.Name;
      if (!Object.prototype.hasOwnProperty.call(formData, key)) {
        continue;
      }

      const currentValue = formData[key];

      if (this.isDefaultValue(currentValue, field)) {
        continue;
      }

      cleanedData[key] = currentValue;
    }

    console.log('Cleaned Data:', cleanedData);

    return cleanedData;
  }

  private isDefaultValue(currentValue: any, field: RcConfigOption): boolean {
    const fieldType = field.Type;
    const defaultValue = field.Default;
    const defaultStr = field.DefaultStr;

    if (fieldType === 'stringArray') {
      // null or undefined or empty array should be filtered (they're all "default")
      if (currentValue === null || currentValue === undefined) {
        return true;
      }
      if (Array.isArray(currentValue) && currentValue.length === 0) {
        return true;
      }
      // Compare to default if it's an array
      if (Array.isArray(defaultValue) && Array.isArray(currentValue)) {
        return (
          currentValue.length === defaultValue.length &&
          currentValue.every((v, i) => v === defaultValue[i])
        );
      }
      return false;
    }

    // Handle Tristate type (has complex Default object)
    if (fieldType === 'Tristate') {
      // Tristate default is {Value: boolean, Valid: boolean}
      // "unset" means use default
      if (currentValue === null || currentValue === undefined || currentValue === '') {
        return true;
      }
      // If it's "unset" or matches the default state, it's default
      if (currentValue === 'unset' || currentValue === defaultStr) {
        return true;
      }
      return false;
    }

    // Handle enum-like types (CacheMode, etc.)
    if (fieldType === 'CacheMode' || fieldType === 'Choice' || fieldType === 'HARD|SOFT|CAUTIOUS') {
      // Use DefaultStr for comparison with enum values
      if (defaultStr && currentValue === defaultStr) {
        return true;
      }
      if (currentValue === null || currentValue === undefined || currentValue === '') {
        return true;
      }
      return false;
    }

    // Handle boolean type
    if (fieldType === 'bool') {
      return currentValue === (defaultValue === true);
    }

    // Handle arrays
    if (Array.isArray(defaultValue) && Array.isArray(currentValue)) {
      return currentValue.length === 0 && defaultValue.length === 0;
    }

    // Handle empty values
    const isCurrentEmpty =
      currentValue === null || currentValue === undefined || currentValue === '';
    const isDefaultEmpty =
      defaultValue === null || defaultValue === undefined || defaultValue === '';

    if (isCurrentEmpty && isDefaultEmpty) {
      return true;
    }

    // For objects (like Tristate's Default), compare the Value property if it exists
    if (typeof defaultValue === 'object' && defaultValue !== null && 'Value' in defaultValue) {
      return currentValue === defaultValue.Value;
    }

    // Default: string comparison
    return String(currentValue) === String(defaultValue);
  }

  // ============================================================================
  // INTERACTIVE FLOW
  // ============================================================================
  async onInteractiveContinue(answer: string | number | boolean | null): Promise<void> {
    this.interactiveFlowState.isProcessing = true;
    try {
      this.interactiveFlowState.answer = answer;
      await this.submitRcAnswer();
    } finally {
      this.interactiveFlowState.isProcessing = false;
    }
  }

  async submitRcAnswer(): Promise<void> {
    if (
      !this.interactiveFlowState.isActive ||
      !this.interactiveFlowState.question ||
      !this.pendingConfig
    ) {
      return;
    }

    try {
      const { name, ...paramRest } = this.pendingConfig.remoteData;
      const stateToken = this.interactiveFlowState.question.State;
      let result: unknown = this.interactiveFlowState.answer;

      if (this.interactiveFlowState.question?.Option?.Type === 'bool') {
        result = this.normalizeBooleanAnswer(result);
      }

      const resp = await this.remoteManagementService.continueRemoteConfigNonInteractive(
        name,
        stateToken,
        result as unknown,
        paramRest,
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
      console.error('Failed to continue interactive config:', error);
    }
  }

  private normalizeBooleanAnswer(value: unknown): string {
    if (typeof value === 'boolean') {
      return value ? 'true' : 'false';
    }
    if (typeof value === 'string') {
      return value.toLowerCase() === 'true' ? 'true' : 'false';
    }
    return 'true';
  }

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

  async cancelAuth(): Promise<void> {
    await this.authStateService.cancelAuth();
    this.interactiveFlowState.isActive = false;
    this.interactiveFlowState.question = null;
    this.interactiveFlowState.answer = null;
  }

  private async finalizeRemoteCreation(): Promise<void> {
    if (!this.pendingConfig) return;

    const { remoteData, finalConfig } = this.pendingConfig;

    if (this.editTarget === 'remote' && !this.useInteractiveMode) {
      await this.remoteManagementService.updateRemote(remoteData.name, remoteData);
    }

    await this.appSettingsService.saveRemoteSettings(remoteData.name, finalConfig);
    await this.remoteManagementService.getRemotes();
    this.authStateService.resetAuthState();

    await this.triggerAutoStartJobs(remoteData.name, finalConfig);
    this.close();
  }

  private async triggerAutoStartJobs(remoteName: string, finalConfig: FinalConfig): Promise<void> {
    const {
      mountConfig,
      copyConfig,
      syncConfig,
      bisyncConfig,
      moveConfig,
      vfsConfig,
      filterConfig,
      backendConfig,
    } = finalConfig;

    if (mountConfig.autoStart && mountConfig.dest) {
      await this.mountManagementService.mountRemote(
        remoteName,
        mountConfig.source,
        mountConfig.dest,
        mountConfig.type,
        mountConfig.options,
        vfsConfig,
        filterConfig,
        backendConfig
      );
    }

    if (copyConfig.autoStart && copyConfig.dest) {
      await this.jobManagementService.startCopy(
        remoteName,
        copyConfig.source,
        copyConfig.dest,
        copyConfig.createEmptySrcDirs,
        copyConfig.options,
        filterConfig,
        backendConfig
      );
    }

    if (syncConfig.autoStart && syncConfig.dest) {
      await this.jobManagementService.startSync(
        remoteName,
        syncConfig.source,
        syncConfig.dest,
        syncConfig.createEmptySrcDirs,
        syncConfig.options,
        filterConfig,
        backendConfig
      );
    }

    if (bisyncConfig.autoStart && bisyncConfig.dest) {
      await this.jobManagementService.startBisync(
        remoteName,
        bisyncConfig.source,
        bisyncConfig.dest,
        bisyncConfig.options,
        filterConfig,
        backendConfig
      );
    }

    if (moveConfig.autoStart && moveConfig.dest) {
      await this.jobManagementService.startMove(
        remoteName,
        moveConfig.source,
        moveConfig.dest,
        moveConfig.createEmptySrcDirs,
        moveConfig.deleteEmptySrcDirs,
        moveConfig.options,
        filterConfig,
        backendConfig
      );
    }
  }

  // ============================================================================
  // STEP NAVIGATION (UI HELPERS)
  // ============================================================================
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

  goToStep(step: number): void {
    if (step >= 1 && step <= this.TOTAL_STEPS) {
      this.currentStep = step;
    }
  }

  getStepProgress(): { current: number; total: number; percentage: number } {
    return {
      current: this.currentStep,
      total: this.TOTAL_STEPS,
      percentage: Math.round((this.currentStep / this.TOTAL_STEPS) * 100),
    };
  }

  getStepState(stepNumber: number): 'completed' | 'current' | 'future' {
    if (stepNumber < this.currentStep) {
      return 'completed';
    }
    if (stepNumber === this.currentStep) {
      return 'current';
    }
    return 'future';
  }

  getStepIcon(stepIndex: number): string {
    const iconMap: Record<number, string> = {
      0: 'hard-drive',
      1: 'mount',
      2: 'copy',
      3: 'sync',
      4: 'right-left',
      5: 'move',
      6: 'filter',
      7: 'vfs',
      8: 'server',
    };
    return iconMap[stepIndex] || 'circle';
  }

  getStepProgressAriaLabel(): string {
    return `Step ${this.currentStep} of ${this.TOTAL_STEPS}: ${this.stepLabels[this.currentStep - 1]}`;
  }

  handleStepKeydown(event: KeyboardEvent, stepNumber: number): void {
    if (!this.editTarget) return;

    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        if (stepNumber < this.TOTAL_STEPS) this.goToStep(stepNumber + 1);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        if (stepNumber > 1) this.goToStep(stepNumber - 1);
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

  nextStep(): void {
    if (this.currentStep >= this.TOTAL_STEPS) return;

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

  private scrollToTop(): void {
    const modalContent = document.querySelector('.modal-content');
    if (modalContent) {
      modalContent.scrollTop = 0;
    }
  }

  // ============================================================================
  // UTILITY HELPERS
  // ============================================================================
  private getRemoteName(): string {
    return this.dialogData.name || this.remoteForm.get('name')?.value;
  }

  private validateRemoteNameFactory(): ValidatorFn {
    return this.validatorRegistry.createRemoteNameValidator(
      this.existingRemotes,
      REMOTE_NAME_REGEX
    );
  }

  // ============================================================================
  // COMPUTED PROPERTIES (FOR TEMPLATE)
  // ============================================================================
  get isSaveDisabled(): boolean {
    if (this.isAuthInProgress) return true;

    if (this.editTarget) {
      if (this.editTarget === 'remote') {
        return !this.remoteForm.valid;
      }
      const configGroup = this.remoteConfigForm.get(`${this.editTarget}Config`);
      return !configGroup?.valid;
    }

    return !this.remoteForm.valid || !this.remoteConfigForm.valid;
  }

  get saveButtonLabel(): string {
    if (this.isAuthInProgress && !this.isAuthCancelled) {
      return 'Saving...';
    }
    return this.editTarget ? 'Save Changes' : 'Save';
  }

  // ============================================================================
  // DIALOG CLOSE
  // ============================================================================
  @HostListener('document:keydown.escape', ['$event'])
  close(): void {
    this.dialogRef.close(false);
  }
}
