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
import {
  FormBuilder,
  FormGroup,
  Validators,
  FormControl,
  FormsModule,
  ReactiveFormsModule,
} from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { Subject, takeUntil } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { RemoteConfigStepComponent } from '../../../../shared/remote-config/remote-config-step/remote-config-step.component';
import { FlagConfigStepComponent } from '../../../../shared/remote-config/flag-config-step/flag-config-step.component';
import { ServeConfigStepComponent } from '../../../../shared/remote-config/serve-config-step/serve-config-step.component';
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
import { NotificationService } from '../../../../shared/services/notification.service';
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
  ServeConfig,
  DEFAULT_PROFILE_NAME,
} from '@app/types';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { MatExpansionModule } from '@angular/material/expansion';
import { InteractiveConfigStepComponent } from 'src/app/shared/remote-config/interactive-config-step/interactive-config-step.component';
import { IconService } from '../../../../shared/services/icon.service';
import {
  buildPathString,
  getDefaultAnswerFromQuestion,
  createInitialInteractiveFlowState,
  isInteractiveContinueDisabled as isInteractiveContinueDisabledUtil,
  convertBoolAnswerToString,
  updateInteractiveAnswer,
} from '../../../../shared/utils/remote-config.utils';

interface DialogData {
  editTarget?: EditTarget;
  cloneTarget?: boolean;
  existingConfig?: RemoteConfigSections;
  name?: string;
  targetProfile?: string;
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
    MatExpansionModule,
    RemoteConfigStepComponent,
    FlagConfigStepComponent,
    ServeConfigStepComponent,
    InteractiveConfigStepComponent,
    MatProgressSpinner,
    MatSelectModule,
    MatFormFieldModule,
    MatInputModule,
    FormsModule,
    ReactiveFormsModule,
  ],
  templateUrl: './remote-config-modal.component.html',
  styleUrls: ['./remote-config-modal.component.scss', '../../../../styles/_shared-modal.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
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
  private readonly notificationService = inject(NotificationService);

  private destroy$ = new Subject<void>();

  // Configuration
  readonly TOTAL_STEPS = 10; // Added Serve
  readonly stepLabels = [
    'Remote Config',
    'Mount',
    'Serve',
    'Copy',
    'Sync',
    'Bisync',
    'Move',
    'Filter',
    'VFS',
    'Backend',
  ];
  // Define local type for profile management
  readonly FLAG_TYPES = FLAG_TYPES;

  // Forms
  remoteForm!: FormGroup;
  remoteConfigForm!: FormGroup;

  // State
  remoteTypes: RemoteType[] = [];
  dynamicRemoteFields: RcConfigOption[] = [];
  existingRemotes: string[] = [];
  mountTypes: string[] = [];
  dynamicFlagFields = Object.fromEntries(
    FLAG_TYPES.map(t => [t, [] as RcConfigOption[]])
  ) as unknown as Record<FlagType, RcConfigOption[]>;

  // Profile Management - Initialized dynamically from FLAG_TYPES
  profileState = Object.fromEntries(
    FLAG_TYPES.map(t => [t, { mode: 'view' as const, tempName: '' }])
  ) as Record<FlagType, { mode: 'view' | 'edit' | 'add'; tempName: string }>;

  profiles = Object.fromEntries(FLAG_TYPES.map(t => [t, [] as any[]])) as unknown as Record<
    FlagType,
    any[]
  >;

  selectedProfileName = Object.fromEntries(
    FLAG_TYPES.map(t => [t, DEFAULT_PROFILE_NAME])
  ) as Record<FlagType, string>;

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

  interactiveFlowState: InteractiveFlowState = createInitialInteractiveFlowState();

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
    this.remoteConfigForm = this.createRemoteConfigForm();
  }

  async ngOnInit(): Promise<void> {
    await this.loadExistingRemotes();
    await this.loadRemoteTypes();
    await this.loadAllFlagFields();

    // Always load serve types as it's part of the standard flow now
    await this.loadServeTypes();
    await this.loadServeFields();

    this.initProfiles();
    this.initCurrentStep();
    this.populateFormIfEditingOrCloning();
    this.setupAutoStartValidators();
    this.setupAuthStateListeners();
    this.mountTypes = await this.mountManagementService.getMountTypes();
  }

  private initCurrentStep(): void {
    if (!this.editTarget) {
      this.currentStep = 1;
      return;
    }

    // Define the order of steps corresponding to EditTargets
    // Step 1: remote, Step 2: mount, Step 3: serve, Step 4+: other flags
    const orderedTargets = ['remote', ...FLAG_TYPES];

    // Find index
    const index = orderedTargets.indexOf(this.editTarget);

    // Set step (1-based index)
    // If not found (shouldn't happen for valid targets), default to 1
    this.currentStep = index !== -1 ? index + 1 : 1;
  }

  private initProfiles(): void {
    if (!this.dialogData?.existingConfig) return;

    // Load profiles from multi-config arrays only
    this.FLAG_TYPES.forEach(type => {
      const multiKey = `${type}Configs`;
      const config = this.dialogData.existingConfig!;

      // Use type assertion to access dynamic keys
      const multiVal = (config as any)[multiKey];

      if (Array.isArray(multiVal) && multiVal.length > 0) {
        // Load existing profiles
        this.profiles[type] = [...multiVal];
      } else {
        // Init empty default profile
        this.profiles[type] = [{ name: DEFAULT_PROFILE_NAME }];
      }

      // Select default (first one or DEFAULT_PROFILE_NAME)
      // If a targetProfile is specified in dialog data AND matches the current type, use it
      if (
        this.dialogData.targetProfile &&
        this.profiles[type].some(p => p.name === this.dialogData.targetProfile)
      ) {
        this.selectedProfileName[type] = this.dialogData.targetProfile;
      } else {
        this.selectedProfileName[type] = this.profiles[type][0]?.name || DEFAULT_PROFILE_NAME;
      }
    });
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

      // Set selected type from existing config if available
      const serveConfigs = this.dialogData?.existingConfig?.['serveConfigs'] as any[];
      if (serveConfigs?.length > 0) {
        const firstConfig = serveConfigs[0];
        const options = firstConfig?.options as Record<string, unknown>;
        this.selectedServeType = (options?.['type'] as string) || types[0];
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
      const fields = await this.flagConfigService.loadServeFlagFields(this.selectedServeType);
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
    const optionsGroup = this.remoteConfigForm.get('serveConfig.options') as FormGroup;
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
    this.remoteConfigForm.get('serveConfig.type')?.setValue(type, { emitEvent: false });

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
      serveConfig: this.createServeConfigGroup(),
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
      filterConfig: this.createConfigGroup([], false),
      vfsConfig: this.createConfigGroup([], false),
      backendConfig: this.createConfigGroup([], false),
    });
  }

  private createServeConfigGroup(): FormGroup {
    return this.fb.group({
      autoStart: [false],
      source: this.fb.group({
        pathType: ['currentRemote'],
        path: [''],
      }),
      type: ['http', Validators.required],
      vfsProfile: [DEFAULT_PROFILE_NAME],
      filterProfile: [DEFAULT_PROFILE_NAME],
      backendProfile: [DEFAULT_PROFILE_NAME],
      options: this.fb.group({}),
    });
  }

  private createConfigGroup(fields: string[], includeProfiles = true): FormGroup {
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

    // Add profile selectors
    if (includeProfiles) {
      group['vfsProfile'] = [DEFAULT_PROFILE_NAME];
      group['filterProfile'] = [DEFAULT_PROFILE_NAME];
      group['backendProfile'] = [DEFAULT_PROFILE_NAME];
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
  private setupAutoStartValidators(): void {
    const configs = FLAG_TYPES.map(type => ({
      configName: type === 'mount' ? 'mountConfig' : `${type}Config`,
      isMount: type === 'mount',
    }));

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
        // Populate all supported types (flags + serve)
        this.FLAG_TYPES.forEach(type => {
          const configKey = `${type}Configs`;
          const configs = (this.dialogData.existingConfig as any)?.[configKey];

          if (Array.isArray(configs) && configs.length > 0) {
            // Cloning: Take the first available config/profile
            if (type === 'serve') {
              this.populateServeForm({ serveConfig: configs[0] });
            } else {
              this.populateFlagForm(type as FlagType, configs[0]);
            }
          }
        });
      }
    } else if (this.editTarget) {
      // Editing a specific flag type or serve - populate form with selected profile data
      if (this.editTarget === 'serve') {
        const selectedProfileName = this.selectedProfileName['serve'];
        const profile = this.profiles['serve']?.find(p => p.name === selectedProfileName);
        if (profile) {
          this.populateServeForm({ serveConfig: profile });
        }
      } else {
        // It's a flag type
        const flagType = this.editTarget as FlagType;
        const selectedProfileName = this.selectedProfileName[flagType];
        const profile = this.profiles[flagType]?.find(p => p.name === selectedProfileName);
        if (profile) {
          this.populateFlagForm(flagType, profile);
        }
      }
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
    this.remoteConfigForm.get('serveConfig')?.patchValue({
      autoStart: serveConfig.autoStart || false,
      source: this.parsePathString(serveConfig.source || '', 'currentRemote', this.getRemoteName()),
      type: type,
      vfsProfile: serveConfig.vfsProfile || DEFAULT_PROFILE_NAME,
      filterProfile: serveConfig.filterProfile || DEFAULT_PROFILE_NAME,
      backendProfile: serveConfig.backendProfile || DEFAULT_PROFILE_NAME,
    });

    // Populate options AFTER rebuilding (to overwrite defaults with saved values)
    if (options) {
      const optionsGroup = this.remoteConfigForm.get('serveConfig.options') as FormGroup;
      if (optionsGroup) {
        Object.entries(options).forEach(([key, value]) => {
          if (key !== 'type' && key !== 'fs') {
            const control = optionsGroup.get(key);
            if (control) {
              control.setValue(value, { emitEvent: false });
            }
          }
        });
      }
    }

    setTimeout(() => {
      this.isPopulatingForm = false;
    }, 100);
  }

  private populateFlagForm(type: FlagType, config: any): void {
    const group = this.remoteConfigForm.get(`${type}Config`);
    if (!group) return;

    // Basic fields
    const patchData: any = {
      autoStart: config.autoStart || false,
      cronEnabled: config.cronEnabled || false,
      cronExpression: config.cronExpression,
      vfsProfile: config.vfsProfile || DEFAULT_PROFILE_NAME,
      filterProfile: config.filterProfile || DEFAULT_PROFILE_NAME,
      backendProfile: config.backendProfile || DEFAULT_PROFILE_NAME,
    };

    // Paths
    if (config.source !== undefined) {
      patchData.source = this.parsePathString(config.source, 'currentRemote', this.getRemoteName());
    }

    if (config.dest !== undefined) {
      // Mount has simple string dest
      if (type === 'mount') {
        patchData.dest = config.dest;
      } else {
        // Others use path object
        // Default to local for destination usually? Or generic.
        patchData.dest = this.parsePathString(config.dest, 'local', '');
      }
    }

    group.patchValue(patchData);

    // Options
    if (config.options) {
      const optionsGroup = group.get('options') as FormGroup;
      if (optionsGroup && this.dynamicFlagFields[type]) {
        Object.entries(config.options).forEach(([k, v]) => {
          // Need to find the field definition to get correct key if needed
          // But our keys are usually built from Name.
          const controlKey = this.getUniqueControlKey(type, { Name: k } as any);
          const control = optionsGroup.get(controlKey);
          if (control) {
            control.setValue(v);
          }
        });
      }
    }
  }

  private parsePathString(
    fullPath: string,
    defaultType: string,
    currentRemoteName: string
  ): { pathType: string; path: string; otherRemoteName?: string } {
    if (!fullPath) return { pathType: defaultType, path: '' };

    const parts = fullPath.split(':');
    if (parts.length > 1 && parts[0].length > 0) {
      const remote = parts[0];
      const path = parts.slice(1).join(':');

      if (remote === currentRemoteName) {
        return { pathType: 'currentRemote', path };
      } else if (this.existingRemotes.includes(remote)) {
        return { pathType: 'otherRemote', path, otherRemoteName: remote };
      }
    }

    return { pathType: defaultType, path: fullPath };
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
  // GETTERS (Unified)
  // ============================================================================

  get hasSavedServeConfig(): boolean {
    const serveConfigs = this.dialogData?.existingConfig?.['serveConfigs'] as any[];
    return serveConfigs !== undefined && serveConfigs.length > 0;
  }

  get savedType(): string {
    const serveConfigs = this.dialogData?.existingConfig?.['serveConfigs'] as any[];
    const firstConfig = serveConfigs?.[0];
    return (firstConfig?.options?.type as string) || 'http';
  }

  get currentTotalSteps(): number {
    return this.stepLabels.length;
  }

  get isNextStepAvailable(): boolean {
    const steps = this.applicableSteps;
    const currentIndex = steps.indexOf(this.currentStep);
    return currentIndex !== -1 && currentIndex < steps.length - 1;
  }

  get isPrevStepAvailable(): boolean {
    const steps = this.applicableSteps;
    const currentIndex = steps.indexOf(this.currentStep);
    return currentIndex > 0;
  }

  get currentStepLabels(): string[] {
    return this.stepLabels;
  }

  getCurrentStepLabel(): string {
    return this.stepLabels[this.currentStep - 1] || '';
  }

  private readonly iconMap: Record<number, string> = {
    0: 'hard-drive', // Remote Config
    1: 'mount',
    2: 'satellite-dish', // Serve
    3: 'copy',
    4: 'sync',
    5: 'right-left', // Bisync
    6: 'move',
    7: 'filter',
    8: 'vfs',
    9: 'server', // Backend
  };

  getStepIcon(stepIndex: number): string {
    return this.iconMap[stepIndex];
  }

  goToStep(step: number): void {
    if (step >= 1 && step <= this.currentTotalSteps) {
      this.currentStep = step;
      this.cdRef.markForCheck();
      this.scrollToTop();
    }
  }

  get applicableSteps(): number[] {
    if (!this.editTarget) {
      // New Remote: All steps
      return Array.from({ length: this.TOTAL_STEPS }, (_, i) => i + 1);
    }

    if (this.editTarget === 'remote') {
      // Editing remote: All steps
      return Array.from({ length: this.TOTAL_STEPS }, (_, i) => i + 1);
    }

    // Serve is step 3
    if (this.editTarget === 'serve') {
      return [3];
    }

    // Flag types - single step edit
    const target = this.editTarget as FlagType;
    const flagIndex = FLAG_TYPES.indexOf(target);
    if (flagIndex === -1) return [1]; // Fallback

    // Mount(0)->2, Others(i)->i+3
    const step = flagIndex === 0 ? 2 : flagIndex + 3;
    return [step];
  }

  nextStep(): void {
    const steps = this.applicableSteps;
    const currentIndex = steps.indexOf(this.currentStep);
    if (currentIndex === -1 || currentIndex >= steps.length - 1) return;

    if (this.currentStep === 1 && !this.remoteForm.valid) {
      this.remoteForm.markAllAsTouched();
      return;
    }

    this.currentStep = steps[currentIndex + 1];
    this.cdRef.markForCheck();
    this.scrollToTop();
  }

  prevStep(): void {
    const steps = this.applicableSteps;
    const currentIndex = steps.indexOf(this.currentStep);
    if (currentIndex <= 0) return;

    this.currentStep = steps[currentIndex - 1];
    this.cdRef.markForCheck();
    this.scrollToTop();
  }

  getStepState(stepNumber: number): 'completed' | 'current' | 'future' {
    if (stepNumber < this.currentStep) return 'completed';
    if (stepNumber === this.currentStep) return 'current';
    return 'future';
  }

  handleStepKeydown(event: KeyboardEvent): void {
    if (!this.editTarget) return;

    const handlers: Record<string, () => void> = {
      ArrowRight: () => this.nextStep(),
      ArrowLeft: () => this.prevStep(),
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
      this.interactiveFlowState = updateInteractiveAnswer(this.interactiveFlowState, newAnswer);
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
    // Ensure all current profiles are saved before building final config
    this.FLAG_TYPES.forEach(type => {
      this.saveCurrentProfile(type);
    });

    const remoteData = this.cleanFormData(this.remoteForm.getRawValue());
    const finalConfig = this.buildFinalConfig();

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
      // Ensure all profiles are saved if we are in remote edit mode (assuming tabs are editable)
      // Actually, existing logic for 'remote' edit target seems to ONLY update remote params
      // and IGNORES the operation tabs. This might be intended behavior or a legacy gap.
      // For now, I'll stick to fixing serve target.
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
  private buildFinalConfig(): RemoteConfigSections {
    return {
      mountConfigs: this.profiles['mount'],
      copyConfigs: this.profiles['copy'],
      syncConfigs: this.profiles['sync'],
      bisyncConfigs: this.profiles['bisync'],
      moveConfigs: this.profiles['move'],
      serveConfigs: this.profiles['serve'],
      filterConfigs: this.profiles['filter'],
      vfsConfigs: this.profiles['vfs'],
      backendConfigs: this.profiles['backend'],
      showOnTray: true,
    };
  }

  // ============================================================================
  // PROFILE MANAGEMENT
  // ============================================================================

  // State Management Methods
  startAddProfile(type: FlagType): void {
    // Generate next default name (e.g., profile-2)
    const existingNames = this.getProfiles(type).map(p => p.name);
    let counter = 1;
    while (existingNames.includes(`profile-${counter}`)) {
      counter++;
    }
    const newName = `profile-${counter}`;

    this.setProfileMode(type, 'add', newName);
  }

  startEditProfile(type: FlagType): void {
    const currentName = this.getSelectedProfile(type);
    if (!currentName) return;

    // Prevent renaming default profile
    if (currentName.toLowerCase() === DEFAULT_PROFILE_NAME) return;

    this.setProfileMode(type, 'edit', currentName);
  }

  cancelProfileEdit(type: FlagType): void {
    this.setProfileMode(type, 'view');
  }

  saveProfile(type: FlagType): void {
    const state = this.profileState[type];
    const newName = state.tempName.trim();

    if (!newName) return; // Basic validation

    if (state.mode === 'add') {
      // Logic for adding new profile
      const newProfile = { name: newName };
      this.profiles[type] = [...this.profiles[type], newProfile];

      // Select the new profile
      this.selectProfile(type, newName);
    } else if (state.mode === 'edit') {
      // Logic for renaming
      const oldName = this.getSelectedProfile(type);
      if (oldName === newName) {
        this.cancelProfileEdit(type);
        return;
      }

      // Check if name exists
      if (this.profiles[type].some(p => p.name === newName)) {
        // Name collision - maybe show toaster? For now just return
        return;
      }

      // Update name in profiles array
      const profileIndex = this.profiles[type].findIndex(p => p.name === oldName);
      if (profileIndex !== -1) {
        this.profiles[type][profileIndex].name = newName;
      }

      // Update selection
      this.selectedProfileName[type] = newName;

      // Cascade update: Rename profile in running caches
      this.cascadeProfileRename(type, oldName, newName);
    }

    // Reset state to view
    this.setProfileMode(type, 'view');
  }

  deleteProfile(type: FlagType, name: string): void {
    const profiles = this.profiles[type] || [];
    const index = profiles.findIndex(p => p.name === name);
    if (index === -1) return;

    // Prevent deleting default profile
    if (name.toLowerCase() === DEFAULT_PROFILE_NAME) return;

    // Check if profile is in use
    const remoteName = this.getRemoteName();
    if (remoteName) {
      const usage = this.getProfileUsage(type, remoteName, name);
      if (usage.inUse) {
        this.notificationService.showWarning(
          `Cannot delete profile "${name}" - it is in use by ${usage.count} active ${usage.opType}(s)`
        );
        return;
      }
    }

    this.profiles[type].splice(index, 1);

    // If we deleted the selected profile, select another
    if (this.selectedProfileName[type] === name) {
      if (this.profiles[type].length > 0) {
        this.selectProfile(type, this.profiles[type][0].name);
      } else {
        // Create default if all deleted
        this.startAddProfile(type);
        this.selectProfile(type, this.profiles[type][0].name);
      }
    }
  }

  selectProfile(type: FlagType, name: string): void {
    const profiles = this.profiles[type] || [];
    const newProfile = profiles.find(p => p.name === name);
    if (!newProfile) return;

    // Save current profile data first
    this.saveCurrentProfile(type);

    // Update selection
    this.selectedProfileName[type] = name;

    // Populate form with new profile data
    if (type === 'serve') {
      this.populateServeForm({ serveConfig: newProfile });
    } else {
      this.populateFlagForm(type as FlagType, newProfile);
    }
  }

  saveCurrentProfile(type: FlagType): void {
    const currentName = this.selectedProfileName[type];
    const profiles = this.profiles[type] || [];
    const profile = profiles.find(p => p.name === currentName);
    if (!profile) return;

    let builtConfig: any = {};

    // Get current form data
    const formValue = this.remoteConfigForm.get(`${type}Config`)?.getRawValue();
    if (!formValue) return;

    // Build fresh config object
    // Note: We need 'remoteData' for buildConfig to process paths.
    // We can use generic remote info here as paths are relative/parsed.
    const remoteData = { name: this.getRemoteName() };
    builtConfig = this.buildConfig(type, remoteData, formValue);

    // Merge into profile (preserving name)
    Object.assign(profile, { ...builtConfig, name: currentName });
  }

  getProfiles(type: FlagType): any[] {
    return this.profiles[type] || [];
  }

  getSelectedProfile(type: FlagType): string {
    return this.selectedProfileName[type];
  }

  getProfileOptions(type: 'vfs' | 'filter' | 'backend'): string[] {
    return (this.profiles[type] || []).map((p: any) => p.name || DEFAULT_PROFILE_NAME);
  }

  private buildConfig(flagType: FlagType, remoteData: any, configData: any): any {
    if (flagType === 'serve') {
      return this.buildServeConfig(configData, remoteData.name);
    }

    const result: any = {};
    for (const key in configData) {
      if (key === 'source' || key === 'dest') {
        result[key] = buildPathString(configData[key], remoteData.name);
      } else {
        result[key] = configData[key];
      }
    }
    result.options = this.cleanData(configData.options, this.dynamicFlagFields[flagType], flagType);
    return result;
  }

  private createEmptyFinalConfig(): RemoteConfigSections {
    return {
      mountConfigs: [] as MountConfig[],
      copyConfigs: [] as CopyConfig[],
      syncConfigs: [] as SyncConfig[],
      bisyncConfigs: [] as BisyncConfig[],
      moveConfigs: [] as MoveConfig[],
      serveConfigs: [] as ServeConfig[],
      filterConfigs: [] as FilterConfig[],
      vfsConfigs: [] as VfsConfig[],
      backendConfigs: [] as BackendConfig[],
      showOnTray: true,
    };
  }

  private async buildUpdateConfig(): Promise<Record<string, any>> {
    const updatedConfig: Record<string, any> = {};

    if (this.editTarget && this.editTarget !== 'remote') {
      const target = this.editTarget as FlagType;

      if (this.FLAG_TYPES.includes(target)) {
        // Save current profile to state first
        this.saveCurrentProfile(target as FlagType);
        // Save the whole profiles array
        updatedConfig[`${target}Configs`] = this.profiles[target as FlagType];
      } else {
        // Fallback for single-config types (filter, vfs, backend)
        const flagData = this.remoteConfigForm.getRawValue()[`${target}Config`];
        const remoteData = { name: this.getRemoteName() };
        updatedConfig[`${target}Config`] = this.buildConfig(target, remoteData, flagData);
      }
    }

    return updatedConfig;
  }

  private buildServeConfig(serveData: any, remoteName: string): Record<string, unknown> {
    // Build fs path from source
    const fs = buildPathString(serveData.source, remoteName);

    // Clean serve options
    const serveOptions = this.cleanServeOptions(serveData.options || {});

    return {
      autoStart: serveData.autoStart,
      source: fs,
      vfsProfile: serveData.vfsProfile || DEFAULT_PROFILE_NAME,
      filterProfile: serveData.filterProfile || DEFAULT_PROFILE_NAME,
      backendProfile: serveData.backendProfile || DEFAULT_PROFILE_NAME,
      options: {
        type: serveData.type,
        fs: fs,
        ...serveOptions,
      },
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
      answer: getDefaultAnswerFromQuestion(startResp),
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
        answer = convertBoolAnswerToString(answer);
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
        this.interactiveFlowState.answer = getDefaultAnswerFromQuestion(resp);
      }
    } catch (error) {
      console.error('Interactive config error:', error);
    } finally {
      this.cdRef.markForCheck();
    }
  }

  isInteractiveContinueDisabled(): boolean {
    return isInteractiveContinueDisabledUtil(this.interactiveFlowState, this.isAuthCancelled);
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
    const { mountConfigs, serveConfigs, vfsConfigs, filterConfigs, backendConfigs } = finalConfig;

    const getSharedOptions = (configs: any[] | undefined, profileName?: string): any => {
      // If no profile name, assume DEFAULT_PROFILE_NAME? Or undefined?
      // Legacy behavior passed global config. Now we check profile.
      const name = profileName || DEFAULT_PROFILE_NAME;
      return configs?.find(p => p.name === name)?.options;
    };

    // Mount operations (always run immediately if autoStart is enabled)
    if (mountConfigs) {
      for (const config of mountConfigs) {
        if (config.autoStart && config.dest) {
          await this.mountManagementService.mountRemote(
            remoteName,
            config.source,
            config.dest,
            config.type,
            config.options,
            getSharedOptions(vfsConfigs, config.vfsProfile),
            getSharedOptions(filterConfigs, config.filterProfile),
            getSharedOptions(backendConfigs, config.backendProfile)
          );
        }
      }
    }

    // Helper to handle operation with cron or immediate execution
    const handleOperation = async (
      opType: 'copy' | 'sync' | 'bisync' | 'move',
      config: CopyConfig | SyncConfig | BisyncConfig | MoveConfig
    ): Promise<void> => {
      if (!config.autoStart || !config.source || !config.dest) return;

      const filterOpts = getSharedOptions(filterConfigs, config.filterProfile);
      const backendOpts = getSharedOptions(backendConfigs, config.backendProfile);

      // If cron expression is set, create scheduled task
      switch (opType) {
        case 'copy':
          await this.jobManagementService.startCopy(
            remoteName,
            config.source,
            config.dest,
            (config as CopyConfig).createEmptySrcDirs,
            config.options,
            filterOpts,
            backendOpts
          );
          break;
        case 'sync':
          await this.jobManagementService.startSync(
            remoteName,
            config.source,
            config.dest,
            (config as SyncConfig).createEmptySrcDirs,
            config.options,
            filterOpts,
            backendOpts
          );
          break;
        case 'bisync':
          await this.jobManagementService.startBisync(
            remoteName,
            config as BisyncConfig,
            filterOpts,
            backendOpts
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
            filterOpts,
            backendOpts
          );
          break;
      }
    };

    // Handle standard job operations (copy, sync, bisync, move)
    const jobTypes = FLAG_TYPES.filter(t => t !== 'mount' && t !== 'serve');
    for (const type of jobTypes) {
      const configKey = `${type}Configs`;
      // interactive access to dynamic key
      const configs = (finalConfig as any)[configKey];
      if (Array.isArray(configs)) {
        for (const config of configs) {
          // Cast to specific config type if needed, or use 'any' as we are identifying by structure
          await handleOperation(type as any, config);
        }
      }
    }

    // Serve is handled separately
    if (serveConfigs) {
      for (const config of serveConfigs) {
        if (config.autoStart && config.options) {
          await this.serveManagementService.startServe(
            remoteName,
            config.options, // Options contains type and fs
            getSharedOptions(backendConfigs, config.backendProfile),
            getSharedOptions(filterConfigs, config.filterProfile),
            getSharedOptions(vfsConfigs, config.vfsProfile)
          );
        }
      }
    }
  }

  async cancelAuth(): Promise<void> {
    await this.authStateService.cancelAuth();
    this.interactiveFlowState = createInitialInteractiveFlowState();
    this.cdRef.markForCheck();
  }

  // ============================================================================
  // UTILITIES & GETTERS
  // ============================================================================
  public getRemoteName(): string {
    return this.dialogData?.name || this.remoteForm.get('name')?.value;
  }

  /**
   * Cascade a profile rename to all relevant running caches (jobs, mounts, serves)
   */
  private cascadeProfileRename(type: FlagType, oldName: string, newName: string): void {
    const remoteName = this.getRemoteName();
    if (!remoteName) return;

    const renameHandlers: Record<string, () => Promise<number>> = {
      mount: () =>
        this.mountManagementService.renameProfileInMountCache(remoteName, oldName, newName),
      serve: () =>
        this.serveManagementService.renameProfileInServeCache(remoteName, oldName, newName),
    };

    // Job types (sync, copy, bisync, move) use jobManagementService
    const jobTypes = ['sync', 'copy', 'bisync', 'move'];
    if (jobTypes.includes(type)) {
      renameHandlers[type] = () =>
        this.jobManagementService.renameProfileInCache(remoteName, oldName, newName);
    }

    const handler = renameHandlers[type];
    if (handler) {
      handler()
        .then(updatedCount => {
          if (updatedCount > 0) {
            console.debug(`Updated ${updatedCount} ${type}(s) with new profile name: ${newName}`);
          }
        })
        .catch(err => {
          console.warn(`Failed to update ${type}s with new profile name:`, err);
        });
    }
  }

  /**
   * Check if a profile is currently in use by any active operation
   * Returns { inUse: boolean, count: number, opType: string }
   */
  private getProfileUsage(
    type: FlagType,
    remoteName: string,
    profileName: string
  ): { inUse: boolean; count: number; opType: string } {
    const jobTypes = ['sync', 'copy', 'bisync', 'move'];

    if (jobTypes.includes(type)) {
      const activeJobs = this.jobManagementService.getActiveJobsForRemote(remoteName, profileName);
      return { inUse: activeJobs.length > 0, count: activeJobs.length, opType: 'job' };
    }

    if (type === 'mount') {
      const activeMounts = this.mountManagementService.getMountsForRemoteProfile(
        remoteName,
        profileName
      );
      return { inUse: activeMounts.length > 0, count: activeMounts.length, opType: 'mount' };
    }

    if (type === 'serve') {
      const activeServes = this.serveManagementService.getServesForRemoteProfile(
        remoteName,
        profileName
      );
      return { inUse: activeServes.length > 0, count: activeServes.length, opType: 'serve' };
    }

    return { inUse: false, count: 0, opType: '' };
  }

  /**
   * Set profile state mode (view, edit, add) with optional tempName
   */
  private setProfileMode(type: FlagType, mode: 'view' | 'edit' | 'add', tempName = ''): void {
    this.profileState[type] = { mode, tempName };
  }

  public getProfileState(type: string | any): { mode: 'view' | 'edit' | 'add'; tempName: string } {
    const key = type as FlagType;
    // Ensure we return a valid state object even if key is somehow off, though it shouldn't be
    return this.profileState[key] || { mode: 'view', tempName: '' };
  }

  setFormState(disabled: boolean): void {
    if (disabled) {
      this.remoteForm.disable();
      this.remoteConfigForm.disable();
    } else {
      if (this.editTarget === 'remote' && !this.cloneTarget) {
        this.remoteForm.enable({ emitEvent: false });
        this.remoteForm.get('name')?.disable({ emitEvent: false });
        this.remoteForm.get('type')?.disable({ emitEvent: false });
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
      // Both serve and flag types use the same pattern
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
