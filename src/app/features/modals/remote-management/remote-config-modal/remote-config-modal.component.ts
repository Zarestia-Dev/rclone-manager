// OH GOD THIS FILE. This is the big kahuna of the app, the mother of all modals, the remote config modal. It has a LOT of logic in it, and it's not pretty. I'm sorry. I tried to break it down into sections with comments to make it more digestible. If you're reading this, good luck. You're gonna need it.
// DAYUM! But good think is, modal works. There is not good think about the code tho. Refactor is needed, but for now, let's just get this out there.
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  HostListener,
  inject,
  OnDestroy,
  OnInit,
  signal,
  effect,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import {
  FormBuilder,
  FormGroup,
  Validators,
  FormControl,
  FormsModule,
  ReactiveFormsModule,
  FormControlStatus,
} from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatTooltipModule } from '@angular/material/tooltip';
import { RemoteConfigStepComponent } from '../../../../shared/remote-config/remote-config-step/remote-config-step.component';
import { FlagConfigStepComponent } from '../../../../shared/remote-config/flag-config-step/flag-config-step.component';
import { SearchContainerComponent } from '../../../../shared/components/search-container/search-container.component';
import { AuthStateService } from '@app/services';
import { ValidatorRegistryService } from '@app/services';
import {
  FlagConfigService,
  RemoteManagementService,
  JobManagementService,
  MountManagementService,
  AppSettingsService,
  FileSystemService,
  ServeManagementService,
  NautilusService,
  ModalService,
} from '@app/services';
import { NotificationService } from '@app/services';
import {
  RcConfigOption,
  EditTarget,
  FlagType,
  RemoteType,
  RemoteConfigSections,
  InteractiveFlowState,
  FLAG_TYPES,
  REMOTE_NAME_REGEX,
  INTERACTIVE_REMOTES,
  ServeConfig,
  MountConfig,
  CopyConfig,
  SyncConfig,
  BisyncConfig,
  MoveConfig,
  FilterConfig,
  VfsConfig,
  BackendConfig,
  RuntimeRemoteConfig,
  DEFAULT_PROFILE_NAME,
  REMOTE_CONFIG_KEYS,
} from '@app/types';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { MatExpansionModule } from '@angular/material/expansion';
import { InteractiveConfigStepComponent } from 'src/app/shared/remote-config/interactive-config-step/interactive-config-step.component';
import { IconService } from '@app/services';
import {
  buildPathString,
  getDefaultAnswerFromQuestion,
  createInitialInteractiveFlowState,
  convertBoolAnswerToString,
  parseFsString,
} from '../../../../services/remote/utils/remote-config.utils';

interface DialogData {
  editTarget?: EditTarget;
  cloneTarget?: boolean;
  existingConfig?: RemoteConfigSections;
  name?: string;
  remoteType?: string;
  targetProfile?: string;
  initialSection?: string;
}

interface PendingRemoteData {
  name: string;
  type?: string;
  [key: string]: unknown;
}

type ProfileData = Record<string, unknown>;
type ProfilesMap = Record<string, ProfileData>;
type SharedProfileType = FlagType | 'runtimeRemote';

const PROFILE_TYPES: SharedProfileType[] = [...FLAG_TYPES, 'runtimeRemote'];

@Component({
  selector: 'app-remote-config-modal',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ReactiveFormsModule,
    TranslateModule,
    MatIconModule,
    MatButtonModule,
    MatSelectModule,
    MatFormFieldModule,
    MatInputModule,
    MatTooltipModule,
    MatProgressSpinner,
    MatExpansionModule,
    RemoteConfigStepComponent,
    FlagConfigStepComponent,
    InteractiveConfigStepComponent,
    SearchContainerComponent,
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
  private readonly serveManagementService = inject(ServeManagementService);
  readonly flagConfigService = inject(FlagConfigService);
  readonly iconService = inject(IconService);
  private readonly nautilusService = inject(NautilusService);
  private readonly notificationService = inject(NotificationService);
  private readonly translate = inject(TranslateService);
  private readonly modalService = inject(ModalService);
  private readonly destroyRef = inject(DestroyRef);

  // Configuration
  readonly TOTAL_STEPS = 11;
  readonly stepConfigs = computed(() => {
    const remoteType = this.remoteForm?.get('type')?.value;
    const remoteIcon = this.iconService.getIconName(remoteType || 'hard-drive');

    const basicSteps = [
      {
        label: 'modals.remoteConfig.steps.remoteConfig',
        icon: remoteIcon,
        type: 'remote' as const,
      },
      { label: 'modals.remoteConfig.steps.mount', icon: 'mount', type: 'mount' as const },
      { label: 'modals.remoteConfig.steps.serve', icon: 'satellite-dish', type: 'serve' as const },
      { label: 'modals.remoteConfig.steps.sync', icon: 'sync', type: 'sync' as const },
      { label: 'modals.remoteConfig.steps.bisync', icon: 'right-left', type: 'bisync' as const },
      { label: 'modals.remoteConfig.steps.move', icon: 'move', type: 'move' as const },
      { label: 'modals.remoteConfig.steps.copy', icon: 'copy', type: 'copy' as const },
      { label: 'modals.remoteConfig.steps.filter', icon: 'filter', type: 'filter' as const },
      { label: 'modals.remoteConfig.steps.vfs', icon: 'vfs', type: 'vfs' as const },
      { label: 'modals.remoteConfig.steps.backend', icon: 'server', type: 'backend' as const },
      {
        label: 'modals.remoteConfig.steps.runtimeRemote',
        icon: 'gear',
        type: 'runtimeRemote' as const,
      },
    ];
    return basicSteps;
  });

  get stepLabels(): string[] {
    return this.stepConfigs().map(s => s.label);
  }
  // Define local type for profile management
  readonly FLAG_TYPES = FLAG_TYPES;

  // Forms
  remoteForm!: FormGroup;
  remoteConfigForm!: FormGroup;
  remoteFormStatus = signal<FormControlStatus>('INVALID');
  remoteConfigFormStatus = signal<FormControlStatus>('INVALID');

  // State
  remoteTypes = signal<RemoteType[]>([]);
  dynamicRemoteFields: RcConfigOption[] = [];
  dynamicRuntimeRemoteFields: RcConfigOption[] = [];
  existingRemotes = signal<string[]>([]);
  mountTypes = signal<string[]>([]);
  dynamicFlagFields = Object.fromEntries(
    FLAG_TYPES.map(t => [t, [] as RcConfigOption[]])
  ) as unknown as Record<FlagType, RcConfigOption[]>;

  // Profile Management - Initialized dynamically from FLAG_TYPES
  profileState = signal<
    Record<SharedProfileType, { mode: 'view' | 'edit' | 'add'; tempName: string }>
  >(
    Object.fromEntries(
      PROFILE_TYPES.map(t => [t, { mode: 'view' as const, tempName: '' }])
    ) as Record<SharedProfileType, { mode: 'view' | 'edit' | 'add'; tempName: string }>
  );

  profiles = signal<Record<SharedProfileType, ProfilesMap>>(
    Object.fromEntries(PROFILE_TYPES.map(t => [t, {} as ProfilesMap])) as Record<
      SharedProfileType,
      ProfilesMap
    >
  );

  selectedProfileName = signal<Record<SharedProfileType, string>>(
    Object.fromEntries(PROFILE_TYPES.map(t => [t, DEFAULT_PROFILE_NAME])) as Record<
      SharedProfileType,
      string
    >
  );

  // Serve state
  availableServeTypes = signal<string[]>([]);
  selectedServeType = signal('http');
  dynamicServeFields: RcConfigOption[] = [];
  isLoadingServeFields = signal(false);
  isLoadingRuntimeRemoteFields = signal(false);
  // State
  editTarget = signal<EditTarget>(null);
  cloneTarget = signal(false);
  private initialSection: string | null = null;
  useInteractiveMode = signal(false);
  showAdvancedOptions = signal(false);

  isRemoteConfigLoading = signal(false);
  isAuthInProgress = this.authStateService.isAuthInProgress;
  isAuthCancelled = this.authStateService.isAuthCancelled;
  currentStep = signal(1);

  interactiveFlowState = signal<InteractiveFlowState>(createInitialInteractiveFlowState());

  private pendingConfig: {
    remoteData: PendingRemoteData;
    finalConfig: RemoteConfigSections;
  } | null = null;
  private changedRemoteFields = new Set<string>();
  private optionToFlagTypeMap: Record<string, FlagType> = {};
  private optionToFieldNameMap: Record<string, string> = {};
  private isPopulatingForm = false;

  // Search state
  isSearchVisible = signal(false);
  searchQuery = signal('');

  // ============================================================================
  // LIFECYCLE HOOKS
  // ============================================================================
  constructor() {
    this.editTarget.set(this.dialogData?.editTarget || null);
    this.cloneTarget.set(this.dialogData?.cloneTarget || false);
    this.initialSection = this.dialogData?.initialSection || null;
    this.remoteForm = this.createRemoteForm();
    this.remoteConfigForm = this.createRemoteConfigForm();

    // Initialize status signals
    this.remoteFormStatus.set(this.remoteForm.status);
    this.remoteForm.statusChanges
      .pipe(takeUntilDestroyed())
      .subscribe(status => this.remoteFormStatus.set(status));

    this.remoteConfigFormStatus.set(this.remoteConfigForm.status);
    this.remoteConfigForm.statusChanges
      .pipe(takeUntilDestroyed())
      .subscribe(status => this.remoteConfigFormStatus.set(status));

    this.setupAuthStateListeners();
  }

  async ngOnInit(): Promise<void> {
    await this.loadExistingRemotes();
    await this.loadRemoteTypes();
    await this.loadAllFlagFields();

    // Always load serve types as it's part of the standard flow now
    await this.loadServeTypes();
    await this.loadServeFields();
    await this.loadMountTypes();

    this.initProfiles();
    this.initCurrentStep();
    this.populateFormIfEditingOrCloning();
    this.setupAutoStartValidators();
  }

  private initCurrentStep(): void {
    const editTargetValue = this.editTarget();
    if (!editTargetValue) {
      this.currentStep.set(1);
      return;
    }

    const index = this.stepConfigs().findIndex(s => s.type === editTargetValue);
    this.currentStep.set(index !== -1 ? index + 1 : 1);
  }

  private initProfiles(): void {
    // Load profiles from multi-config objects, or initialize with default profile
    // This must run for both create and edit modes to ensure profiles are always available
    PROFILE_TYPES.forEach(type => {
      const multiKey = REMOTE_CONFIG_KEYS[type as keyof typeof REMOTE_CONFIG_KEYS];
      const config = this.dialogData?.existingConfig;

      // Access dynamic key using keyof
      const multiVal = config?.[multiKey] as Record<string, unknown> | undefined;

      if (multiVal && Object.keys(multiVal).length > 0) {
        // Load existing profiles from saved config (already keyed by name)
        this.profiles.update(p => ({ ...p, [type]: { ...multiVal } }));
      } else {
        // Init with default profile (important for both create and edit modes)
        this.profiles.update(p => ({ ...p, [type]: { [DEFAULT_PROFILE_NAME]: {} } }));
      }

      // Select default (first one or DEFAULT_PROFILE_NAME)
      // If a targetProfile is specified in dialog data AND matches the current type, use it
      const profilesForType = this.profiles()[type];
      const profileNames = Object.keys(profilesForType);
      const targetProfile = this.dialogData?.targetProfile;

      if (targetProfile && profileNames.includes(targetProfile)) {
        this.selectedProfileName.update(s => ({ ...s, [type]: targetProfile }));
      } else {
        this.selectedProfileName.update(s => ({
          ...s,
          [type]: profileNames[0] || DEFAULT_PROFILE_NAME,
        }));
      }
    });
  }

  ngOnDestroy(): void {
    this.authStateService.cancelAuth();
  }

  // ============================================================================
  // INITIALIZATION
  // ============================================================================
  private async loadExistingRemotes(): Promise<void> {
    try {
      const remotes = await this.remoteManagementService.getRemotes();
      this.existingRemotes.set(remotes);
      this.refreshRemoteNameValidator();
    } catch (error) {
      console.error('Error loading remotes:', error);
    }
  }

  private async loadRemoteTypes(): Promise<void> {
    try {
      const providers = await this.remoteManagementService.getRemoteTypes();
      this.remoteTypes.set(providers.map(p => ({ value: p.name, label: p.description })));
    } catch (error) {
      console.error('Error fetching remote types:', error);
    }
  }

  private async loadAllFlagFields(): Promise<void> {
    this.dynamicFlagFields = await this.flagConfigService.loadAllFlagFields();
    this.addDynamicFieldsToForm();
  }

  private async loadMountTypes(): Promise<void> {
    try {
      const types = await this.mountManagementService.getMountTypes();
      this.mountTypes.set(types);
    } catch (error) {
      console.error('Failed to load mount types:', error);
    }
  }

  private async loadServeTypes(): Promise<void> {
    try {
      const types = await this.serveManagementService.getServeTypes();
      this.availableServeTypes.set(types);

      // Set selected type from existing config if available
      const serveConfigs = this.dialogData?.existingConfig?.[REMOTE_CONFIG_KEYS.serve] as
        | ProfilesMap
        | undefined;
      this.profiles.update(p => ({ ...p, serve: serveConfigs || {} }));
      if (serveConfigs && Object.keys(serveConfigs).length > 0) {
        const firstKey = Object.keys(serveConfigs)[0];
        const firstConfig = serveConfigs[firstKey] as Record<string, any>;
        const options = firstConfig?.['options'] as Record<string, unknown>;
        const type = (options?.['type'] as string) || 'http';
        this.selectedServeType.set(type);
      } else if (types.length > 0) {
        this.selectedServeType.set(types[0]);
      }
    } catch (error) {
      console.error('Failed to load serve types:', error);
    }
  }

  private async loadServeFields(): Promise<void> {
    if (!this.selectedServeType()) return;

    this.isLoadingServeFields.set(true);
    try {
      const fields = await this.flagConfigService.loadServeFlagFields(this.selectedServeType());
      this.dynamicServeFields = fields;

      // Rebuild options group
      this.rebuildServeOptionsGroup();
    } catch (error) {
      console.error('Failed to load serve fields:', error);
      this.dynamicServeFields = [];
    } finally {
      this.isLoadingServeFields.set(false);
    }
  }

  private async loadRuntimeRemoteFields(type: string): Promise<void> {
    if (!type) {
      this.dynamicRuntimeRemoteFields = [];
      return;
    }

    this.isLoadingRuntimeRemoteFields.set(true);
    this.dynamicRuntimeRemoteFields = [];
    try {
      this.dynamicRuntimeRemoteFields =
        await this.remoteManagementService.getRemoteConfigFields(type);
      this.replaceRuntimeRemoteFormControls();
    } catch (error) {
      console.error('Error loading runtime remote config fields:', error);
    } finally {
      this.isLoadingRuntimeRemoteFields.set(false);
    }
  }

  private async syncRuntimeRemoteType(): Promise<void> {
    const runtimeRemoteGroup = this.remoteConfigForm.get('runtimeRemoteConfig') as FormGroup | null;
    if (!runtimeRemoteGroup) return;

    const currentRemoteType = String(this.remoteForm.get('type')?.value || '').trim();
    runtimeRemoteGroup.get('type')?.setValue(currentRemoteType, { emitEvent: false });

    if (!currentRemoteType) {
      this.dynamicRuntimeRemoteFields = [];
      return;
    }

    await this.loadRuntimeRemoteFields(currentRemoteType);
  }

  private replaceRuntimeRemoteFormControls(): void {
    const runtimeRemoteGroup = this.remoteConfigForm.get('runtimeRemoteConfig') as FormGroup;
    if (!runtimeRemoteGroup) return;

    Object.keys(runtimeRemoteGroup.controls).forEach(key => {
      if (key !== 'type') {
        runtimeRemoteGroup.removeControl(key);
      }
    });

    this.dynamicRuntimeRemoteFields.forEach(field => {
      runtimeRemoteGroup.addControl(field.Name, new FormControl(field.Value ?? field.Default));
    });
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
    this.selectedServeType.set(type);

    // Update form
    this.remoteConfigForm.get('serveConfig.type')?.setValue(type, { emitEvent: false });

    // Reload fields
    await this.loadServeFields();
  }

  async onRuntimeRemoteTypeChange(): Promise<void> {
    await this.syncRuntimeRemoteType();
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
    // Serve uses Name directly (not prefixed) - see rebuildServeOptionsGroup
    if (flagType === 'serve') {
      return field.Name;
    }
    return `${flagType}---${field.Name}`;
  }

  // ============================================================================
  // FORM CREATION
  // ============================================================================
  private createRemoteForm(): FormGroup {
    const isEdit = this.editTarget() === 'remote';
    const isClone = isEdit && this.cloneTarget();
    return this.fb.group({
      name: [
        '',
        [
          Validators.required,
          Validators.pattern(REMOTE_NAME_REGEX),
          ...(isEdit && !isClone
            ? []
            : [this.validatorRegistry.createRemoteNameValidator(this.existingRemotes())]),
        ],
      ],
      type: ['', [Validators.required]],
    });
  }

  private createRemoteConfigForm(): FormGroup {
    const group: Record<string, FormGroup> = {};

    // Grouping serve and other flags if necessary
    if (this.editTarget() === 'serve') {
      group['serveConfig'] = this.createServeConfigGroup();
    } else {
      FLAG_TYPES.forEach(flag => {
        if (flag === 'serve') {
          group['serveConfig'] = this.createServeConfigGroup();
        } else {
          group[`${flag}Config`] = this.createConfigGroup(this.getFieldsForFlagType(flag));
        }
      });

      group['runtimeRemoteConfig'] = this.createRuntimeRemoteConfigGroup();
    }

    return this.fb.group(group);
  }

  private createRuntimeRemoteConfigGroup(): FormGroup {
    return this.fb.group({
      type: [this.remoteForm?.get('type')?.value || '', Validators.required],
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
    const group: Record<string, unknown> = {};
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

    // Add profile selectors only for main operation types
    const isMainOp =
      fields.includes('source') || fields.includes('dest') || fields.includes('autoStart');
    const isSharedConfig = !isMainOp;

    if (includeProfiles && !isSharedConfig) {
      group['vfsProfile'] = [DEFAULT_PROFILE_NAME];
      group['filterProfile'] = [DEFAULT_PROFILE_NAME];
      group['backendProfile'] = [DEFAULT_PROFILE_NAME];
      group['runtimeRemoteProfile'] = [DEFAULT_PROFILE_NAME];
    }

    group['options'] = this.fb.group({});
    return this.fb.group(group);
  }

  private refreshRemoteNameValidator(): void {
    const nameCtrl = this.remoteForm?.get('name');
    if (nameCtrl) {
      const isEdit = this.editTarget() === 'remote';
      const isClone = isEdit && this.cloneTarget();

      nameCtrl.setValidators([
        Validators.required,
        Validators.pattern(REMOTE_NAME_REGEX),
        ...(isEdit && !isClone
          ? []
          : [this.validatorRegistry.createRemoteNameValidator(this.existingRemotes())]),
      ]);
      nameCtrl.updateValueAndValidity({ onlySelf: true, emitEvent: false });
    }
  }

  // ============================================================================
  // FORM SETUP & LISTENERS
  // ============================================================================
  private setupAutoStartValidators(): void {
    if (this.editTarget() === 'remote' || !this.editTarget() || this.cloneTarget()) {
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
          autoStartControl?.valueChanges
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(enabled => {
              if (enabled) {
                const validator = this.validatorRegistry.getValidator('crossPlatformPath');
                destControl?.setValidators([
                  Validators.required,
                  ...(validator ? [validator] : []),
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

          autoStartControl?.valueChanges.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
            sourcePathControl?.updateValueAndValidity();
            destPathControl?.updateValueAndValidity();
          });
          sourcePathTypeControl?.valueChanges
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(() => {
              sourcePathControl?.updateValueAndValidity();
            });
          destPathTypeControl?.valueChanges
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(() => {
              destPathControl?.updateValueAndValidity();
            });
        }
      });
    }
  }

  private setupAuthStateListeners(): void {
    // Sync local form state with auth progress
    effect(() => {
      const isInProgress = this.authStateService.isAuthInProgress();
      untracked(() => {
        this.setFormState(isInProgress);
      });
    });
  }

  // ============================================================================
  // FORM POPULATION
  // ============================================================================
  private populateFormIfEditingOrCloning(): void {
    if (!this.dialogData?.existingConfig) return;

    if (this.editTarget() === 'remote' || this.cloneTarget()) {
      const remoteSpecs = this.cloneTarget()
        ? this.dialogData.existingConfig['config']
        : this.dialogData.existingConfig;
      this.populateRemoteForm(remoteSpecs);

      if (this.cloneTarget()) {
        // Populate all supported types (flags + serve)
        this.FLAG_TYPES.forEach(type => {
          const configKey = REMOTE_CONFIG_KEYS[
            type as keyof typeof REMOTE_CONFIG_KEYS
          ] as keyof RemoteConfigSections;
          const configs = this.dialogData.existingConfig?.[configKey] as
            | Record<string, unknown>
            | undefined;

          if (configs && Object.keys(configs).length > 0) {
            // Cloning: Take the first available config/profile
            const firstKey = Object.keys(configs)[0];
            const firstConfig = configs[firstKey];
            void this.populateProfileForm(type, firstConfig as Record<string, unknown>);
          }
        });

        const runtimeRemoteConfigs = this.dialogData.existingConfig?.[
          REMOTE_CONFIG_KEYS.runtimeRemote
        ] as Record<string, unknown> | undefined;
        if (runtimeRemoteConfigs && Object.keys(runtimeRemoteConfigs).length > 0) {
          const firstKey = Object.keys(runtimeRemoteConfigs)[0];
          const firstConfig = runtimeRemoteConfigs[firstKey];
          void this.populateProfileForm('runtimeRemote', firstConfig as Record<string, unknown>);
        }
      }
    } else if (this.editTarget()) {
      const type = this.editTarget() as SharedProfileType;
      const profileName = this.selectedProfileName()[type];
      const profile = this.profiles()[type]?.[profileName] as Record<string, unknown>;

      if (type === 'runtimeRemote') {
        const remoteType =
          this.dialogData?.remoteType ||
          (Object.values(
            this.profiles()['runtimeRemote'] as Record<string, Record<string, unknown>>
          ).find(p => p?.['type'])?.['type'] as string) ||
          '';
        this.remoteForm.get('type')?.setValue(remoteType, { emitEvent: false });
      }

      if (profile) {
        void this.populateProfileForm(type, profile);
      }
    }

    if (this.cloneTarget()) {
      this.generateNewCloneName();
    }
  }

  private async populateRemoteForm(config: Record<string, unknown>): Promise<void> {
    this.isPopulatingForm = true;
    this.remoteForm.patchValue({ name: config['name'], type: config['type'] });
    await this.onRemoteTypeChange();
    this.remoteForm.patchValue(config);
    // Use setTimeout to ensure all async value change events have fired
    setTimeout(() => {
      this.isPopulatingForm = false;
    }, 100);
  }

  private async populateProfileForm(
    type: SharedProfileType,
    config: Record<string, unknown>
  ): Promise<void> {
    this.isPopulatingForm = true;
    const group = this.remoteConfigForm.get(`${type}Config`);
    if (!group) {
      this.isPopulatingForm = false;
      return;
    }

    if (type === 'serve') {
      const serveConfig = config;
      const options = (serveConfig?.['options'] as Record<string, unknown>) || {};
      const serveType = (options?.['type'] as string) || 'http';
      this.selectedServeType.set(serveType);
      await this.loadServeFields();

      group.patchValue({
        autoStart: serveConfig['autoStart'] || false,
        source: parseFsString(
          (serveConfig['source'] as string) || '',
          'currentRemote',
          this.getRemoteName(),
          this.existingRemotes()
        ),
        type: serveType,
        vfsProfile: serveConfig['vfsProfile'] || DEFAULT_PROFILE_NAME,
        filterProfile: serveConfig['filterProfile'] || DEFAULT_PROFILE_NAME,
        backendProfile: serveConfig['backendProfile'] || DEFAULT_PROFILE_NAME,
        runtimeRemoteProfile: serveConfig['runtimeRemoteProfile'] || DEFAULT_PROFILE_NAME,
      });

      if (options) {
        const optionsGroup = group.get('options') as FormGroup;
        if (optionsGroup) {
          Object.entries(options).forEach(([key, value]) => {
            if (key !== 'type' && key !== 'fs') {
              const control = optionsGroup.get(key);
              if (control) control.setValue(value, { emitEvent: false });
            }
          });
        }
      }
    } else if (type === 'runtimeRemote') {
      const options = (config['options'] as Record<string, unknown>) || {};
      const runtimeType =
        String(this.remoteForm.get('type')?.value || '').trim() ||
        (options['type'] as string) ||
        (config['type'] as string) ||
        '';

      group.get('type')?.setValue(runtimeType, { emitEvent: false });
      await this.loadRuntimeRemoteFields(runtimeType);

      this.dynamicRuntimeRemoteFields.forEach(field => {
        const value =
          options[field.FieldName] ?? options[field.Name] ?? field.Value ?? field.Default;
        group.get(field.Name)?.setValue(value, { emitEvent: false });
      });
    } else {
      // Flag types
      const flagType = type as FlagType;
      const hasActualData = Object.keys(config).some(k => k !== 'name');

      const patchData: any = {
        autoStart: config['autoStart'] || false,
        cronEnabled: config['cronEnabled'] || false,
        cronExpression: config['cronExpression'] ?? null,
        vfsProfile: config['vfsProfile'] || DEFAULT_PROFILE_NAME,
        filterProfile: config['filterProfile'] || DEFAULT_PROFILE_NAME,
        backendProfile: config['backendProfile'] || DEFAULT_PROFILE_NAME,
        runtimeRemoteProfile: config['runtimeRemoteProfile'] || DEFAULT_PROFILE_NAME,
      };

      if (flagType === 'mount' && config['type'] !== undefined) patchData.type = config['type'];

      if (config['source'] !== undefined) {
        patchData.source = parseFsString(
          config['source'] as string,
          'currentRemote',
          this.getRemoteName(),
          this.existingRemotes()
        );
      }

      if (config['dest'] !== undefined) {
        if (flagType === 'mount') {
          patchData.dest = config['dest'];
        } else {
          patchData.dest = parseFsString(
            config['dest'] as string,
            'local',
            this.getRemoteName(),
            this.existingRemotes()
          );
        }
      }

      group.patchValue(patchData);

      const optionsGroup = group.get('options') as FormGroup;
      if (optionsGroup && this.dynamicFlagFields[flagType]) {
        if (hasActualData) {
          this.dynamicFlagFields[flagType].forEach(field => {
            const controlKey = this.getUniqueControlKey(flagType, field);
            const control = optionsGroup.get(controlKey);
            if (control) control.setValue(field.Default ?? null);
          });
        }
        if (config['options']) {
          Object.entries(config['options'] as Record<string, unknown>).forEach(
            ([fieldName, value]) => {
              const field = this.dynamicFlagFields[flagType].find(f => f.FieldName === fieldName);
              if (field) {
                const controlKey = this.getUniqueControlKey(flagType, field);
                const control = optionsGroup.get(controlKey);
                if (control) control.setValue(value);
              }
            }
          );
        }
      }
    }

    setTimeout(() => {
      this.isPopulatingForm = false;
    }, 100);
  }

  // Helper to generate a new name for a cloned remote
  private generateNewCloneName(): void {
    const baseName = this.remoteForm.get('name')?.value;
    if (!baseName) return;

    let newName = `${baseName}-clone`;
    let counter = 1;
    while (this.existingRemotes().includes(newName)) {
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
    const serveConfigs = this.dialogData?.existingConfig?.[REMOTE_CONFIG_KEYS.serve] as
      | Record<string, ServeConfig>
      | undefined;
    return serveConfigs !== undefined && Object.keys(serveConfigs).length > 0;
  }

  get savedType(): string {
    const serveConfigs = this.dialogData?.existingConfig?.[REMOTE_CONFIG_KEYS.serve] as
      | Record<string, ServeConfig>
      | undefined;
    if (!serveConfigs) return 'http';
    const firstKey = Object.keys(serveConfigs)[0];
    const firstConfig = firstKey ? serveConfigs[firstKey] : undefined;
    return (firstConfig?.options?.type as string) || 'http';
  }

  currentTotalSteps = computed(() => this.TOTAL_STEPS);

  // Step icons mapping - accessed directly in template via stepIcons()[i]
  stepIcons = computed<Record<number, string>>(() => {
    return Object.fromEntries(this.stepConfigs().map((s, i) => [i, s.icon]));
  });

  goToStep(step: number): void {
    if (this.isAuthInProgress()) return;

    this.saveCurrentStepProfile();
    this.currentStep.set(step);
    this.scrollToTop();
  }

  applicableSteps = computed(() => {
    const editTargetValue = this.editTarget();
    if (!editTargetValue || editTargetValue === 'remote') {
      return Array.from({ length: this.TOTAL_STEPS }, (_, i) => i + 1);
    }

    const index = this.stepConfigs().findIndex(s => s.type === editTargetValue);
    return index !== -1 ? [index + 1] : [1];
  });

  nextStep(): void {
    const steps = this.applicableSteps();
    const currentIndex = steps.indexOf(this.currentStep());
    if (currentIndex !== -1 && currentIndex < steps.length - 1) {
      this.goToStep(steps[currentIndex + 1]);
    }
  }

  prevStep(): void {
    const steps = this.applicableSteps();
    const currentIndex = steps.indexOf(this.currentStep());
    if (currentIndex > 0) {
      this.goToStep(steps[currentIndex - 1]);
    }
  }

  getStepState(stepNumber: number): 'completed' | 'current' | 'future' {
    if (stepNumber < this.currentStep()) return 'completed';
    if (stepNumber === this.currentStep()) return 'current';
    return 'future';
  }

  handleStepKeydown(event: KeyboardEvent): void {
    if (!this.editTarget()) return;

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
    const remoteType = this.remoteForm.get('type')?.value;
    this.useInteractiveMode.set(INTERACTIVE_REMOTES.includes(remoteType?.toLowerCase()));
    await this.loadRemoteFields(remoteType);
    await this.syncRuntimeRemoteType();
  }

  private async loadRemoteFields(type: string): Promise<void> {
    this.isRemoteConfigLoading.set(true);
    this.dynamicRemoteFields = [];
    try {
      this.dynamicRemoteFields = await this.remoteManagementService.getRemoteConfigFields(type);
      this.replaceDynamicFormControls();
    } catch (error) {
      console.error('Error loading remote config fields:', error);
    } finally {
      this.isRemoteConfigLoading.set(false);
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
    this.useInteractiveMode.set(useInteractiveMode);
  }

  onAdvancedOptionsToggled(show: boolean): void {
    this.showAdvancedOptions.set(show);
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
    // Mount dest folder should be empty unless AllowNonEmpty is enabled
    let requireEmpty = false;
    if (flagType === 'mount') {
      const allowNonEmpty =
        this.remoteConfigForm.get('mountConfig.options')?.value?.['mount---allow_non_empty'];
      requireEmpty = !allowNonEmpty;
    }

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
    } else if (this.editTarget() === 'remote') {
      if (this.changedRemoteFields.has(fieldName)) return;
      this.changedRemoteFields.add(fieldName);
    } else {
      this.changedRemoteFields.delete(fieldName);
    }
  }

  // --- Interactive Flow ---
  handleInteractiveAnswerUpdate(newAnswer: string | number | boolean | null): void {
    if (this.interactiveFlowState().isActive) {
      this.interactiveFlowState.update(s => ({ ...s, answer: newAnswer }));
    }
  }

  // ============================================================================
  // FORM SUBMISSION
  // ============================================================================
  async onSubmit(): Promise<void> {
    if (this.isAuthInProgress()) return;

    try {
      const result = this.editTarget()
        ? await this.handleEditMode()
        : await this.handleCreateMode();
      if (result.success && !this.isAuthCancelled()) this.close();
    } catch (error) {
      console.error('Submission error:', error);
    } finally {
      this.authStateService.resetAuthState();
    }
  }

  private async handleCreateMode(): Promise<{ success: boolean }> {
    // Ensure all current profiles are saved before building final config
    PROFILE_TYPES.forEach(type => {
      this.saveCurrentProfile(type);
    });

    const remoteData = this.cleanFormData(this.remoteForm.getRawValue());
    const finalConfig = this.buildFinalConfig();

    await this.authStateService.startAuth(remoteData.name, false);

    if (!this.useInteractiveMode()) {
      await this.remoteManagementService.createRemote(remoteData.name, remoteData, {
        obscure: true,
      });
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

    if (this.editTarget() === 'remote' && this.useInteractiveMode()) {
      const remoteData = this.cleanFormData(this.remoteForm.getRawValue());
      this.pendingConfig = { remoteData, finalConfig: this.createEmptyFinalConfig() };
      return await this.startInteractiveRemoteConfig(remoteData);
    }

    if (this.editTarget() === 'remote') {
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
    // Ensure current step's profile is saved before building final config
    this.saveCurrentStepProfile();

    const currentProfiles = this.profiles();
    return {
      [REMOTE_CONFIG_KEYS.mount]: currentProfiles['mount'] as Record<string, MountConfig>,
      [REMOTE_CONFIG_KEYS.copy]: currentProfiles['copy'] as Record<string, CopyConfig>,
      [REMOTE_CONFIG_KEYS.sync]: currentProfiles['sync'] as Record<string, SyncConfig>,
      [REMOTE_CONFIG_KEYS.bisync]: currentProfiles['bisync'] as Record<string, BisyncConfig>,
      [REMOTE_CONFIG_KEYS.move]: currentProfiles['move'] as Record<string, MoveConfig>,
      [REMOTE_CONFIG_KEYS.serve]: currentProfiles['serve'] as unknown as Record<
        string,
        ServeConfig
      >,
      [REMOTE_CONFIG_KEYS.filter]: currentProfiles['filter'] as Record<string, FilterConfig>,
      [REMOTE_CONFIG_KEYS.vfs]: currentProfiles['vfs'] as Record<string, VfsConfig>,
      [REMOTE_CONFIG_KEYS.backend]: currentProfiles['backend'] as Record<string, BackendConfig>,
      [REMOTE_CONFIG_KEYS.runtimeRemote]: currentProfiles['runtimeRemote'] as Record<
        string,
        RuntimeRemoteConfig
      >,
      showOnTray: true,
    };
  }

  // ============================================================================
  // PROFILE MANAGEMENT
  // ============================================================================
  saveCurrentStepProfile(): void {
    const current = this.currentStep();
    const type = this.stepConfigs()[current - 1]?.type;
    if (type && type !== 'remote') {
      this.saveCurrentProfile(type);
    }
  }

  startAddProfile(type: SharedProfileType): void {
    const existingNames = Object.keys(this.profiles()[type] || {});
    let counter = 1;
    while (existingNames.includes(`profile-${counter}`)) {
      counter++;
    }
    const newName = `profile-${counter}`;
    this.setProfileMode(type, 'add', newName);
  }

  startEditProfile(type: SharedProfileType): void {
    const currentName = this.getSelectedProfile(type);
    if (!currentName || currentName.toLowerCase() === DEFAULT_PROFILE_NAME) return;
    this.setProfileMode(type, 'edit', currentName);
  }

  cancelProfileEdit(type: SharedProfileType): void {
    this.setProfileMode(type, 'view');
  }

  saveProfile(type: SharedProfileType): void {
    const state = this.profileState()[type];
    const newName = state.tempName.trim();
    if (!newName) return;

    if (state.mode === 'add') {
      this.profiles.update(p => ({
        ...p,
        [type]: { ...p[type], [newName]: {} },
      }));
      this.selectProfile(type, newName);
    } else if (state.mode === 'edit') {
      const oldName = this.getSelectedProfile(type);
      if (oldName === newName) {
        this.cancelProfileEdit(type);
        return;
      }
      if (this.profiles()[type][newName] !== undefined) return;

      const profileData = this.profiles()[type][oldName];
      this.profiles.update(p => {
        const updated = { ...p, [type]: { ...p[type], [newName]: profileData } };
        delete updated[type][oldName];
        return updated;
      });
      this.selectedProfileName.update(s => ({ ...s, [type]: newName }));
      this.cascadeProfileRename(type, oldName, newName);
    }
    this.setProfileMode(type, 'view');
  }

  deleteProfile(type: SharedProfileType, name: string): void {
    if (name.toLowerCase() === DEFAULT_PROFILE_NAME) return;

    const remoteName = this.getRemoteName();
    if (remoteName) {
      const usage = this.getProfileUsage(type, remoteName, name);
      if (usage.inUse) {
        this.notificationService.showWarning(
          this.translate.instant('modals.remoteConfig.profile.inUseWarning', {
            name,
            count: usage.count,
            type: usage.opType,
          })
        );
        return;
      }
    }

    this.profiles.update(p => {
      const updated = { ...p };
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [name]: _removed, ...rest } = updated[type];
      updated[type] = rest;
      return updated;
    });

    if (this.selectedProfileName()[type] === name) {
      const remainingNames = Object.keys(this.profiles()[type]);
      if (remainingNames.length > 0) {
        this.selectProfile(type, remainingNames[0]);
      } else {
        this.profiles.update(p => ({ ...p, [type]: { [DEFAULT_PROFILE_NAME]: {} } }));
        this.selectProfile(type, DEFAULT_PROFILE_NAME);
      }
    }
  }

  selectProfile(type: SharedProfileType, name: string): void {
    if (!this.profiles()[type]?.[name]) return;
    this.saveCurrentProfile(type);
    const profileData = this.profiles()[type][name];
    void this.populateProfileForm(type, profileData as Record<string, unknown>);
  }

  saveCurrentProfile(type: SharedProfileType): void {
    const currentName = this.selectedProfileName()[type];
    if (!this.profiles()[type]?.[currentName]) return;

    const formValue = this.remoteConfigForm.get(`${type}Config`)?.getRawValue();
    if (!formValue) return;

    const builtConfig = this.buildProfileConfig(type, this.getRemoteName(), formValue);

    this.profiles.update(p => ({
      ...p,
      [type]: { ...p[type], [currentName]: builtConfig },
    }));
  }

  getProfiles(type: SharedProfileType): { name: string; [key: string]: unknown }[] {
    return Object.entries(this.profiles()[type] || {}).map(([name, data]) => ({
      name,
      ...data,
    }));
  }

  getSelectedProfile(type: SharedProfileType): string {
    return this.selectedProfileName()[type];
  }

  getProfileOptions(type: 'vfs' | 'filter' | 'backend' | 'runtimeRemote'): string[] {
    if (type === 'runtimeRemote') {
      const profileNames = Object.keys(this.profiles()['runtimeRemote'] || {});
      return profileNames.length > 0 ? profileNames : [DEFAULT_PROFILE_NAME];
    }

    return Object.keys(this.profiles()[type] || {});
  }

  private buildProfileConfig(type: SharedProfileType, remoteName: string, configData: any): any {
    if (type === 'serve') {
      const fs = buildPathString(configData['source'] as string, remoteName);
      const serveOptions = this.cleanServeOptions(
        (configData['options'] as Record<string, unknown>) || {}
      );

      return {
        autoStart: configData['autoStart'] as boolean,
        source: fs,
        vfsProfile: configData['vfsProfile'] || DEFAULT_PROFILE_NAME,
        filterProfile: configData['filterProfile'] || DEFAULT_PROFILE_NAME,
        backendProfile: configData['backendProfile'] || DEFAULT_PROFILE_NAME,
        runtimeRemoteProfile: configData['runtimeRemoteProfile'] || DEFAULT_PROFILE_NAME,
        options: {
          type: configData['type'],
          fs: fs,
          ...serveOptions,
        },
      };
    }

    if (type === 'runtimeRemote') {
      const options = this.dynamicRuntimeRemoteFields.reduce(
        (acc, field) => {
          if (!Object.prototype.hasOwnProperty.call(configData, field.Name)) return acc;
          const value = configData[field.Name];
          if (!this.isDefaultValue(value, field)) {
            acc[field.FieldName || field.Name] = value;
          }
          return acc;
        },
        {} as Record<string, unknown>
      );

      return { options };
    }

    // Flag types
    const result: any = {};
    for (const key in configData) {
      if (key === 'source' || key === 'dest') {
        result[key] = buildPathString(configData[key], remoteName);
      } else {
        result[key] = configData[key];
      }
    }

    const isMainOp = ['mount', 'sync', 'copy', 'move', 'bisync'].includes(type);

    if (isMainOp) {
      const runtimeRemoteOptions = this.getProfileOptions('runtimeRemote');
      const selectedRuntimeRemoteProfile = String(result.runtimeRemoteProfile || '').trim();
      result.runtimeRemoteProfile = runtimeRemoteOptions.includes(selectedRuntimeRemoteProfile)
        ? selectedRuntimeRemoteProfile
        : DEFAULT_PROFILE_NAME;
    } else {
      // Shared config: filter, vfs, backend
      delete result.vfsProfile;
      delete result.filterProfile;
      delete result.backendProfile;
      delete result.runtimeRemoteProfile;
    }

    result.options = this.cleanData(
      configData.options,
      this.dynamicFlagFields[type as FlagType],
      type as FlagType
    );
    return result;
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

  private getFieldsForFlagType(type: string): string[] {
    switch (type) {
      case 'mount':
        return ['autoStart', 'dest', 'source', 'type'];
      case 'sync':
      case 'copy':
      case 'move':
      case 'bisync':
        return ['autoStart', 'cronEnabled', 'cronExpression', 'source', 'dest'];
      default:
        return [];
    }
  }

  private createEmptyFinalConfig(): RemoteConfigSections {
    return {
      [REMOTE_CONFIG_KEYS.mount]: {},
      [REMOTE_CONFIG_KEYS.copy]: {},
      [REMOTE_CONFIG_KEYS.sync]: {},
      [REMOTE_CONFIG_KEYS.bisync]: {},
      [REMOTE_CONFIG_KEYS.move]: {},
      [REMOTE_CONFIG_KEYS.serve]: {},
      [REMOTE_CONFIG_KEYS.filter]: {},
      [REMOTE_CONFIG_KEYS.vfs]: {},
      [REMOTE_CONFIG_KEYS.backend]: {},
      [REMOTE_CONFIG_KEYS.runtimeRemote]: {},
      showOnTray: true,
    };
  }

  private buildUpdateConfig(): Promise<Record<string, unknown>> {
    const updatedConfig: Record<string, unknown> = {};

    if (this.editTarget() && this.editTarget() !== 'remote') {
      const target = this.editTarget() as SharedProfileType;

      if (target !== 'runtimeRemote') {
        // Save current profile to state first
        this.saveCurrentProfile(target);
        // Save the whole profiles array
        const configKey = REMOTE_CONFIG_KEYS[target as keyof typeof REMOTE_CONFIG_KEYS];
        if (configKey) {
          updatedConfig[configKey] = this.profiles()[target];
        }
      } else {
        this.saveCurrentProfile(target);
        updatedConfig[REMOTE_CONFIG_KEYS.runtimeRemote] = this.profiles()[target];
      }

      updatedConfig[REMOTE_CONFIG_KEYS.runtimeRemote] = this.profiles()['runtimeRemote'];
    }

    return Promise.resolve(updatedConfig);
  }

  // ============================================================================
  // DATA CLEANING
  // ============================================================================
  private cleanFormData(formData: Record<string, unknown>): PendingRemoteData {
    const result: PendingRemoteData = {
      name: formData['name'] as string,
      type: formData['type'] as string,
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
    formData: Record<string, unknown>,
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

  private isDefaultValue(value: unknown, field: RcConfigOption): boolean {
    return (
      String(value) === String(field.Default) ||
      String(value) === String(field.DefaultStr) ||
      value === null
    );
  }

  // ============================================================================
  // INTERACTIVE FLOW
  // ============================================================================
  onInteractiveContinue(answer: string | number | boolean | null): void {
    const currentState = this.interactiveFlowState();
    if (currentState.isProcessing) return;

    this.interactiveFlowState.update(s => ({ ...s, isProcessing: true, answer: String(answer) }));
    void this.processInteractiveResponse(String(answer));
  }

  private async startInteractiveRemoteConfig(
    remoteData: PendingRemoteData
  ): Promise<{ success: boolean }> {
    this.interactiveFlowState.set({
      isActive: true,
      isProcessing: true,
      question: null,
      answer: '',
    });
    const { name, type, ...paramRest } = remoteData;
    const startResp = await this.remoteManagementService.startRemoteConfigInteractive(
      name,
      type || '',
      paramRest,
      { nonInteractive: true, obscure: true }
    );

    if (!startResp || startResp.State === '') {
      await this.finalizeRemoteCreation();
      return { success: true };
    }

    this.interactiveFlowState.set({
      isActive: true,
      question: startResp,
      answer: getDefaultAnswerFromQuestion(startResp),
      isProcessing: false,
    });

    return { success: false };
  }

  private async processInteractiveResponse(answer: string): Promise<void> {
    try {
      const state = this.interactiveFlowState();
      if (!state.isActive || !state.question || !this.pendingConfig) return;

      const { name, ...paramRest } = this.pendingConfig.remoteData;
      let processedAnswer: unknown = answer;

      if (state.question?.Option?.Type === 'bool') {
        processedAnswer = convertBoolAnswerToString(answer);
      }

      const resp = await this.remoteManagementService.continueRemoteConfigNonInteractive(
        name,
        state.question.State,
        processedAnswer,
        paramRest,
        { nonInteractive: true }
      );

      if (!resp || resp.State === '') {
        this.interactiveFlowState.set(createInitialInteractiveFlowState());
        await this.finalizeRemoteCreation();
      } else {
        this.interactiveFlowState.update(s => ({
          ...s,
          question: resp,
          answer: getDefaultAnswerFromQuestion(resp),
          isProcessing: false,
        }));
      }
    } catch (error) {
      console.error('Error processing interactive response:', error);
      this.interactiveFlowState.update(s => ({ ...s, isProcessing: false }));
      this.notificationService.showError('Failed to process interactive response');
    }
  }

  isInteractiveContinueDisabled(): boolean {
    const state = this.interactiveFlowState();
    const answerValue = state.answer;
    return (
      state.isProcessing ||
      (state.question?.Option?.Type !== 'password' &&
        (answerValue === null || answerValue === undefined || String(answerValue).trim() === '')) ||
      this.isAuthCancelled()
    );
  }

  // ============================================================================
  // FINALIZATION & POST-SUBMIT
  // ============================================================================
  private async finalizeRemoteCreation(): Promise<void> {
    if (!this.pendingConfig) return;

    const { remoteData, finalConfig } = this.pendingConfig;
    this.interactiveFlowState.set(createInitialInteractiveFlowState());

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
    const mountConfigs = finalConfig[REMOTE_CONFIG_KEYS.mount];
    const copyConfigs = finalConfig[REMOTE_CONFIG_KEYS.copy];
    const syncConfigs = finalConfig[REMOTE_CONFIG_KEYS.sync];
    const bisyncConfigs = finalConfig[REMOTE_CONFIG_KEYS.bisync];
    const moveConfigs = finalConfig[REMOTE_CONFIG_KEYS.move];
    const serveConfigs = finalConfig[REMOTE_CONFIG_KEYS.serve];

    // Use profile-based methods - backend resolves all options from saved config
    // This is simpler and ensures consistency with tray actions

    // Mount operations
    if (mountConfigs) {
      for (const [profileName, config] of Object.entries(mountConfigs)) {
        if (config.autoStart && config.dest) {
          void this.mountManagementService.mountRemoteProfile(remoteName, profileName);
        }
      }
    }

    // Copy operations
    if (copyConfigs) {
      for (const [profileName, config] of Object.entries(copyConfigs)) {
        if (config.autoStart && config.source && config.dest) {
          void this.jobManagementService.startCopyProfile(remoteName, profileName);
        }
      }
    }

    // Sync operations
    if (syncConfigs) {
      for (const [profileName, config] of Object.entries(syncConfigs)) {
        if (config.autoStart && config.source && config.dest) {
          void this.jobManagementService.startSyncProfile(remoteName, profileName);
        }
      }
    }

    // Bisync operations
    if (bisyncConfigs) {
      for (const [profileName, config] of Object.entries(bisyncConfigs)) {
        if (config.autoStart && config.source && config.dest) {
          void this.jobManagementService.startBisyncProfile(remoteName, profileName);
        }
      }
    }

    // Move operations
    if (moveConfigs) {
      for (const [profileName, config] of Object.entries(moveConfigs)) {
        if (config.autoStart && config.source && config.dest) {
          void this.jobManagementService.startMoveProfile(remoteName, profileName);
        }
      }
    }

    // Serve operations
    if (serveConfigs) {
      for (const [profileName, config] of Object.entries(serveConfigs)) {
        if (config.autoStart && config.options) {
          void this.serveManagementService.startServeProfile(remoteName, profileName);
        }
      }
    }
  }

  async cancelAuth(): Promise<void> {
    await this.authStateService.cancelAuth();
    this.interactiveFlowState.set(createInitialInteractiveFlowState());
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
  private cascadeProfileRename(type: SharedProfileType, oldName: string, newName: string): void {
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
      renameHandlers[type] = (): Promise<number> =>
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
    type: SharedProfileType,
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
  private setProfileMode(
    type: SharedProfileType,
    mode: 'view' | 'edit' | 'add',
    tempName = ''
  ): void {
    this.profileState.update(state => ({
      ...state,
      [type]: { mode, tempName },
    }));
  }

  public getProfileState(type: string): { mode: 'view' | 'edit' | 'add'; tempName: string } {
    const key = type as SharedProfileType;
    // Ensure we return a valid state object even if key is somehow off, though it shouldn't be
    return this.profileState()[key] || { mode: 'view', tempName: '' };
  }

  public setProfileTempName(type: string, name: string): void {
    const key = type as SharedProfileType;
    this.profileState.update(state => ({
      ...state,
      [key]: { ...state[key], tempName: name },
    }));
  }

  setFormState(disabled: boolean): void {
    if (disabled) {
      this.remoteForm.disable();
      this.remoteConfigForm.disable();
    } else {
      if (this.editTarget() === 'remote' && !this.cloneTarget()) {
        this.remoteForm.enable({ emitEvent: false });
        this.remoteForm.get('name')?.disable({ emitEvent: false });
        this.remoteForm.get('type')?.disable({ emitEvent: false });
      } else {
        this.remoteForm.enable();
      }
      this.remoteConfigForm.enable();
    }
  }

  isSaveDisabled = computed(() => {
    if (this.isAuthInProgress()) return true;

    // Access status signals to ensure reactivity
    const remoteStatus = this.remoteFormStatus();
    const configStatus = this.remoteConfigFormStatus();

    const editTargetValue = this.editTarget();
    if (editTargetValue) {
      if (editTargetValue === 'remote') return remoteStatus === 'INVALID';
      // Both serve and flag types use the same pattern
      return this.remoteConfigForm.get(`${editTargetValue}Config`)?.invalid;
    }

    return remoteStatus === 'INVALID' || configStatus === 'INVALID';
  });

  saveButtonLabel = computed(() => {
    return this.isAuthInProgress() && !this.isAuthCancelled()
      ? 'modals.remoteConfig.buttons.saving'
      : this.editTarget()
        ? 'modals.remoteConfig.buttons.saveChanges'
        : 'modals.remoteConfig.buttons.save';
  });

  // ============================================================================
  // SEARCH FUNCTIONALITY
  // ============================================================================
  toggleSearchVisibility(): void {
    this.isSearchVisible.update(visible => !visible);
    if (!this.isSearchVisible()) {
      this.searchQuery.set('');
    }
  }

  onSearchInput(searchText: string): void {
    this.searchQuery.set(searchText);
  }

  @HostListener('window:keydown', ['$event'])
  handleSearchKeyboard(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key === 'f') {
      event.preventDefault();
      this.toggleSearchVisibility();
    }
  }

  @HostListener('document:keydown.escape')
  close(): void {
    if (this.nautilusService.isNautilusOverlayOpen()) {
      return;
    }
    this.modalService.animatedClose(this.dialogRef);
  }
}
