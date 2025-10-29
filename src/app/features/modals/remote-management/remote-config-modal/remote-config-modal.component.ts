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
import { FormBuilder, FormGroup, Validators, FormControl } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { Subject, takeUntil } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { RemoteConfigStepComponent } from '../../../../shared/remote-config/remote-config-step/remote-config-step.component';
import { FlagConfigStepComponent } from '../../../../shared/remote-config/flag-config-step/flag-config-step.component';
import { RcConfigQuestionResponse } from '@app/services';
import { AnimationsService } from '../../../../shared/services/animations.service';
import { AuthStateService } from '../../../../shared/services/auth-state.service';
import { ValidatorRegistryService } from '../../../../shared/services/validator-registry.service';
import {
  FlagConfigService,
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
  RemoteConfigSections,
  InteractiveFlowState,
  FLAG_TYPES,
  INTERACTIVE_REMOTES,
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
  animations: [AnimationsService.getAnimations(['slideAnimation', 'fadeInOut', 'labelSlideIn'])],
})
export class RemoteConfigModalComponent implements OnInit, OnDestroy {
  // ============================================================================
  // PROPERTIES
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
  private readonly dialogData = inject(MAT_DIALOG_DATA, { optional: true }) as DialogData; // Make injection optional
  private readonly cdRef = inject(ChangeDetectorRef);
  readonly flagConfigService = inject(FlagConfigService);

  private destroy$ = new Subject<void>();

  // Configuration
  readonly TOTAL_STEPS = 9;
  readonly FLAG_TYPES = FLAG_TYPES;
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

  private pendingConfig: { remoteData: any; finalConfig: RemoteConfigSections } | null = null;
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
  // ============================================================================
  // LIFECYCLE HOOKS
  // ============================================================================
  constructor() {
    this.editTarget = this.dialogData?.editTarget || null;
    this.cloneTarget = this.dialogData?.cloneTarget || false;
    this.restrictMode = this.dialogData?.restrictMode || false;
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
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    this.authStateService.cancelAuth();
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
    FLAG_TYPES.forEach(flagType => {
      const optionsGroup = this.remoteConfigForm.get(`${flagType}Config.options`) as FormGroup;
      if (optionsGroup && this.dynamicFlagFields[flagType]) {
        this.dynamicFlagFields[flagType].forEach(field => {
          const defaultValue = field.Value !== undefined ? field.Value : field.Default;
          optionsGroup.addControl(field.Name, new FormControl(defaultValue));
        });
      }
    });
  }

  // ============================================================================
  // FORM CREATION
  // ============================================================================
  private createRemoteForm(): FormGroup {
    const isEditMode = this.editTarget === 'remote' && !!this.dialogData?.existingConfig;

    return this.fb.group({
      name: [
        { value: '', disabled: isEditMode && !this.cloneTarget }, // Allow edit on clone
        [
          Validators.required,
          this.validatorRegistry.createRemoteNameValidator(this.existingRemotes),
        ],
      ],
      type: [{ value: '', disabled: isEditMode && !this.cloneTarget }, [Validators.required]], // Allow edit on clone
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
    // Add pathType controls for relevant groups
    if (fields.includes('source')) {
      group['source'] = this.fb.group({
        pathType: ['currentRemote'],
        path: [''],
        otherRemoteName: [''],
      });
    }
    if (fields.includes('dest') && !fields.includes('type')) {
      // 'type' check excludes mount
      group['dest'] = this.fb.group({
        pathType: ['local'],
        path: [''],
        otherRemoteName: [''],
      });
    } else if (fields.includes('dest') && fields.includes('type')) {
      // This is mount, 'dest' is a simple control
      group['dest'] = [''];
    }

    group['options'] = this.fb.group({});
    return this.fb.group(group);
  }

  private refreshRemoteNameValidator(): void {
    const nameCtrl = this.remoteForm?.get('name');
    if (nameCtrl) {
      nameCtrl.setValidators([
        Validators.required,
        this.validatorRegistry.createRemoteNameValidator(this.existingRemotes),
      ]);
      nameCtrl.updateValueAndValidity({ onlySelf: true, emitEvent: false });
    }
  }

  // ============================================================================
  // FORM SETUP & LISTENERS
  // ============================================================================
  private setupFormListeners(): void {
    this.setupAutoStartValidators();
  }

  private setupAutoStartValidators(): void {
    const configs: {
      configName: string;
      opName: FlagType;
      isMount: boolean;
    }[] = [
      { configName: 'mountConfig', opName: 'mount', isMount: true },
      { configName: 'copyConfig', opName: 'copy', isMount: false },
      { configName: 'syncConfig', opName: 'sync', isMount: false },
      { configName: 'bisyncConfig', opName: 'bisync', isMount: false },
      { configName: 'moveConfig', opName: 'move', isMount: false },
    ];

    // *** FIX: Removed unused 'opName' from the destructuring ***
    configs.forEach(({ configName, isMount }) => {
      const opGroup = this.remoteConfigForm.get(configName);
      if (!opGroup) return;

      if (isMount) {
        // Mount logic is simple: dest is always required if autoStart is on
        const autoStartControl = opGroup.get('autoStart');
        const destControl = opGroup.get('dest');
        autoStartControl?.valueChanges.pipe(takeUntil(this.destroy$)).subscribe(enabled => {
          if (enabled) {
            destControl?.setValidators([
              Validators.required,
              this.validatorRegistry.getValidator('crossPlatformPath')!,
            ]);
          } else {
            destControl?.clearValidators();
          }
          destControl?.updateValueAndValidity();
        });
      } else {
        // Logic for sync, copy, etc.
        const sourcePathControl = opGroup.get('source.path');
        const destPathControl = opGroup.get('dest.path');

        // Apply custom validators
        sourcePathControl?.setValidators(this.validatorRegistry.requiredIfLocal());
        destPathControl?.setValidators(this.validatorRegistry.requiredIfLocal());

        // Re-validate when dependencies change
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

    if (this.editTarget === 'remote' || this.cloneTarget) {
      const remoteSpecs = this.cloneTarget
        ? this.dialogData.existingConfig['remoteSpecs']
        : this.dialogData.existingConfig;
      this.populateRemoteForm(remoteSpecs);

      if (this.cloneTarget) {
        // If cloning, also populate flag forms
        this.FLAG_BASED_TYPES.forEach(t =>
          this.populateFlagForm(t, this.dialogData.existingConfig?.[`${t}Config`] || {})
        );
        this.FLAG_ONLY_TYPES.forEach(t =>
          this.populateFlagForm(t, this.dialogData.existingConfig?.[`${t}Config`] || {})
        );
      }
    } else if (this.editTarget) {
      this.populateFlagForm(this.editTarget as FlagType, this.dialogData.existingConfig);
    }

    if (this.cloneTarget) {
      this.generateNewCloneName();
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

    const baseConfig: Record<string, any> = {};

    spec.staticFields.forEach(field => {
      if (field === 'source' || field === 'dest') {
        // Handle path objects
        baseConfig[field] = this.parsePathString(
          config[field],
          field === 'source' ? 'currentRemote' : 'local',
          this.getRemoteName()
        );
      } else if (
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
      ) {
        baseConfig[field] = config[field] ?? false;
      } else {
        baseConfig[field] = config[field] || '';
      }
    });

    if (flagType === 'mount') {
      // Mount 'source' is a path group, but 'dest' is just a string
      baseConfig['source'] = this.parsePathString(
        config['source'],
        'currentRemote',
        this.getRemoteName()
      );
      baseConfig['dest'] = config['dest'] || '';
    }

    this.remoteConfigForm.get(spec.formPath)?.patchValue(baseConfig);

    const optionsGroup = this.remoteConfigForm.get(`${spec.formPath}.options`);
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

  // Helper to parse a path string (e.g., "myRemote:/path") into a form object
  private parsePathString(
    path: string,
    defaultType: 'local' | 'currentRemote',
    currentRemote: string
  ): object {
    if (!path) {
      return { pathType: defaultType, path: '', otherRemoteName: '' };
    }

    const parts = path.split(':/');
    if (parts.length > 1) {
      const remoteName = parts[0];
      const remotePath = parts.slice(1).join(':/') || ''; // Re-join if path had colons
      if (remoteName === currentRemote) {
        return { pathType: 'currentRemote', path: remotePath, otherRemoteName: '' };
      } else if (this.existingRemotes.includes(remoteName)) {
        // *** FIX: Correctly format 'otherRemote' value and set otherRemoteName ***
        return {
          pathType: 'otherRemote:' + remoteName,
          path: remotePath,
          otherRemoteName: remoteName,
        };
      }
    }

    // Assume local path if no remote prefix or prefix not in existing remotes
    return { pathType: 'local', path: path, otherRemoteName: '' };
  }

  // Helper to generate a new name for a cloned remote
  private generateNewCloneName(): void {
    const baseName = this.remoteForm.get('name')?.value;
    if (!baseName) return;

    let newName = `${baseName}-clone`;
    let counter = 1;
    while (this.existingRemotes.includes(newName)) {
      newName = `${baseName}-clone-${counter}`;
      counter++;
    }
    this.remoteForm.get('name')?.setValue(newName);
    this.refreshRemoteNameValidator();
  }

  // ============================================================================
  // STEP NAVIGATION
  // ============================================================================
  getCurrentStepLabel(): string {
    if (this.currentStep === 1) return 'Remote Configuration';
    const stepIndex = this.currentStep - 2;
    if (stepIndex >= 0 && stepIndex < FLAG_TYPES.length) {
      const type = FLAG_TYPES[stepIndex];
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
    return `Step ${this.currentStep} of ${this.TOTAL_STEPS}: ${
      this.stepLabels[this.currentStep - 1]
    }`;
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

  private scrollToTop(): void {
    document.querySelector('.modal-content')?.scrollTo(0, 0);
  }

  // ============================================================================
  // EVENT HANDLERS
  // ============================================================================

  // --- Remote Type / Interactive Mode ---
  async onRemoteTypeChange(): Promise<void> {
    this.isRemoteConfigLoading = true;
    try {
      const remoteType = this.remoteForm.get('type')?.value;
      this.useInteractiveMode = INTERACTIVE_REMOTES.includes(remoteType?.toLowerCase());
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

  selectLocalFolder(formPath: string, requireEmpty: boolean): void {
    this.fileSystemService
      .selectFolder(requireEmpty)
      .then(path => this.remoteConfigForm.get(formPath)?.setValue(path));
  }

  handleSourceFolderSelect(flagType: FlagType): void {
    const formPath =
      flagType === 'mount' ? 'mountConfig.source.path' : `${flagType}Config.source.path`;
    this.fileSystemService
      .selectFolder(false)
      .then(path => this.remoteConfigForm.get(formPath)?.setValue(path));
  }

  handleDestFolderSelect(flagType: FlagType): void {
    // Mount dest is a simple string, others are nested
    const formPath = flagType === 'mount' ? 'mountConfig.dest' : `${flagType}Config.dest.path`;
    // Mount dest folder should be empty
    const requireEmpty = flagType === 'mount';

    this.fileSystemService
      .selectFolder(requireEmpty)
      .then(path => this.remoteConfigForm.get(formPath)?.setValue(path));
  }

  // --- Field Change Tracking ---
  onRemoteFieldChanged(fieldName: string, isChanged: boolean): void {
    if (isChanged) {
      this.changedRemoteFields.add(fieldName);
    } else if (this.editTarget === 'remote') {
      if (this.changedRemoteFields.has(fieldName)) return;
      this.changedRemoteFields.add(fieldName);
    } else {
      this.changedRemoteFields.delete(fieldName);
    }
  }

  // --- Interactive Flow ---
  handleInteractiveAnswerUpdate(newAnswer: string | number | boolean | null): void {
    if (this.interactiveFlowState.isActive) {
      this.interactiveFlowState.answer = newAnswer;
      this.cdRef.markForCheck();
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

    if (this.editTarget === 'remote') {
      const remoteData = this.cleanFormData(this.remoteForm.getRawValue());
      await this.remoteManagementService.updateRemote(remoteData.name, remoteData);
      return { success: true };
    }

    const updatedConfig = await this.buildUpdateConfig();
    await this.appSettingsService.saveRemoteSettings(remoteName, updatedConfig);
    return { success: true };
  }

  // ============================================================================
  // CONFIG BUILDING
  // ============================================================================
  private buildFinalConfig(remoteData: any, configData: any): RemoteConfigSections {
    return {
      mountConfig: this.buildConfig('mount', remoteData, configData.mountConfig),
      copyConfig: this.buildConfig('copy', remoteData, configData.copyConfig),
      syncConfig: this.buildConfig('sync', remoteData, configData.syncConfig),
      bisyncConfig: this.buildConfig('bisync', remoteData, configData.bisyncConfig),
      moveConfig: this.buildConfig('move', remoteData, configData.moveConfig),
      filterConfig: this.buildConfig('filter', remoteData, configData.filterConfig),
      vfsConfig: this.buildConfig('vfs', remoteData, configData.vfsConfig),
      backendConfig: this.buildConfig('backend', remoteData, configData.backendConfig),
      showOnTray: true,
    };
  }

  // Helper to build a path string (e.g., "myRemote:/path") from a form object
  private buildPathString(pathGroup: any, currentRemoteName: string): string {
    if (pathGroup === null || pathGroup === undefined) return '';
    // Handle mount's simple string path for DEST
    if (typeof pathGroup === 'string') {
      return pathGroup; // This is for mountConfig.dest, which is a local path
    }

    const { pathType, path, otherRemoteName } = pathGroup;
    const p = path || '';

    if (typeof pathType === 'string' && pathType.startsWith('otherRemote:')) {
      const remote = otherRemoteName || pathType.split(':')[1];
      return `${remote}:/${p}`;
    }

    switch (pathType) {
      case 'local':
        return p;
      case 'currentRemote':
        return `${currentRemoteName}:/${p}`;
      default:
        return '';
    }
  }

  private buildConfig(flagType: FlagType, remoteData: any, configData: any): any {
    const spec = this.configSpecs[flagType];
    const result: any = {};

    spec.staticFields.forEach(field => {
      if (field === 'source' || field === 'dest') {
        // Build path string from path object
        result[field] = this.buildPathString(configData[field], remoteData.name);
      } else {
        result[field] = configData[field];
      }
    });

    // Pass flagType to cleanData
    Object.assign(result, this.cleanData(configData.options, this.dynamicFlagFields[flagType]));
    return result;
  }

  private createEmptyFinalConfig(): RemoteConfigSections {
    return {
      mountConfig: {} as MountConfig,
      copyConfig: {} as CopyConfig,
      syncConfig: {} as SyncConfig,
      bisyncConfig: {} as BisyncConfig,
      moveConfig: {} as MoveConfig,
      filterConfig: {} as FilterConfig,
      vfsConfig: {} as VfsConfig,
      backendConfig: {} as BackendConfig,
      showOnTray: true,
    };
  }

  private async buildUpdateConfig(): Promise<Record<string, any>> {
    const updatedConfig: Record<string, any> = {};

    if (this.editTarget && this.editTarget !== 'remote') {
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

  // ============================================================================
  // DATA CLEANING
  // ============================================================================
  private cleanFormData(formData: any): any {
    const result: any = {
      name: formData.name, // Always include name
      type: formData.type, // Always include type
    };

    this.dynamicRemoteFields.forEach(field => {
      // Skip if the field doesn't exist in the form data
      if (!Object.prototype.hasOwnProperty.call(formData, field.Name)) return;

      const value = formData[field.Name];
      const isEdited = this.changedRemoteFields.has(field.Name);

      if (this.editTarget === 'remote' && !this.cloneTarget) {
        // **EDIT MODE LOGIC:**
        if (isEdited) {
          result[field.Name] = value;
        }
      } else {
        // **CREATE or CLONE MODE LOGIC:**
        if (!this.isDefaultValue(value, field)) {
          result[field.Name] = value;
        }
      }
    });

    return result;
  }

  private cleanData(formData: any, fieldDefinitions: RcConfigOption[]): Record<string, unknown> {
    return fieldDefinitions.reduce(
      (acc, field) => {
        if (!Object.prototype.hasOwnProperty.call(formData, field.Name)) return acc;
        const value = formData[field.Name];
        if (!this.isDefaultValue(value, field)) {
          acc[field.Name] = value;
        }
        return acc;
      },
      {} as Record<string, unknown>
    );
  }

  private isDefaultValue(value: any, field: RcConfigOption): boolean {
    return (
      String(value) === String(field.Default) ||
      String(value) === String(field.DefaultStr) ||
      value === null
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

  // ============================================================================
  // FINALIZATION & POST-SUBMIT
  // ============================================================================
  private async finalizeRemoteCreation(): Promise<void> {
    if (this.editTarget === 'remote') {
      this.authStateService.resetAuthState();
      this.close();
      return;
    } else if (!this.pendingConfig) return;

    const { remoteData, finalConfig } = this.pendingConfig;

    await this.appSettingsService.saveRemoteSettings(remoteData.name, finalConfig);
    await this.remoteManagementService.getRemotes();
    this.authStateService.resetAuthState();
    await this.triggerAutoStartJobs(remoteData.name, finalConfig);
    this.close();
  }

  private async triggerAutoStartJobs(
    remoteName: string,
    finalConfig: RemoteConfigSections
  ): Promise<void> {
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

  // ============================================================================
  // UTILITIES & GETTERS
  // ============================================================================
  public getRemoteName(): string {
    return this.dialogData?.name || this.remoteForm.get('name')?.value;
  }

  setFormState(disabled: boolean): void {
    if (disabled) {
      this.remoteForm.disable();
      this.remoteConfigForm.disable();
    } else {
      if (this.editTarget === 'remote' && !this.cloneTarget) {
        // In remote edit mode, keep name/type disabled
        this.remoteForm.enable({ emitEvent: false });
        this.remoteForm.get('name')?.disable({ emitEvent: false });
        this.remoteForm.get('type')?.disable({ emitEvent: false });
      } else {
        // In create or clone mode, enable everything
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
