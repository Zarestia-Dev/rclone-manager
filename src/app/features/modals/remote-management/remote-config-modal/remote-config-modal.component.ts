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
import { ServeConfigStepComponent } from '../../../../shared/remote-config/serve-config-step/serve-config-step.component';
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
  ServeManagementService,
  NautilusService,
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
import { IconService } from '../../../../shared/services/icon.service';

interface DialogData {
  editTarget?: EditTarget;
  cloneTarget?: boolean;
  existingConfig?: Record<string, unknown>;
  name?: string;
  restrictMode: boolean;
  initialSection?: string;
}

interface PendingRemoteData {
  name: string;
  type?: string;
  [key: string]: unknown;
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
    ServeConfigStepComponent,
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
  private readonly serveManagementService = inject(ServeManagementService);
  readonly flagConfigService = inject(FlagConfigService);
  readonly iconService = inject(IconService);
  private readonly nautilusService = inject(NautilusService);

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

  // Serve mode step configuration
  readonly SERVE_TOTAL_STEPS = 4;
  readonly serveStepLabels = ['Serve Config', 'Filter', 'VFS', 'Backend'];

  // Forms
  remoteForm!: FormGroup;
  serveConfigForm!: FormGroup;
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

  // Serve state
  availableServeTypes: string[] = [];
  selectedServeType = 'http';
  dynamicServeFields: RcConfigOption[] = [];
  isLoadingServeFields = false;

  editTarget: EditTarget = null;
  cloneTarget = false;
  restrictMode = false;
  initialSection: string | null = null;
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

  private pendingConfig: {
    remoteData: PendingRemoteData;
    finalConfig: RemoteConfigSections;
  } | null = null;
  private changedRemoteFields = new Set<string>();
  private optionToFlagTypeMap: Record<string, FlagType> = {};
  private optionToFieldNameMap: Record<string, string> = {};
  private isPopulatingForm = false;

  // ============================================================================
  // LIFECYCLE HOOKS
  // ============================================================================
  constructor() {
    this.editTarget = this.dialogData?.editTarget || null;
    this.cloneTarget = this.dialogData?.cloneTarget || false;
    this.restrictMode = this.dialogData?.restrictMode || false;
    this.initialSection = this.dialogData?.initialSection || null;
    this.remoteForm = this.createRemoteForm();
    this.serveConfigForm = this.createServeConfigForm();
    this.remoteConfigForm = this.createRemoteConfigForm();
  }

  async ngOnInit(): Promise<void> {
    await this.loadExistingRemotes();
    await this.loadRemoteTypes();
    await this.loadAllFlagFields();

    // Load serve types and fields if in serve mode
    if (this.isServeMode) {
      await this.loadServeTypes();
      await this.loadServeFields();
    }
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
    this.addDynamicFieldsToForm();
  }

  private async loadServeTypes(): Promise<void> {
    try {
      const types = await this.serveManagementService.getServeTypes();
      this.availableServeTypes = types;

      // Set default type if needed
      if (this.editTarget === 'serve' && this.dialogData?.existingConfig?.['serveConfig']) {
        const serveConfig = this.dialogData.existingConfig['serveConfig'] as Record<
          string,
          unknown
        >;
        const options = serveConfig?.['options'] as Record<string, unknown>;
        this.selectedServeType = options?.['type'] as string;
      } else if (types.length > 0) {
        this.selectedServeType = types[0];
      }
    } catch (error) {
      console.error('Failed to load serve types:', error);
    }
  }

  private async loadServeFields(): Promise<void> {
    if (!this.selectedServeType) return;

    this.isLoadingServeFields = true;
    try {
      const fields = await this.serveManagementService.getServeFlags(this.selectedServeType);
      this.dynamicServeFields = fields;

      // Rebuild options group
      this.rebuildServeOptionsGroup();
    } catch (error) {
      console.error('Failed to load serve fields:', error);
      this.dynamicServeFields = [];
    } finally {
      this.isLoadingServeFields = false;
      this.cdRef.markForCheck();
    }
  }

  // Note: Rclone uses Name for serve flag keys NOT FieldName
  private rebuildServeOptionsGroup(): void {
    const optionsGroup = this.serveConfigForm.get('options') as FormGroup;
    if (!optionsGroup) return;

    // Clear existing
    Object.keys(optionsGroup.controls).forEach(key => {
      optionsGroup.removeControl(key);
    });

    // Add new
    this.dynamicServeFields.forEach(field => {
      const defaultValue = field.Value ?? field.Default;
      const validators = field.Required ? [Validators.required] : [];

      // Keep arrays as arrays
      const controlValue = defaultValue;

      optionsGroup.addControl(field.Name, new FormControl(controlValue, validators));
    });
  }

  async onServeTypeChange(type: string): Promise<void> {
    this.selectedServeType = type;

    // Update form
    this.serveConfigForm.get('type')?.setValue(type, { emitEvent: false });

    // Reload fields
    await this.loadServeFields();
  }

  getServeControlKey(field: RcConfigOption): string {
    return field.Name;
  }

  private addDynamicFieldsToForm(): void {
    FLAG_TYPES.forEach(flagType => {
      const optionsGroup = this.remoteConfigForm.get(`${flagType}Config.options`) as FormGroup;
      if (!optionsGroup || !this.dynamicFlagFields[flagType]) return;

      this.dynamicFlagFields[flagType].forEach(field => {
        const uniqueKey = this.getUniqueControlKey(flagType, field);
        const defaultValue = field.Value !== undefined ? field.Value : field.Default;

        this.optionToFlagTypeMap[uniqueKey] = flagType;
        this.optionToFieldNameMap[uniqueKey] = field.FieldName;

        optionsGroup.addControl(uniqueKey, new FormControl(defaultValue));
      });
    });
  }

  public getUniqueControlKey(flagType: FlagType, field: RcConfigOption): string {
    return `${flagType}---${field.Name}`;
  }

  // ============================================================================
  // FORM CREATION
  // ============================================================================
  private createRemoteForm(): FormGroup {
    const isEditMode = this.editTarget === 'remote' && !!this.dialogData?.existingConfig;
    console.log('Existing data for remote form:', this.dialogData?.existingConfig);

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

  private createServeConfigForm(): FormGroup {
    return this.fb.group({
      autoStart: [false],
      source: this.fb.group({
        pathType: ['currentRemote'],
        path: [''],
      }),
      type: ['http', Validators.required],
      options: this.fb.group({}),
    });
  }

  private createRemoteConfigForm(): FormGroup {
    return this.fb.group({
      mountConfig: this.createConfigGroup(['autoStart', 'dest', 'source', 'type']),
      copyConfig: this.createConfigGroup([
        'autoStart',
        'cronEnabled',
        'cronExpression',
        'source',
        'dest',
      ]),
      syncConfig: this.createConfigGroup([
        'autoStart',
        'cronEnabled',
        'cronExpression',
        'source',
        'dest',
      ]),
      bisyncConfig: this.createConfigGroup([
        'autoStart',
        'cronEnabled',
        'cronExpression',
        'source',
        'dest',
      ]),
      moveConfig: this.createConfigGroup([
        'autoStart',
        'cronEnabled',
        'cronExpression',
        'source',
        'dest',
      ]),
      filterConfig: this.createConfigGroup([]),
      vfsConfig: this.createConfigGroup([]),
      backendConfig: this.createConfigGroup([]),
    });
  }

  private createConfigGroup(fields: string[]): FormGroup {
    const group: Record<string, any> = {};
    fields.forEach(field => {
      group[field] = field === 'autoStart' || field === 'cronEnabled' ? [false] : [''];
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

    // Add cronExpression field for non-mount configs
    if (fields.includes('autoStart') && !fields.includes('type')) {
      group['cronExpression'] = [null];
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
    } else if (this.editTarget === 'serve') {
      this.populateServeForm(this.dialogData.existingConfig);
    } else if (this.editTarget) {
      this.populateFlagForm(this.editTarget as FlagType, this.dialogData.existingConfig);
    }

    if (this.cloneTarget) {
      this.generateNewCloneName();
    }
  }

  private async populateRemoteForm(config: any): Promise<void> {
    this.isPopulatingForm = true;
    this.remoteForm.patchValue({ name: config.name, type: config.type });
    await this.onRemoteTypeChange();
    this.remoteForm.patchValue(config);
    // Use setTimeout to ensure all async value change events have fired
    setTimeout(() => {
      this.isPopulatingForm = false;
    }, 100);
  }

  private async populateServeForm(config: any): Promise<void> {
    this.isPopulatingForm = true;

    const serveConfig = config?.['serveConfig'] || {};
    const options = serveConfig?.['options'] as Record<string, unknown>;

    // Get type
    const type = (options?.['type'] as string) || 'http';
    this.selectedServeType = type;

    // Load fields for this type
    await this.loadServeFields();

    // Populate form
    this.serveConfigForm.patchValue({
      autoStart: serveConfig.autoStart || false,
      source: this.parsePathString(serveConfig.source || '', 'currentRemote', this.getRemoteName()),
      type: type,
    });

    // Populate options AFTER rebuilding (to overwrite defaults with saved values)
    if (options) {
      const optionsGroup = this.serveConfigForm.get('options') as FormGroup;
      Object.entries(options).forEach(([key, value]) => {
        if (key !== 'type' && key !== 'fs') {
          const control = optionsGroup.get(key);
          if (control) {
            control.setValue(value, { emitEvent: false });
          }
        }
      });
    }

    // Populate flag configs
    ['filter', 'vfs', 'backend'].forEach(flagType => {
      const flagConfig = serveConfig[`${flagType}Config`] || {};
      console.log('Populating serve flag config:', flagType, flagConfig);
      this.populateFlagForm(flagType as FlagType, flagConfig);
    });

    // IMPORTANT: set the initial step for serve editing only after the
    // forms and dynamic serve/flag fields have been loaded and populated.
    // Setting the step earlier (e.g. in the constructor) caused a race where
    // the step content would be instantiated before the dynamic controls
    // existed, so arrays and other dynamic options weren't populated.
    if (this.initialSection && this.editTarget === 'serve') {
      const stepMap: Record<string, number> = {
        serve: 1,
        filter: 2,
        vfs: 3,
        backend: 4,
      };
      this.currentStep = stepMap[this.initialSection] || 1;
      // Ensure OnPush views are updated now that we've changed visible step
      this.cdRef.markForCheck();
    }

    setTimeout(() => {
      this.isPopulatingForm = false;
    }, 100);
  }

  private populateFlagForm(flagType: FlagType, config: any): void {
    config = config || {};
    const formGroup = this.remoteConfigForm.get(`${flagType}Config`);
    if (formGroup) {
      // Convert legacy string paths (e.g. "remote:/path") into the
      // structured path objects the form expects (pathType/path/otherRemoteName).
      const patchedConfig = { ...config };
      try {
        if (patchedConfig.source && typeof patchedConfig.source === 'string') {
          patchedConfig.source = this.parsePathString(
            patchedConfig.source,
            'currentRemote',
            this.getRemoteName()
          );
        }
      } catch (e) {
        // Fall back — if parsing fails we still attempt to patch raw value
        console.warn('Failed to parse source path string:', e);
      }

      try {
        if (patchedConfig.dest && typeof patchedConfig.dest === 'string') {
          // For mount dest is a simple string control, but parsePathString will
          // return an object for remote paths; the form group will accept the
          // proper shape for non-mount configs.
          patchedConfig.dest = this.parsePathString(
            patchedConfig.dest,
            flagType === 'mount' ? 'local' : 'currentRemote',
            this.getRemoteName()
          );
        }
      } catch (e) {
        console.warn('Failed to parse dest path string:', e);
      }

      formGroup.patchValue(patchedConfig);
      this.populateDynamicOptions(flagType, patchedConfig);
    }
  }

  private populateDynamicOptions(flagType: FlagType, config: any): void {
    const optionsGroup = this.remoteConfigForm.get(`${flagType}Config.options`);

    if (!optionsGroup || !this.dynamicFlagFields[flagType]) return;

    const optionsToPopulate: Record<string, any> = {};

    // Support new shape where dynamic flags live under `config.options` and
    // fallback to older top-level FieldName properties for backward compatibility.
    const source =
      config && typeof config === 'object' && config.options ? config.options : config || {};

    this.dynamicFlagFields[flagType].forEach(field => {
      const uniqueKey = this.getUniqueControlKey(flagType, field);

      // Check if field exists in the source using FieldName
      if (Object.prototype.hasOwnProperty.call(source, field.FieldName)) {
        optionsToPopulate[uniqueKey] = source[field.FieldName];
      }
    });

    optionsGroup.patchValue(optionsToPopulate);
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

  get isServeMode(): boolean {
    return this.editTarget === 'serve';
  }

  get isEditingSpecificServeSection(): boolean {
    return this.editTarget === 'serve' && !!this.initialSection;
  }

  get hasSavedServeConfig(): boolean {
    const serveConfig = this.dialogData?.existingConfig?.['serveConfig'] as Record<string, unknown>;
    return serveConfig !== undefined;
  }

  get savedType(): string {
    const serveConfig = this.dialogData?.existingConfig?.['serveConfig'] as Record<string, any>;
    return (serveConfig?.['options'].type as string) || 'http';
  }

  get currentTotalSteps(): number {
    return this.isServeMode ? this.SERVE_TOTAL_STEPS : this.TOTAL_STEPS;
  }

  get currentStepLabels(): string[] {
    return this.isServeMode ? this.serveStepLabels : this.stepLabels;
  }

  getCurrentStepLabel(): string {
    if (this.isServeMode) {
      return this.currentStepLabels[this.currentStep - 1] || 'Serve Configuration';
    }

    if (this.currentStep === 1) return 'Remote Configuration';
    const stepIndex = this.currentStep - 2;
    if (stepIndex >= 0 && stepIndex < FLAG_TYPES.length) {
      const type = FLAG_TYPES[stepIndex];
      return type.charAt(0).toUpperCase() + type.slice(1) + ' Configuration';
    }
    return '';
  }

  goToStep(step: number): void {
    if (step >= 1 && step <= this.currentTotalSteps) {
      this.currentStep = step;
      this.cdRef.markForCheck();
      this.scrollToTop();
    }
  }

  nextStep(): void {
    if (this.currentStep >= this.currentTotalSteps) return;
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

  getStepState(stepNumber: number): 'completed' | 'current' | 'future' {
    if (stepNumber < this.currentStep) return 'completed';
    if (stepNumber === this.currentStep) return 'current';
    return 'future';
  }

  getStepIcon(stepIndex: number): string {
    if (this.isServeMode) {
      const serveIconMap: Record<number, string> = {
        0: 'satellite-dish', // Serve Config
        1: 'filter', // Filter
        2: 'vfs', // VFS
        3: 'server', // Backend
      };
      return serveIconMap[stepIndex];
    }

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
    return iconMap[stepIndex];
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
    // Ignore change events during form population to prevent false positives
    if (this.isPopulatingForm) {
      return;
    }

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

    if (this.editTarget === 'serve') {
      const serveConfig = this.buildServeConfig();
      await this.appSettingsService.saveRemoteSettings(remoteName, { serveConfig });
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
    const result: any = {};
    for (const key in configData) {
      if (key === 'source' || key === 'dest') {
        result[key] = this.buildPathString(configData[key], remoteData.name);
      } else {
        result[key] = configData[key];
      }
    }
    result.options = this.cleanData(configData.options, this.dynamicFlagFields[flagType], flagType);
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

  private buildServeConfig(): Record<string, unknown> {
    const remoteName = this.getRemoteName();
    const serveData = this.serveConfigForm.getRawValue();
    const configFormData = this.remoteConfigForm.getRawValue();

    // Build fs path from source
    const fs = this.buildPathString(serveData.source, remoteName);

    // Clean serve options
    const optionsGroup = this.serveConfigForm.get('options') as FormGroup;
    const serveOptions = this.cleanServeOptions(optionsGroup.getRawValue());

    return {
      autoStart: serveData.autoStart,
      source: fs,
      options: {
        type: serveData.type,
        fs: fs,
        ...serveOptions,
      },
      filterConfig: this.buildConfig('filter', { name: remoteName }, configFormData.filterConfig),
      vfsConfig: this.buildConfig('vfs', { name: remoteName }, configFormData.vfsConfig),
      backendConfig: this.buildConfig(
        'backend',
        { name: remoteName },
        configFormData.backendConfig
      ),
    };
  }

  private cleanServeOptions(options: Record<string, unknown>): Record<string, unknown> {
    const cleaned: Record<string, unknown> = {};

    this.dynamicServeFields.forEach(field => {
      const value = options[field.Name];
      if (value !== undefined && !this.isDefaultValue(value, field)) {
        cleaned[field.Name] = value;
      }
    });

    return cleaned;
  }

  // ============================================================================
  // DATA CLEANING
  // ============================================================================
  private cleanFormData(formData: any): any {
    const result: any = {
      name: formData.name,
      type: formData.type,
    };

    this.dynamicRemoteFields.forEach(field => {
      if (!Object.prototype.hasOwnProperty.call(formData, field.Name)) return;

      const value = formData[field.Name];
      const wasChanged = this.changedRemoteFields.has(field.Name);

      // Include field if:
      // 1. Value is not at default, OR
      // 2. User explicitly changed it (even if changed back to default)
      if (!this.isDefaultValue(value, field) || wasChanged) {
        // Use FieldName if available, otherwise fall back to Name
        const outputKey = field.FieldName || field.Name;
        result[outputKey] = value;
      }
    });

    return result;
  }

  private cleanData(
    formData: any,
    fieldDefinitions: RcConfigOption[],
    flagType: FlagType
  ): Record<string, unknown> {
    return fieldDefinitions.reduce(
      (acc, field) => {
        const uniqueKey = this.getUniqueControlKey(flagType, field);
        if (!Object.prototype.hasOwnProperty.call(formData, uniqueKey)) return acc;

        const value = formData[uniqueKey];
        if (!this.isDefaultValue(value, field)) {
          // Use FieldName for output
          acc[field.FieldName] = value;
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

    // Mount operations (always run immediately if autoStart is enabled)
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

    // Helper to handle operation with cron or immediate execution
    const handleOperation = async (
      opType: 'copy' | 'sync' | 'bisync' | 'move',
      config: CopyConfig | SyncConfig | BisyncConfig | MoveConfig
    ): Promise<void> => {
      if (!config.autoStart || !config.source || !config.dest) return;

      // If cron expression is set, create scheduled task
      switch (opType) {
        case 'copy':
          await this.jobManagementService.startCopy(
            remoteName,
            config.source,
            config.dest,
            (config as CopyConfig).createEmptySrcDirs,
            config.options,
            filterConfig,
            backendConfig
          );
          break;
        case 'sync':
          await this.jobManagementService.startSync(
            remoteName,
            config.source,
            config.dest,
            (config as SyncConfig).createEmptySrcDirs,
            config.options,
            filterConfig,
            backendConfig
          );
          break;
        case 'bisync':
          await this.jobManagementService.startBisync(
            remoteName,
            config.source,
            config.dest,
            config.options,
            filterConfig,
            backendConfig
          );
          break;
        case 'move':
          await this.jobManagementService.startMove(
            remoteName,
            config.source,
            config.dest,
            (config as MoveConfig).createEmptySrcDirs,
            (config as MoveConfig).deleteEmptySrcDirs,
            config.options,
            filterConfig,
            backendConfig
          );
          break;
      }
    };

    // Handle each operation type
    await handleOperation('copy', copyConfig);
    await handleOperation('sync', syncConfig);
    await handleOperation('bisync', bisyncConfig);
    await handleOperation('move', moveConfig);
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

  public getServeOptions(): Record<string, unknown> | undefined {
    if (!this.dialogData?.existingConfig?.['serveConfig']) return undefined;
    const serveConfig = this.dialogData.existingConfig['serveConfig'] as Record<string, unknown>;
    return serveConfig['options'] as Record<string, unknown>;
  }

  setFormState(disabled: boolean): void {
    if (disabled) {
      this.remoteForm.disable();
      this.serveConfigForm.disable();
      this.remoteConfigForm.disable();
    } else {
      if (this.editTarget === 'remote' && !this.cloneTarget) {
        this.remoteForm.enable({ emitEvent: false });
        this.remoteForm.get('name')?.disable({ emitEvent: false });
        this.remoteForm.get('type')?.disable({ emitEvent: false });
      } else {
        this.remoteForm.enable();
      }
      this.serveConfigForm.enable();
      this.remoteConfigForm.enable();
    }
    this.cdRef.markForCheck();
  }

  get isSaveDisabled(): boolean {
    if (this.isAuthInProgress) return true;

    if (this.editTarget) {
      if (this.editTarget === 'remote') return !this.remoteForm.valid;
      if (this.editTarget === 'serve') return !this.serveConfigForm.valid;
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

  @HostListener('document:keydown.escape')
  close(): void {
    if (this.nautilusService.isNautilusOverlayOpen) {
      return;
    }
    this.dialogRef.close(false);
  }
}
