import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  HostListener,
  inject,
  OnDestroy,
  OnInit,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, FormGroup, ValidatorFn, Validators, FormControl } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { debounceTime, distinctUntilChanged, Subject, takeUntil } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { RemoteConfigStepComponent } from '../../../../shared/remote-config/remote-config-step/remote-config-step.component';
import { FlagConfigStepComponent } from '../../../../shared/remote-config/flag-config-step/flag-config-step.component';
import { RcConfigQuestionResponse } from '@app/services';
import { AnimationsService } from '../../../../shared/services/animations.service';
import { AuthStateService } from '../../../../shared/services/auth-state.service';
import { ValidatorRegistryService } from '../../../../shared/services/validator-registry.service';
import {
  FlagConfigService,
  PathSelectionService,
  RemoteManagementService,
  JobManagementService,
  MountManagementService,
  AppSettingsService,
  FileSystemService,
} from '@app/services';
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
  EditTarget,
  FlagType,
  RemoteType,
  REMOTE_NAME_REGEX,
} from '@app/types';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { InteractiveConfigStepComponent } from 'src/app/shared/remote-config/interactive-config-step/interactive-config-step.component';

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

interface ConfigSpec {
  flagType: FlagType;
  formPath: string;
  staticFields: string[];
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
  changeDetection: ChangeDetectionStrategy.OnPush,
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
  private readonly cdRef = inject(ChangeDetectorRef);
  readonly flagConfigService = inject(FlagConfigService);
  readonly pathSelectionService = inject(PathSelectionService);

  private destroy$ = new Subject<void>();

  // Configuration
  readonly TOTAL_STEPS = 9;
  readonly stepLabels = [
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

  // Forms
  remoteForm!: FormGroup;
  remoteConfigForm!: FormGroup;

  // State
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

  editTarget: EditTarget = null;
  cloneTarget = false;
  restrictMode = false;
  useInteractiveMode = false;

  isRemoteConfigLoading = false;
  isAuthInProgress = false;
  isAuthCancelled = false;
  currentStep = 1;

  interactiveFlowState: InteractiveFlowState = {
    isActive: false,
    question: null,
    answer: null,
    isProcessing: false,
  };

  private pendingConfig: { remoteData: any; finalConfig: FinalConfig } | null = null;
  private changedRemoteFields = new Set<string>();

  // Config specifications for each flag type
  private readonly configSpecs: Record<FlagType, ConfigSpec> = {
    mount: {
      flagType: 'mount',
      formPath: 'mountConfig',
      staticFields: ['autoStart', 'dest', 'source', 'type'],
    },
    copy: {
      flagType: 'copy',
      formPath: 'copyConfig',
      staticFields: ['autoStart', 'source', 'dest', 'createEmptySrcDirs'],
    },
    sync: {
      flagType: 'sync',
      formPath: 'syncConfig',
      staticFields: ['autoStart', 'source', 'dest', 'createEmptySrcDirs'],
    },
    bisync: {
      flagType: 'bisync',
      formPath: 'bisyncConfig',
      staticFields: [
        'autoStart',
        'source',
        'dest',
        'dryRun',
        'resync',
        'checkAccess',
        'checkFilename',
        'maxDelete',
        'force',
        'checkSync',
        'createEmptySrcDirs',
        'removeEmptyDirs',
        'filtersFile',
        'ignoreListingChecksum',
        'resilient',
        'workdir',
        'backupdir1',
        'backupdir2',
        'noCleanup',
      ],
    },
    move: {
      flagType: 'move',
      formPath: 'moveConfig',
      staticFields: ['autoStart', 'source', 'dest', 'createEmptySrcDirs', 'deleteEmptySrcDirs'],
    },
    filter: { flagType: 'filter', formPath: 'filterConfig', staticFields: [] },
    vfs: { flagType: 'vfs', formPath: 'vfsConfig', staticFields: [] },
    backend: { flagType: 'backend', formPath: 'backendConfig', staticFields: [] },
  };

  constructor() {
    this.editTarget = this.dialogData?.editTarget || null;
    this.cloneTarget = this.dialogData?.cloneTarget || false;
    this.restrictMode = this.dialogData?.restrictMode;
    this.remoteForm = this.createRemoteForm();
    this.remoteConfigForm = this.createRemoteConfigForm();
  }

  async ngOnInit(): Promise<void> {
    await this.loadExistingRemotes();
    await this.loadRemoteTypes();
    await this.loadAllFlagFields();
    this.populateFormIfEditingOrCloning();
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
      mountConfig: this.createConfigGroup(['autoStart', 'dest', 'source', 'type']),
      copyConfig: this.createConfigGroup(['autoStart', 'source', 'dest', 'createEmptySrcDirs']),
      syncConfig: this.createConfigGroup(['autoStart', 'source', 'dest', 'createEmptySrcDirs']),
      bisyncConfig: this.createConfigGroup([
        'autoStart',
        'source',
        'dest',
        'dryRun',
        'resync',
        'checkAccess',
        'checkFilename',
        'maxDelete',
        'force',
        'checkSync',
        'createEmptySrcDirs',
        'removeEmptyDirs',
        'filtersFile',
        'ignoreListingChecksum',
        'resilient',
        'workdir',
        'backupdir1',
        'backupdir2',
        'noCleanup',
      ]),
      moveConfig: this.createConfigGroup([
        'autoStart',
        'source',
        'dest',
        'createEmptySrcDirs',
        'deleteEmptySrcDirs',
      ]),
      filterConfig: this.createConfigGroup([]),
      vfsConfig: this.createConfigGroup([]),
      backendConfig: this.createConfigGroup([]),
    });
  }

  private createConfigGroup(fields: string[]): FormGroup {
    const group: Record<string, any> = {};
    fields.forEach(field => {
      group[field] =
        field.includes('Empty') ||
        field.includes('Dirs') ||
        field === 'autoStart' ||
        field === 'dryRun' ||
        field === 'resync' ||
        field === 'checkAccess' ||
        field === 'force' ||
        field === 'checkSync' ||
        field === 'ignoreListingChecksum' ||
        field === 'resilient' ||
        field === 'noCleanup'
          ? [false]
          : [''];
    });
    group['options'] = this.fb.group({});
    return this.fb.group(group);
  }

  // ============================================================================
  // INITIALIZATION
  // ============================================================================
  private async loadExistingRemotes(): Promise<void> {
    try {
      this.existingRemotes = await this.remoteManagementService.getRemotes();
      this.refreshRemoteNameValidator();
    } catch (error) {
      console.error('Error loading remotes:', error);
    } finally {
      this.cdRef.markForCheck();
    }
  }

  private async loadRemoteTypes(): Promise<void> {
    try {
      const providers = await this.remoteManagementService.getRemoteTypes();
      this.remoteTypes = providers.map(p => ({ value: p.name, label: p.description }));
    } catch (error) {
      console.error('Error fetching remote types:', error);
    }
  }

  private async loadAllFlagFields(): Promise<void> {
    this.dynamicFlagFields = await this.flagConfigService.loadAllFlagFields();
    this.dynamicFlagFields.move = [...this.dynamicFlagFields.copy];
    this.dynamicFlagFields.bisync = [...this.dynamicFlagFields.copy];
    this.addDynamicFieldsToForm();
  }

  private addDynamicFieldsToForm(): void {
    this.flagConfigService.FLAG_TYPES.forEach(flagType => {
      const optionsGroup = this.remoteConfigForm.get(`${flagType}Config.options`) as FormGroup;
      if (optionsGroup && this.dynamicFlagFields[flagType]) {
        this.dynamicFlagFields[flagType].forEach(field => {
          const defaultValue = field.Value !== undefined ? field.Value : field.Default;
          optionsGroup.addControl(field.Name, new FormControl(defaultValue));
        });
      }
    });
  }

  private refreshRemoteNameValidator(): void {
    const nameCtrl = this.remoteForm?.get('name');
    if (nameCtrl) {
      nameCtrl.setValidators([Validators.required, this.validateRemoteNameFactory()]);
      nameCtrl.updateValueAndValidity({ onlySelf: true, emitEvent: false });
    }
  }

  // ============================================================================
  // FORM SETUP & LISTENERS
  // ============================================================================
  private setupFormListeners(): void {
    this.setupAutoStartValidators();
    this.setupPathSelectionListeners();
  }

  private setupAutoStartValidators(): void {
    const configs = [
      {
        autoStart: 'mountConfig.autoStart',
        dest: 'mountConfig.dest',
        validators: [
          Validators.required,
          this.validatorRegistry.getValidator('crossPlatformPath')!,
        ],
      },
      {
        autoStart: 'copyConfig.autoStart',
        dest: 'copyConfig.dest',
        validators: [Validators.required],
      },
      {
        autoStart: 'syncConfig.autoStart',
        dest: 'syncConfig.dest',
        validators: [Validators.required],
      },
      {
        autoStart: 'bisyncConfig.autoStart',
        dest: 'bisyncConfig.dest',
        validators: [Validators.required],
      },
      {
        autoStart: 'moveConfig.autoStart',
        dest: 'moveConfig.dest',
        validators: [Validators.required],
      },
    ];

    configs.forEach(({ autoStart, dest, validators }) => {
      this.remoteConfigForm
        .get(autoStart)
        ?.valueChanges.pipe(takeUntil(this.destroy$))
        .subscribe(enabled => {
          const ctrl = this.remoteConfigForm.get(dest);
          if (enabled) {
            ctrl?.setValidators(validators);
          } else {
            ctrl?.clearValidators();
          }
          ctrl?.updateValueAndValidity();
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
        .subscribe(value => this.pathSelectionService.onInputChanged(path, value ?? ''));
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
      this.cdRef.markForCheck();
    });
  }

  // ============================================================================
  // FORM POPULATION
  // ============================================================================
  private populateFormIfEditingOrCloning(): void {
    if (!this.dialogData?.existingConfig) return;

    if (this.editTarget === 'remote') {
      this.populateRemoteForm(this.dialogData.existingConfig);
    } else if (this.cloneTarget) {
      this.populateRemoteForm(this.dialogData.existingConfig['remoteSpecs']);
      this.FLAG_BASED_TYPES.forEach(t =>
        this.populateFlagForm(t, this.dialogData.existingConfig?.[`${t}Config`] || {})
      );
      this.FLAG_ONLY_TYPES.forEach(t =>
        this.populateFlagForm(t, this.dialogData.existingConfig?.[`${t}Config`] || {})
      );
    } else if (this.editTarget) {
      this.populateFlagForm(this.editTarget as FlagType, this.dialogData.existingConfig);
    }
  }

  private async populateRemoteForm(config: any): Promise<void> {
    this.remoteForm.patchValue({ name: config.name, type: config.type });
    await this.onRemoteTypeChange();
    this.remoteForm.patchValue(config);
  }

  private populateFlagForm(flagType: FlagType, config: any): void {
    config = config || {};
    const spec = this.configSpecs[flagType];
    if (!spec) return;

    const sourceDefault =
      config.source || (spec.staticFields.includes('source') ? `${this.getRemoteName()}:/` : '');
    const baseConfig: Record<string, any> = { source: sourceDefault };

    spec.staticFields.forEach(field => {
      if (
        field === 'autoStart' ||
        field.includes('Empty') ||
        field.includes('Dirs') ||
        field === 'dryRun' ||
        field === 'resync' ||
        field === 'checkAccess' ||
        field === 'force' ||
        field === 'checkSync' ||
        field === 'ignoreListingChecksum' ||
        field === 'resilient' ||
        field === 'noCleanup'
      ) {
        baseConfig[field] = config[field] ?? false;
      } else {
        baseConfig[field] = config[field] || '';
      }
    });

    this.remoteConfigForm.get(`${flagType}Config`)?.patchValue(baseConfig);

    const optionsGroup = this.remoteConfigForm.get(`${flagType}Config.options`);
    if (optionsGroup && this.dynamicFlagFields[flagType]) {
      const dynamicFieldNames = this.dynamicFlagFields[flagType].map(f => f.Name);
      const optionsToPopulate: Record<string, any> = {};
      dynamicFieldNames.forEach(fieldName => {
        if (fieldName in config) {
          optionsToPopulate[fieldName] = config[fieldName];
        }
      });
      optionsGroup.patchValue(optionsToPopulate);
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
      this.cdRef.markForCheck();
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

  onInteractiveModeToggled(useInteractiveMode: boolean): void {
    this.useInteractiveMode = useInteractiveMode;
  }

  // ============================================================================
  // PATH SELECTION
  // ============================================================================
  async onSourceOptionSelectedField(entryName: string, formPath: string): Promise<void> {
    await this.pathSelectionService.onPathSelected(
      formPath,
      entryName,
      this.remoteConfigForm.get(formPath)
    );
    this.cdRef.markForCheck();
  }

  async onDestOptionSelectedField(entryName: string, formPath: string): Promise<void> {
    await this.pathSelectionService.onPathSelected(
      formPath,
      entryName,
      this.remoteConfigForm.get(formPath)
    );
    this.cdRef.markForCheck();
  }

  async onRemoteSelectedField(remoteWithColon: string, formPath: string): Promise<void> {
    await this.pathSelectionService.onRemoteSelected(
      formPath,
      remoteWithColon,
      this.remoteConfigForm.get(formPath)
    );
  }

  resetRemoteSelectionField(formPath: string): void {
    this.pathSelectionService.resetPathSelection(formPath);
    this.remoteConfigForm.get(formPath)?.setValue('');
  }

  selectLocalFolder(formPath: string, requireEmpty: boolean): void {
    this.fileSystemService
      .selectFolder(requireEmpty)
      .then(path => this.remoteConfigForm.get(formPath)?.setValue(path));
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
  // FORM SUBMISSION
  // ============================================================================
  async onSubmit(): Promise<void> {
    if (this.isAuthInProgress) return;

    try {
      const result = this.editTarget ? await this.handleEditMode() : await this.handleCreateMode();
      if (result.success && !this.isAuthCancelled) this.close();
    } catch (error) {
      console.error('Submission error:', error);
    } finally {
      this.authStateService.resetAuthState();
    }
  }

  private async handleCreateMode(): Promise<{ success: boolean }> {
    const remoteData = this.cleanFormData(this.remoteForm.getRawValue());
    const finalConfig = this.buildFinalConfig(remoteData, this.remoteConfigForm.getRawValue());

    await this.authStateService.startAuth(remoteData.name, false);

    if (!this.useInteractiveMode) {
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
      const remoteData = this.cleanFormData(this.remoteForm.getRawValue());
      this.pendingConfig = { remoteData, finalConfig: this.createEmptyFinalConfig() };
      return await this.startInteractiveRemoteConfig(remoteData);
    }

    const updatedConfig = await this.buildUpdateConfig();
    await this.appSettingsService.saveRemoteSettings(remoteName, updatedConfig);
    return { success: true };
  }

  // ============================================================================
  // CONFIG BUILDING
  // ============================================================================
  private buildFinalConfig(remoteData: any, configData: any): FinalConfig {
    return {
      mountConfig: this.buildConfig('mount', remoteData, configData.mountConfig),
      copyConfig: this.buildConfig('copy', remoteData, configData.copyConfig),
      syncConfig: this.buildConfig('sync', remoteData, configData.syncConfig),
      bisyncConfig: this.buildConfig('bisync', remoteData, configData.bisyncConfig),
      moveConfig: this.buildConfig('move', remoteData, configData.moveConfig),
      filterConfig: this.buildConfig('filter', remoteData, configData.filterConfig),
      vfsConfig: this.buildConfig('vfs', remoteData, configData.vfsConfig),
      backendConfig: this.buildConfig('backend', remoteData, configData.backendConfig),
    };
  }

  private buildConfig(flagType: FlagType, remoteData: any, configData: any): any {
    const spec = this.configSpecs[flagType];
    const result: any = {};

    spec.staticFields.forEach(field => {
      if (field === 'source' && !configData[field]) {
        result[field] = configData[field] || `${remoteData.name}:/`;
      } else {
        result[field] = configData[field];
      }
    });

    Object.assign(result, this.cleanData(configData.options, this.dynamicFlagFields[flagType]));
    return result;
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

  private async buildUpdateConfig(): Promise<Record<string, any>> {
    const updatedConfig: Record<string, any> = {};

    if (this.editTarget === 'remote') {
      const remoteData = this.cleanFormData(this.remoteForm.getRawValue());
      updatedConfig['name'] = remoteData.name;
      updatedConfig['type'] = remoteData.type;
      await this.remoteManagementService.updateRemote(remoteData.name, remoteData);
    } else if (this.editTarget) {
      const flagData = this.remoteConfigForm.getRawValue()[`${this.editTarget}Config`];
      const remoteData = { name: this.getRemoteName() };

      updatedConfig[`${this.editTarget}Config`] = this.buildConfig(
        this.editTarget as FlagType,
        remoteData,
        flagData
      );
    }

    return updatedConfig;
  }

  onRemoteFieldChanged(fieldName: string, isChanged: boolean): void {
    if (isChanged) {
      this.changedRemoteFields.add(fieldName);
    } else {
      this.changedRemoteFields.delete(fieldName);
    }
  }

  // ============================================================================
  // DATA CLEANING
  // ============================================================================
  private cleanFormData(formData: any): any {
    // For remote form: only include changed fields (tracked by setting-control)
    const result: any = {
      name: formData.name, // Always include name
      type: formData.type, // Always include type
    };

    // Add only changed dynamic fields
    this.changedRemoteFields.forEach(fieldName => {
      if (fieldName !== 'name' && fieldName !== 'type' && formData[fieldName] !== undefined) {
        result[fieldName] = formData[fieldName];
      }
    });

    return result;
  }

  private cleanData(formData: any, fieldDefinitions: RcConfigOption[]): Record<string, unknown> {
    // Just collect non-null/undefined values - no default checking needed
    return fieldDefinitions.reduce(
      (acc, field) => {
        if (!Object.prototype.hasOwnProperty.call(formData, field.Name)) return acc;
        const value = formData[field.Name];

        // Only exclude truly empty values
        if (value !== null && value !== undefined && value !== '') {
          acc[field.Name] = value;
        }

        return acc;
      },
      {} as Record<string, unknown>
    );
  }

  // ============================================================================
  // INTERACTIVE FLOW
  // ============================================================================
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

  async submitRcAnswer(): Promise<void> {
    if (
      !this.interactiveFlowState.isActive ||
      !this.interactiveFlowState.question ||
      !this.pendingConfig
    )
      return;

    try {
      const { name, ...paramRest } = this.pendingConfig.remoteData;
      let answer: unknown = this.interactiveFlowState.answer;

      if (this.interactiveFlowState.question?.Option?.Type === 'bool') {
        answer =
          typeof answer === 'boolean'
            ? answer
              ? 'true'
              : 'false'
            : String(answer).toLowerCase() === 'true'
              ? 'true'
              : 'false';
      }

      const resp = await this.remoteManagementService.continueRemoteConfigNonInteractive(
        name,
        this.interactiveFlowState.question.State,
        answer,
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
      console.error('Interactive config error:', error);
    } finally {
      this.cdRef.markForCheck();
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

  handleInteractiveAnswerUpdate(newAnswer: string | number | boolean | null): void {
    if (this.interactiveFlowState.isActive) {
      this.interactiveFlowState.answer = newAnswer;
      this.cdRef.markForCheck();
    }
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

  async cancelAuth(): Promise<void> {
    await this.authStateService.cancelAuth();
    this.interactiveFlowState = {
      isActive: false,
      question: null,
      answer: null,
      isProcessing: false,
    };
    this.cdRef.markForCheck();
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
  // STEP NAVIGATION
  // ============================================================================
  getCurrentStepLabel(): string {
    if (this.currentStep === 1) return 'Remote Configuration';
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
      this.cdRef.markForCheck();
      this.scrollToTop();
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
    if (stepNumber < this.currentStep) return 'completed';
    if (stepNumber === this.currentStep) return 'current';
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

    const handlers: Record<string, () => void> = {
      ArrowRight: () => stepNumber < this.TOTAL_STEPS && this.goToStep(stepNumber + 1),
      ArrowLeft: () => stepNumber > 1 && this.goToStep(stepNumber - 1),
      Home: () => this.goToStep(1),
      End: () => this.goToStep(this.TOTAL_STEPS),
    };

    if (handlers[event.key]) {
      event.preventDefault();
      handlers[event.key]();
    }
  }

  nextStep(): void {
    if (this.currentStep >= this.TOTAL_STEPS) return;
    if (this.currentStep === 1 && !this.remoteForm.valid) {
      this.remoteForm.markAllAsTouched();
      return;
    }
    this.currentStep++;
    this.cdRef.markForCheck();
    this.scrollToTop();
  }

  prevStep(): void {
    if (this.currentStep > 1) {
      this.currentStep--;
      this.cdRef.markForCheck();
      this.scrollToTop();
    }
  }

  private scrollToTop(): void {
    document.querySelector('.modal-content')?.scrollTo(0, 0);
  }

  // ============================================================================
  // UTILITIES
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

  setFormState(disabled: boolean): void {
    if (disabled) {
      this.remoteForm.disable();
      this.remoteConfigForm.disable();
    } else {
      if (this.editTarget === 'remote') {
        Object.keys(this.remoteForm.controls).forEach(key => {
          this.remoteForm.get(key)?.[['name', 'type'].includes(key) ? 'disable' : 'enable']();
        });
      } else {
        this.remoteForm.enable();
      }
      this.remoteConfigForm.enable();
    }
    this.cdRef.markForCheck();
  }

  get isSaveDisabled(): boolean {
    if (this.isAuthInProgress) return true;
    if (this.editTarget) {
      if (this.editTarget === 'remote') return !this.remoteForm.valid;
      return !this.remoteConfigForm.get(`${this.editTarget}Config`)?.valid;
    }
    return !this.remoteForm.valid || !this.remoteConfigForm.valid;
  }

  get saveButtonLabel(): string {
    return this.isAuthInProgress && !this.isAuthCancelled
      ? 'Saving...'
      : this.editTarget
        ? 'Save Changes'
        : 'Save';
  }

  @HostListener('document:keydown.escape', ['$event'])
  close(): void {
    this.dialogRef.close(false);
  }
}
