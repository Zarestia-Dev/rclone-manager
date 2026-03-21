import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  HostListener,
  inject,
  OnInit,
  signal,
  effect,
  untracked,
  Signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { startWith } from 'rxjs';
import { NgTemplateOutlet, TitleCasePipe } from '@angular/common';
import {
  FormBuilder,
  FormGroup,
  Validators,
  FormControl,
  FormsModule,
  ReactiveFormsModule,
  AbstractControl,
} from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { MatListModule } from '@angular/material/list';
import { MatDividerModule } from '@angular/material/divider';
import { RemoteConfigStepComponent } from '../../../../shared/remote-config/remote-config-step/remote-config-step.component';
import { FlagConfigStepComponent } from '../../../../shared/remote-config/flag-config-step/flag-config-step.component';
import { SearchContainerComponent } from '../../../../shared/components/search-container/search-container.component';
import { InteractiveConfigStepComponent } from 'src/app/shared/remote-config/interactive-config-step/interactive-config-step.component';
import {
  AuthStateService,
  ValidatorRegistryService,
  FlagConfigService,
  RemoteManagementService,
  JobManagementService,
  MountManagementService,
  AppSettingsService,
  FileSystemService,
  ServeManagementService,
  NautilusService,
  ModalService,
  NotificationService,
  IconService,
} from '@app/services';
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
import {
  buildPathString,
  getDefaultAnswerFromQuestion,
  createInitialInteractiveFlowState,
  convertBoolAnswerToString,
  parseFsString,
} from '../../../../services/remote/utils/remote-config.utils';
import { MatExpansionModule } from '@angular/material/expansion';

// ============================================================================
// TYPES
// ============================================================================
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

/** Operation types managed by jobManagementService (extracted from repeated inline arrays) */
const JOB_TYPES = new Set(['sync', 'copy', 'bisync', 'move']);

@Component({
  selector: 'app-remote-config-modal',
  standalone: true,
  imports: [
    TitleCasePipe,
    NgTemplateOutlet,
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
    MatListModule,
    MatDividerModule,
    RemoteConfigStepComponent,
    FlagConfigStepComponent,
    InteractiveConfigStepComponent,
    SearchContainerComponent,
  ],
  templateUrl: './remote-config-modal.component.html',
  styleUrls: ['./remote-config-modal.component.scss', '../../../../styles/_shared-modal.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RemoteConfigModalComponent implements OnInit {
  // ============================================================================
  // INJECTIONS
  // ============================================================================
  private readonly fb = inject(FormBuilder);
  private readonly dialogRef = inject(MatDialogRef<RemoteConfigModalComponent>);
  private readonly authStateService = inject(AuthStateService);
  private readonly remoteManagementService = inject(RemoteManagementService);
  private readonly jobManagementService = inject(JobManagementService);

  readonly configStep = viewChild(RemoteConfigStepComponent);
  private readonly mountManagementService = inject(MountManagementService);
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly fileSystemService = inject(FileSystemService);
  private readonly validatorRegistry = inject(ValidatorRegistryService);
  private readonly dialogData = inject(MAT_DIALOG_DATA, { optional: true }) as DialogData;
  private readonly serveManagementService = inject(ServeManagementService);
  readonly flagConfigService = inject(FlagConfigService);
  readonly iconService = inject(IconService);
  private readonly nautilusService = inject(NautilusService);
  private readonly notificationService = inject(NotificationService);
  private readonly translate = inject(TranslateService);
  private readonly modalService = inject(ModalService);
  private readonly destroyRef = inject(DestroyRef);

  // ============================================================================
  // CONFIGURATION (static, exposed to template)
  // ============================================================================
  readonly TOTAL_STEPS = 11;
  readonly FLAG_TYPES = FLAG_TYPES;

  readonly stepConfigs = computed(() => {
    const remoteType = this.remoteTypeSignal();
    const remoteIcon = this.iconService.getIconName(remoteType || 'hard-drive');
    return [
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
  });

  /** Derived labels list — computed so no new array is created every CD cycle (was a getter). */
  readonly stepLabels = computed(() => this.stepConfigs().map(s => s.label));

  // ============================================================================
  // FORMS
  // ============================================================================
  remoteForm!: FormGroup;
  remoteConfigForm!: FormGroup;

  /**
   * Form status signals via toSignal — replaces manual statusChanges subscriptions +
   * WritableSignal pair. toSignal shares the same reactive graph so computed signals
   * that read these will re-evaluate whenever the form validity changes.
   */
  remoteFormStatus!: Signal<string>;
  remoteConfigFormStatus!: Signal<string>;
  remoteTypeSignal!: Signal<string>;

  // ============================================================================
  // STATE SIGNALS
  // ============================================================================
  remoteTypes = signal<RemoteType[]>([]);
  existingRemotes = signal<string[]>([]);
  mountTypes = signal<string[]>([]);
  availableServeTypes = signal<string[]>([]);
  selectedServeType = signal('http');

  /**
   * Dynamic field arrays converted to signals — required for zoneless Angular
   * (OnPush + no Zone.js). Plain class properties are invisible to the signal graph
   * and won't trigger re-renders when mutated.
   */
  dynamicRemoteFields = signal<RcConfigOption[]>([]);
  dynamicServeFields = signal<RcConfigOption[]>([]);
  dynamicRuntimeRemoteFields = signal<RcConfigOption[]>([]);
  dynamicFlagFields = signal<Record<FlagType, RcConfigOption[]>>(
    Object.fromEntries(FLAG_TYPES.map(t => [t, [] as RcConfigOption[]])) as Record<
      FlagType,
      RcConfigOption[]
    >
  );

  // Profile management
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

  // General state
  editTarget = signal<EditTarget>(null);
  cloneTarget = signal(false);
  useInteractiveMode = signal(false);
  showAdvancedOptions = signal(false);
  isRemoteConfigLoading = signal(false);
  isLoadingServeFields = signal(false);
  isLoadingRuntimeRemoteFields = signal(false);
  isAuthInProgress = this.authStateService.isAuthInProgress;
  isAuthCancelled = this.authStateService.isAuthCancelled;
  currentStep = signal(1);
  interactiveFlowState = signal<InteractiveFlowState>(createInitialInteractiveFlowState());

  editTargetType = computed(() => {
    const target = this.editTarget();
    return target as SharedProfileType;
  });

  // Search state
  isSearchVisible = signal(false);
  searchQuery = signal('');

  remoteEditCategories = [
    { id: 'section-general', label: 'modals.remoteConfig.editMode.sections.general', icon: 'gear' },
    { id: 'section-auth', label: 'modals.remoteConfig.editMode.sections.auth', icon: 'lock' },
    {
      id: 'section-advanced',
      label: 'modals.remoteConfig.editMode.sections.advanced',
      icon: 'wrench',
    },
  ];

  visibleSections = computed(() => {
    const step = this.configStep();
    if (!step) return new Set<string>(['section-general', 'section-auth', 'section-advanced']);

    const visible = new Set<string>();
    if (step.showNameField() || step.showAdvancedToggle() || step.showInteractiveToggle()) {
      visible.add('section-general');
    }
    if (step.providerField()) {
      visible.add('section-auth');
    }
    if (step.showAdvancedOptions() && step.advancedFields().length > 0 && step.providerReady()) {
      visible.add('section-advanced');
    }
    return visible;
  });

  private pendingConfig: {
    remoteData: PendingRemoteData;
    finalConfig: RemoteConfigSections;
  } | null = null;
  private readonly changedRemoteFields = new Set<string>();
  private readonly optionToFlagTypeMap: Record<string, FlagType> = {};
  private readonly optionToFieldNameMap: Record<string, string> = {};

  /** Signal instead of plain boolean — visible to the signal graph (zoneless safe). */
  private readonly isPopulatingForm = signal(false);

  private initialSection: string | null = null;

  // ============================================================================
  // LIFECYCLE
  // ============================================================================
  constructor() {
    this.editTarget.set(this.dialogData?.editTarget ?? null);
    this.cloneTarget.set(this.dialogData?.cloneTarget ?? false);
    this.initialSection = this.dialogData?.initialSection ?? null;

    this.remoteForm = this.createRemoteForm();
    this.remoteConfigForm = this.createRemoteConfigForm();

    // toSignal replaces the manual statusChanges subscription + WritableSignal boilerplate.
    // Must be called in injection context (constructor ✓).
    this.remoteFormStatus = toSignal(this.remoteForm.statusChanges, {
      initialValue: this.remoteForm.status,
    });
    this.remoteConfigFormStatus = toSignal(this.remoteConfigForm.statusChanges, {
      initialValue: this.remoteConfigForm.status,
    });

    this.remoteTypeSignal = toSignal(
      this.remoteForm
        .get('type')!
        .valueChanges.pipe(startWith(this.remoteForm.get('type')!.value as string)),
      { initialValue: this.remoteForm.get('type')?.value ?? '' }
    );

    this.setupAuthStateListeners();
    this.destroyRef.onDestroy(() => this.authStateService.cancelAuth());
  }

  async ngOnInit(): Promise<void> {
    // Parallel load of all independent data sources — was sequential awaits.
    await Promise.all([
      this.loadExistingRemotes(),
      this.loadRemoteTypes(),
      this.loadAllFlagFields(),
      this.loadMountTypes(),
      this.loadServeTypes(),
    ]);

    // loadServeFields depends on selectedServeType set by loadServeTypes above.
    await this.loadServeFields();

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
    // Batch all updates — was N individual signal.update() calls inside forEach loop.
    const newProfiles = { ...this.profiles() };
    const newSelectedNames = { ...this.selectedProfileName() };

    PROFILE_TYPES.forEach(type => {
      const multiKey = REMOTE_CONFIG_KEYS[type as keyof typeof REMOTE_CONFIG_KEYS];
      const multiVal = this.dialogData?.existingConfig?.[multiKey] as
        | Record<string, unknown>
        | undefined;

      newProfiles[type] =
        multiVal && Object.keys(multiVal).length > 0
          ? ({ ...multiVal } as ProfilesMap)
          : { [DEFAULT_PROFILE_NAME]: {} };

      const profileNames = Object.keys(newProfiles[type]);
      const targetProfile = this.dialogData?.targetProfile;
      newSelectedNames[type] =
        targetProfile && profileNames.includes(targetProfile)
          ? targetProfile
          : (profileNames[0] ?? DEFAULT_PROFILE_NAME);
    });

    this.profiles.set(newProfiles);
    this.selectedProfileName.set(newSelectedNames);
  }

  // ============================================================================
  // DATA LOADING
  // ============================================================================
  private async loadExistingRemotes(): Promise<void> {
    try {
      this.existingRemotes.set(await this.remoteManagementService.getRemotes());
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
    this.dynamicFlagFields.set(await this.flagConfigService.loadAllFlagFields());
    this.addDynamicFieldsToForm();
  }

  private async loadMountTypes(): Promise<void> {
    try {
      this.mountTypes.set(await this.mountManagementService.getMountTypes());
    } catch (error) {
      console.error('Failed to load mount types:', error);
    }
  }

  private async loadServeTypes(): Promise<void> {
    try {
      const types = await this.serveManagementService.getServeTypes();
      this.availableServeTypes.set(types);

      const serveConfigs = this.dialogData?.existingConfig?.[REMOTE_CONFIG_KEYS.serve] as
        | ProfilesMap
        | undefined;
      this.profiles.update(p => ({ ...p, serve: serveConfigs ?? {} }));

      if (serveConfigs && Object.keys(serveConfigs).length > 0) {
        const firstConfig = Object.values(serveConfigs)[0] as Record<string, any>;
        this.selectedServeType.set((firstConfig?.['options']?.['type'] as string) ?? 'http');
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
      this.dynamicServeFields.set(
        await this.flagConfigService.loadServeFlagFields(this.selectedServeType())
      );
      this.rebuildServeOptionsGroup();
    } catch (error) {
      console.error('Failed to load serve fields:', error);
      this.dynamicServeFields.set([]);
    } finally {
      this.isLoadingServeFields.set(false);
    }
  }

  private async loadRuntimeRemoteFields(type: string): Promise<void> {
    if (!type) {
      this.dynamicRuntimeRemoteFields.set([]);
      return;
    }
    this.isLoadingRuntimeRemoteFields.set(true);
    this.dynamicRuntimeRemoteFields.set([]);
    try {
      this.dynamicRuntimeRemoteFields.set(
        await this.remoteManagementService.getRemoteConfigFields(type)
      );
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
    const currentRemoteType = String(this.remoteForm.get('type')?.value ?? '').trim();
    runtimeRemoteGroup.get('type')?.setValue(currentRemoteType, { emitEvent: false });
    if (!currentRemoteType) {
      this.dynamicRuntimeRemoteFields.set([]);
      return;
    }
    await this.loadRuntimeRemoteFields(currentRemoteType);
  }

  private replaceRuntimeRemoteFormControls(): void {
    const group = this.remoteConfigForm.get('runtimeRemoteConfig') as FormGroup;
    if (!group) return;
    Object.keys(group.controls).forEach(key => {
      if (key !== 'type') group.removeControl(key);
    });
    this.dynamicRuntimeRemoteFields().forEach(field => {
      group.addControl(field.Name, new FormControl(field.Value ?? field.Default));
    });
  }

  // Note: Rclone uses Name (not FieldName) for serve flag keys.
  private rebuildServeOptionsGroup(): void {
    const optionsGroup = this.remoteConfigForm.get('serveConfig.options') as FormGroup;
    if (!optionsGroup) return;
    Object.keys(optionsGroup.controls).forEach(key => optionsGroup.removeControl(key));
    this.dynamicServeFields().forEach(field => {
      optionsGroup.addControl(
        field.Name,
        new FormControl(field.Value ?? field.Default, field.Required ? [Validators.required] : [])
      );
    });
  }

  async onServeTypeChange(type: string): Promise<void> {
    this.selectedServeType.set(type);
    this.remoteConfigForm.get('serveConfig.type')?.setValue(type, { emitEvent: false });
    await this.loadServeFields();
  }

  private addDynamicFieldsToForm(): void {
    FLAG_TYPES.forEach(flagType => {
      const optionsGroup = this.remoteConfigForm.get(`${flagType}Config.options`) as FormGroup;
      if (!optionsGroup || !this.dynamicFlagFields()[flagType]) return;
      this.dynamicFlagFields()[flagType].forEach(field => {
        const uniqueKey = this.getUniqueControlKey(flagType, field);
        this.optionToFlagTypeMap[uniqueKey] = flagType;
        this.optionToFieldNameMap[uniqueKey] = field.FieldName;
        optionsGroup.addControl(uniqueKey, new FormControl(field.Value ?? field.Default));
      });
    });
  }

  public getUniqueControlKey(flagType: FlagType, field: RcConfigOption): string {
    return flagType === 'serve' ? field.Name : `${flagType}---${field.Name}`;
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
    const group: Record<string, AbstractControl> = {};

    FLAG_TYPES.forEach(flag => {
      group[flag === 'serve' ? 'serveConfig' : `${flag}Config`] =
        flag === 'serve'
          ? this.createServeConfigGroup()
          : this.createConfigGroup(this.getFieldsForFlagType(flag));
    });
    group['runtimeRemoteConfig'] = this.createRuntimeRemoteConfigGroup();

    return this.fb.group(group);
  }

  private createRuntimeRemoteConfigGroup(): FormGroup {
    return this.fb.group({
      type: [this.remoteForm?.get('type')?.value ?? '', Validators.required],
    });
  }

  private createServeConfigGroup(): FormGroup {
    return this.fb.group({
      autoStart: [false],
      cronEnabled: [false],
      cronExpression: [null],
      source: this.fb.group({
        pathType: ['currentRemote'],
        path: [''],
        otherRemoteName: [''],
      }),
      type: ['http', Validators.required],
      vfsProfile: [DEFAULT_PROFILE_NAME],
      filterProfile: [DEFAULT_PROFILE_NAME],
      backendProfile: [DEFAULT_PROFILE_NAME],
      runtimeRemoteProfile: [DEFAULT_PROFILE_NAME],
      options: this.fb.group({}),
    });
  }

  private createConfigGroup(fields: string[], includeProfiles = true): FormGroup {
    const group: Record<string, unknown> = {};
    fields.forEach(field => {
      group[field] = field === 'autoStart' || field === 'cronEnabled' ? [false] : [''];
    });

    if (fields.includes('source')) {
      group['source'] = this.fb.group({
        pathType: ['currentRemote'],
        path: [''],
        otherRemoteName: [''],
      });
    }
    if (fields.includes('dest') && !fields.includes('type')) {
      // 'type' check excludes mount (mount dest is a simple string)
      group['dest'] = this.fb.group({ pathType: ['local'], path: [''], otherRemoteName: [''] });
    } else if (fields.includes('dest') && fields.includes('type')) {
      group['dest'] = [''];
    }
    if (fields.includes('autoStart') && !fields.includes('type')) {
      group['cronExpression'] = [null];
    }

    const isMainOp =
      fields.includes('source') || fields.includes('dest') || fields.includes('autoStart');
    if (includeProfiles && isMainOp) {
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
    if (!nameCtrl) return;
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

  // ============================================================================
  // FORM SETUP
  // ============================================================================
  private static readonly AUTO_START_OP_TYPES = new Set(['sync', 'copy', 'move', 'bisync']);

  private setupAutoStartValidators(): void {
    if (this.editTarget() === 'remote' || !this.editTarget() || this.cloneTarget()) {
      FLAG_TYPES.forEach(type => {
        if (type !== 'mount' && !RemoteConfigModalComponent.AUTO_START_OP_TYPES.has(type)) return;

        const configName = `${type}Config`;
        const opGroup = this.remoteConfigForm.get(configName);
        if (!opGroup) return;

        if (type === 'mount') {
          const autoStartCtrl = opGroup.get('autoStart');
          const destCtrl = opGroup.get('dest');
          autoStartCtrl?.valueChanges
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(enabled => {
              if (enabled) {
                const validator = this.validatorRegistry.getValidator('crossPlatformPath');
                destCtrl?.setValidators([Validators.required, ...(validator ? [validator] : [])]);
              } else {
                destCtrl?.clearValidators();
              }
              destCtrl?.updateValueAndValidity();
            });
        } else {
          const sourcePathCtrl = opGroup.get('source.path');
          const destPathCtrl = opGroup.get('dest.path');
          const autoStartCtrl = opGroup.get('autoStart');
          const sourcePathTypeCtrl = opGroup.get('source.pathType');
          const destPathTypeCtrl = opGroup.get('dest.pathType');

          sourcePathCtrl?.setValidators(this.validatorRegistry.requiredIfLocal());
          destPathCtrl?.setValidators(this.validatorRegistry.requiredIfLocal());

          autoStartCtrl?.valueChanges.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
            sourcePathCtrl?.updateValueAndValidity();
            destPathCtrl?.updateValueAndValidity();
          });
          sourcePathTypeCtrl?.valueChanges
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(() => {
              sourcePathCtrl?.updateValueAndValidity();
            });
          destPathTypeCtrl?.valueChanges.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
            destPathCtrl?.updateValueAndValidity();
          });
        }
      });
    }
  }

  private setupAuthStateListeners(): void {
    effect(() => {
      const isInProgress = this.authStateService.isAuthInProgress();
      untracked(() => this.setFormState(isInProgress));
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
        this.FLAG_TYPES.forEach(type => {
          const configKey = REMOTE_CONFIG_KEYS[
            type as keyof typeof REMOTE_CONFIG_KEYS
          ] as keyof RemoteConfigSections;
          const configs = this.dialogData.existingConfig?.[configKey] as
            | Record<string, unknown>
            | undefined;
          if (configs && Object.keys(configs).length > 0) {
            void this.populateProfileForm(
              type,
              Object.values(configs)[0] as Record<string, unknown>
            );
          }
        });

        const runtimeConfigs = this.dialogData.existingConfig?.[
          REMOTE_CONFIG_KEYS.runtimeRemote
        ] as Record<string, unknown> | undefined;
        if (runtimeConfigs && Object.keys(runtimeConfigs).length > 0) {
          void this.populateProfileForm(
            'runtimeRemote',
            Object.values(runtimeConfigs)[0] as Record<string, unknown>
          );
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

      if (profile) void this.populateProfileForm(type, profile);
    }

    if (this.cloneTarget()) this.generateNewCloneName();
  }

  private async populateRemoteForm(config: Record<string, unknown>): Promise<void> {
    this.isPopulatingForm.set(true);
    this.remoteForm.patchValue({ name: config['name'], type: config['type'] });
    await this.onRemoteTypeChange();
    this.remoteForm.patchValue(config);
    // Set false directly after all awaits — setTimeout(100) was fragile in zoneless Angular.
    this.isPopulatingForm.set(false);
  }

  private async populateProfileForm(
    type: SharedProfileType,
    config: Record<string, unknown>
  ): Promise<void> {
    this.isPopulatingForm.set(true);
    const group = this.remoteConfigForm.get(`${type}Config`);
    if (!group) {
      this.isPopulatingForm.set(false);
      return;
    }

    if (type === 'serve') {
      const options = (config?.['options'] as Record<string, unknown>) ?? {};
      const serveType = (options?.['type'] as string) ?? 'http';
      this.selectedServeType.set(serveType);
      await this.loadServeFields();

      group.patchValue({
        autoStart: config['autoStart'] ?? false,
        source: parseFsString(
          (config['source'] as string) ?? '',
          'currentRemote',
          this.getRemoteName(),
          this.existingRemotes()
        ),
        type: serveType,
        vfsProfile: config['vfsProfile'] ?? DEFAULT_PROFILE_NAME,
        filterProfile: config['filterProfile'] ?? DEFAULT_PROFILE_NAME,
        backendProfile: config['backendProfile'] ?? DEFAULT_PROFILE_NAME,
        runtimeRemoteProfile: config['runtimeRemoteProfile'] ?? DEFAULT_PROFILE_NAME,
      });

      const optionsGroup = group.get('options') as FormGroup;
      if (optionsGroup) {
        Object.entries(options).forEach(([key, value]) => {
          if (key !== 'type' && key !== 'fs') {
            optionsGroup.get(key)?.setValue(value, { emitEvent: false });
          }
        });
      }
    } else if (type === 'runtimeRemote') {
      const options = (config['options'] as Record<string, unknown>) ?? {};
      const runtimeType =
        String(this.remoteForm.get('type')?.value ?? '').trim() ||
        (options['type'] as string) ||
        (config['type'] as string) ||
        '';
      group.get('type')?.setValue(runtimeType, { emitEvent: false });
      await this.loadRuntimeRemoteFields(runtimeType);
      this.dynamicRuntimeRemoteFields().forEach(field => {
        const value =
          options[field.FieldName] ?? options[field.Name] ?? field.Value ?? field.Default;
        group.get(field.Name)?.setValue(value, { emitEvent: false });
      });
    } else {
      // Flag types
      const flagType = type as FlagType;
      const hasActualData = Object.keys(config).some(k => k !== 'name');

      const patchData: any = {
        autoStart: config['autoStart'] ?? false,
        cronEnabled: config['cronEnabled'] ?? false,
        cronExpression: config['cronExpression'] ?? null,
        vfsProfile: config['vfsProfile'] ?? DEFAULT_PROFILE_NAME,
        filterProfile: config['filterProfile'] ?? DEFAULT_PROFILE_NAME,
        backendProfile: config['backendProfile'] ?? DEFAULT_PROFILE_NAME,
        runtimeRemoteProfile: config['runtimeRemoteProfile'] ?? DEFAULT_PROFILE_NAME,
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
        patchData.dest =
          flagType === 'mount'
            ? config['dest']
            : parseFsString(
                config['dest'] as string,
                'local',
                this.getRemoteName(),
                this.existingRemotes()
              );
      }

      group.patchValue(patchData);

      const optionsGroup = group.get('options') as FormGroup;
      if (optionsGroup && this.dynamicFlagFields()[flagType]) {
        if (hasActualData) {
          this.dynamicFlagFields()[flagType].forEach(field => {
            optionsGroup
              .get(this.getUniqueControlKey(flagType, field))
              ?.setValue(field.Default ?? null);
          });
        }
        if (config['options']) {
          Object.entries(config['options'] as Record<string, unknown>).forEach(
            ([fieldName, value]) => {
              const field = this.dynamicFlagFields()[flagType].find(f => f.FieldName === fieldName);
              if (field) {
                optionsGroup.get(this.getUniqueControlKey(flagType, field))?.setValue(value);
              }
            }
          );
        }
      }
    }

    // Set false after all awaits — no setTimeout needed.
    this.isPopulatingForm.set(false);
  }

  private generateNewCloneName(): void {
    const baseName = this.remoteForm.get('name')?.value as string;
    if (!baseName) return;
    let newName = `${baseName}-clone`;
    let counter = 1;
    while (this.existingRemotes().includes(newName)) {
      newName = `${baseName}-clone-${counter++}`;
    }
    this.remoteForm.get('name')?.setValue(newName);
    this.refreshRemoteNameValidator();
  }

  // ============================================================================
  // GETTERS
  // ============================================================================
  // ============================================================================
  // STEP NAVIGATION
  // ============================================================================
  applicableSteps = computed(() => {
    const editTargetValue = this.editTarget();
    if (!editTargetValue || editTargetValue === 'remote') {
      return Array.from({ length: this.TOTAL_STEPS }, (_, i) => i + 1);
    }
    const index = this.stepConfigs().findIndex(s => s.type === editTargetValue);
    return index !== -1 ? [index + 1] : [1];
  });

  goToStep(step: number): void {
    if (this.isStepDisabled(step)) return;
    this.saveCurrentStepProfile();
    this.currentStep.set(step);
    this.scrollToTop();
  }

  isStepDisabled(step: number): boolean {
    if (this.isAuthInProgress()) return true;
    if (this.editTarget()) return false;
    return step > 1 && this.remoteForm.status === 'INVALID';
  }

  nextStep(): void {
    const steps = this.applicableSteps();
    const idx = steps.indexOf(this.currentStep());
    if (idx !== -1 && idx < steps.length - 1) this.goToStep(steps[idx + 1]);
  }

  prevStep(): void {
    const steps = this.applicableSteps();
    const idx = steps.indexOf(this.currentStep());
    if (idx > 0) this.goToStep(steps[idx - 1]);
  }

  getStepState(stepNumber: number): 'completed' | 'current' | 'future' {
    if (stepNumber < this.currentStep()) return 'completed';
    if (stepNumber === this.currentStep()) return 'current';
    return 'future';
  }

  private scrollToTop(): void {
    document.querySelector('.modal-content')?.scrollTo(0, 0);
  }

  // ============================================================================
  // EVENT HANDLERS
  // ============================================================================
  async onRemoteTypeChange(): Promise<void> {
    const remoteType = this.remoteForm.get('type')?.value;
    this.useInteractiveMode.set(INTERACTIVE_REMOTES.includes(remoteType?.toLowerCase()));
    await this.loadRemoteFields(remoteType);
    await this.syncRuntimeRemoteType();
  }

  private async loadRemoteFields(type: string): Promise<void> {
    this.isRemoteConfigLoading.set(true);
    this.dynamicRemoteFields.set([]);
    try {
      this.dynamicRemoteFields.set(await this.remoteManagementService.getRemoteConfigFields(type));
      this.replaceDynamicFormControls();
    } catch (error) {
      console.error('Error loading remote config fields:', error);
    } finally {
      this.isRemoteConfigLoading.set(false);
    }
  }

  private replaceDynamicFormControls(): void {
    Object.keys(this.remoteForm.controls).forEach(key => {
      if (!['name', 'type'].includes(key)) this.remoteForm.removeControl(key);
    });
    this.dynamicRemoteFields().forEach(field => {
      this.remoteForm.addControl(field.Name, new FormControl(field.Value));
    });
  }

  handleSourceFolderSelect(flagType: FlagType): void {
    this.fileSystemService
      .selectFolder(false)
      .then(path => this.remoteConfigForm.get(`${flagType}Config.source.path`)?.setValue(path));
  }

  handleDestFolderSelect(flagType: FlagType): void {
    const formPath = flagType === 'mount' ? 'mountConfig.dest' : `${flagType}Config.dest.path`;
    const requireEmpty =
      flagType === 'mount'
        ? !this.remoteConfigForm.get('mountConfig.options')?.value?.['mount---allow_non_empty']
        : false;
    this.fileSystemService
      .selectFolder(requireEmpty)
      .then(path => this.remoteConfigForm.get(formPath)?.setValue(path));
  }

  onRemoteFieldChanged(fieldName: string, isChanged: boolean): void {
    if (this.isPopulatingForm()) return;
    // In edit mode we always track the field (even when "unchanged") so existing
    // values are not silently dropped during save. In create mode, track only real changes.
    if (isChanged || this.editTarget() === 'remote') {
      this.changedRemoteFields.add(fieldName);
    } else {
      this.changedRemoteFields.delete(fieldName);
    }
  }

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
    PROFILE_TYPES.forEach(type => this.saveCurrentProfile(type));
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
      const remoteData = this.cleanFormData(this.remoteForm.getRawValue());
      await this.remoteManagementService.updateRemote(remoteData.name, remoteData);
      return { success: true };
    }

    const updatedConfig = this.buildUpdateConfig();
    await this.appSettingsService.saveRemoteSettings(remoteName, updatedConfig);
    return { success: true };
  }

  // ============================================================================
  // CONFIG BUILDING
  // ============================================================================
  private buildFinalConfig(): RemoteConfigSections {
    this.saveCurrentStepProfile();
    const p = this.profiles();
    return {
      [REMOTE_CONFIG_KEYS.mount]: p['mount'] as Record<string, MountConfig>,
      [REMOTE_CONFIG_KEYS.copy]: p['copy'] as Record<string, CopyConfig>,
      [REMOTE_CONFIG_KEYS.sync]: p['sync'] as Record<string, SyncConfig>,
      [REMOTE_CONFIG_KEYS.bisync]: p['bisync'] as Record<string, BisyncConfig>,
      [REMOTE_CONFIG_KEYS.move]: p['move'] as Record<string, MoveConfig>,
      [REMOTE_CONFIG_KEYS.serve]: p['serve'] as unknown as Record<string, ServeConfig>,
      [REMOTE_CONFIG_KEYS.filter]: p['filter'] as Record<string, FilterConfig>,
      [REMOTE_CONFIG_KEYS.vfs]: p['vfs'] as Record<string, VfsConfig>,
      [REMOTE_CONFIG_KEYS.backend]: p['backend'] as Record<string, BackendConfig>,
      [REMOTE_CONFIG_KEYS.runtimeRemote]: p['runtimeRemote'] as Record<string, RuntimeRemoteConfig>,
      showOnTray: true,
    };
  }

  /**
   * Synchronous — was incorrectly marked async and returned Promise.resolve().
   * Always includes runtimeRemote alongside the target config.
   */
  private buildUpdateConfig(): Record<string, unknown> {
    const target = this.editTarget() as SharedProfileType;
    if (!target) return {};

    this.saveCurrentProfile(target);

    const updatedConfig: Record<string, unknown> = {
      [REMOTE_CONFIG_KEYS.runtimeRemote]: this.profiles()['runtimeRemote'],
    };

    if (target !== 'runtimeRemote') {
      const configKey = REMOTE_CONFIG_KEYS[target as keyof typeof REMOTE_CONFIG_KEYS];
      if (configKey) updatedConfig[configKey] = this.profiles()[target];
    }

    return updatedConfig;
  }

  private createEmptyFinalConfig(): RemoteConfigSections {
    const empty = Object.fromEntries(
      Object.values(REMOTE_CONFIG_KEYS).map(k => [k, {}])
    ) as unknown as RemoteConfigSections;
    return { ...empty, showOnTray: true };
  }

  // ============================================================================
  // PROFILE MANAGEMENT
  // ============================================================================
  saveCurrentStepProfile(): void {
    const type = this.stepConfigs()[this.currentStep() - 1]?.type;
    if (type && type !== 'remote') this.saveCurrentProfile(type);
  }

  startAddProfile(type: SharedProfileType): void {
    const existingNames = Object.keys(this.profiles()[type] ?? {});
    let counter = 1;
    while (existingNames.includes(`profile-${counter}`)) counter++;
    this.setProfileMode(type, 'add', `profile-${counter}`);
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
      this.profiles.update(p => ({ ...p, [type]: { ...p[type], [newName]: {} } }));
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
      const rest = { ...p[type] };
      delete rest[name];
      return { ...p, [type]: rest };
    });

    if (this.selectedProfileName()[type] === name) {
      const remaining = Object.keys(this.profiles()[type]);
      if (remaining.length > 0) {
        this.selectProfile(type, remaining[0]);
      } else {
        this.profiles.update(p => ({ ...p, [type]: { [DEFAULT_PROFILE_NAME]: {} } }));
        this.selectProfile(type, DEFAULT_PROFILE_NAME);
      }
    }
  }

  selectProfile(type: SharedProfileType, name: string): void {
    if (!this.profiles()[type]?.[name]) return;
    this.saveCurrentProfile(type);
    this.selectedProfileName.update(prev => ({ ...prev, [type]: name }));
    void this.populateProfileForm(type, this.profiles()[type][name] as Record<string, unknown>);
  }

  saveCurrentProfile(type: SharedProfileType): void {
    const currentName = this.selectedProfileName()[type];
    if (!this.profiles()[type]?.[currentName]) return;
    const formValue = this.remoteConfigForm.get(`${type}Config`)?.getRawValue();
    if (!formValue) return;
    this.profiles.update(p => ({
      ...p,
      [type]: {
        ...p[type],
        [currentName]: this.buildProfileConfig(type, this.getRemoteName(), formValue),
      },
    }));
  }

  getProfiles(type: SharedProfileType): { name: string; [key: string]: unknown }[] {
    return Object.entries(this.profiles()[type] ?? {}).map(([name, data]) => ({ name, ...data }));
  }

  getSelectedProfile(type: SharedProfileType): string {
    return this.selectedProfileName()[type];
  }

  private static readonly PROFILE_ICONS: Partial<Record<SharedProfileType, string>> = {
    mount: 'hard-drive',
    sync: 'refresh',
    copy: 'copy',
    move: 'move',
    bisync: 'right-left',
    serve: 'server',
    vfs: 'folder-tree',
    filter: 'filter',
    backend: 'database',
    runtimeRemote: 'gear',
  };

  getProfileIcon(type: SharedProfileType | null): string {
    return (type && RemoteConfigModalComponent.PROFILE_ICONS[type]) || 'circle-info';
  }

  getProfileOptions(type: 'vfs' | 'filter' | 'backend' | 'runtimeRemote'): string[] {
    if (type === 'runtimeRemote') {
      const names = Object.keys(this.profiles()['runtimeRemote'] ?? {});
      return names.length > 0 ? names : [DEFAULT_PROFILE_NAME];
    }
    return Object.keys(this.profiles()[type] ?? {});
  }

  private buildProfileConfig(type: SharedProfileType, remoteName: string, configData: any): any {
    if (type === 'serve') {
      const fs = buildPathString(configData['source'], remoteName);
      const serveOptions = this.cleanServeOptions(
        (configData['options'] as Record<string, unknown>) ?? {}
      );
      return {
        autoStart: configData['autoStart'] as boolean,
        cronEnabled: configData['cronEnabled'] as boolean,
        cronExpression: configData['cronExpression'] as string | null,
        source: fs,
        vfsProfile: configData['vfsProfile'] ?? DEFAULT_PROFILE_NAME,
        filterProfile: configData['filterProfile'] ?? DEFAULT_PROFILE_NAME,
        backendProfile: configData['backendProfile'] ?? DEFAULT_PROFILE_NAME,
        runtimeRemoteProfile: configData['runtimeRemoteProfile'] ?? DEFAULT_PROFILE_NAME,
        options: { type: configData['type'], fs, ...serveOptions },
      };
    }

    if (type === 'runtimeRemote') {
      const options = this.dynamicRuntimeRemoteFields().reduce(
        (acc, field) => {
          if (!Object.prototype.hasOwnProperty.call(configData, field.Name)) return acc;
          const value = configData[field.Name];
          if (!this.isDefaultValue(value, field)) acc[field.FieldName || field.Name] = value;
          return acc;
        },
        {} as Record<string, unknown>
      );
      return { options };
    }

    // Flag types
    const result: any = {};
    for (const key in configData) {
      result[key] =
        key === 'source' || key === 'dest'
          ? buildPathString(configData[key], remoteName)
          : configData[key];
    }

    const isMainOp = ['mount', 'sync', 'copy', 'move', 'bisync'].includes(type);
    if (isMainOp) {
      const runtimeOptions = this.getProfileOptions('runtimeRemote');
      const selectedProfile = String(result.runtimeRemoteProfile ?? '').trim();
      result.runtimeRemoteProfile = runtimeOptions.includes(selectedProfile)
        ? selectedProfile
        : DEFAULT_PROFILE_NAME;
    } else {
      delete result.vfsProfile;
      delete result.filterProfile;
      delete result.backendProfile;
      delete result.runtimeRemoteProfile;
    }

    result.options = this.cleanData(
      configData.options,
      this.dynamicFlagFields()[type as FlagType],
      type as FlagType
    );
    return result;
  }

  private cleanServeOptions(options: Record<string, unknown>): Record<string, unknown> {
    return this.dynamicServeFields().reduce(
      (cleaned, field) => {
        const value = options[field.Name];
        if (value !== undefined && !this.isDefaultValue(value, field)) cleaned[field.Name] = value;
        return cleaned;
      },
      {} as Record<string, unknown>
    );
  }

  private static readonly FLAG_TYPE_FIELDS: Partial<Record<string, string[]>> = {
    mount: ['autoStart', 'dest', 'source', 'type'],
    sync: ['autoStart', 'cronEnabled', 'cronExpression', 'source', 'dest'],
    copy: ['autoStart', 'cronEnabled', 'cronExpression', 'source', 'dest'],
    move: ['autoStart', 'cronEnabled', 'cronExpression', 'source', 'dest'],
    bisync: ['autoStart', 'cronEnabled', 'cronExpression', 'source', 'dest'],
  };

  private getFieldsForFlagType(type: string): string[] {
    return RemoteConfigModalComponent.FLAG_TYPE_FIELDS[type] ?? [];
  }

  // ============================================================================
  // DATA CLEANING
  // ============================================================================
  private cleanFormData(formData: Record<string, unknown>): PendingRemoteData {
    const result: PendingRemoteData = {
      name: formData['name'] as string,
      type: formData['type'] as string,
    };

    this.dynamicRemoteFields().forEach(field => {
      if (!Object.prototype.hasOwnProperty.call(formData, field.Name)) return;
      const value = formData[field.Name];
      if (!this.isDefaultValue(value, field) || this.changedRemoteFields.has(field.Name)) {
        result[field.FieldName || field.Name] = value;
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
        if (!this.isDefaultValue(value, field)) acc[field.FieldName] = value;
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
    if (this.interactiveFlowState().isProcessing) return;
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
      type ?? '',
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
      const processedAnswer: unknown =
        state.question?.Option?.Type === 'bool' ? convertBoolAnswerToString(answer) : answer;

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
      this.notificationService.showError(
        this.translate.instant('modals.remoteConfig.errors.interactiveProcessingFailed')
      );
    }
  }

  isInteractiveContinueDisabled = computed(() => {
    const state = this.interactiveFlowState();
    return (
      state.isProcessing ||
      (state.question?.Option?.Type !== 'password' &&
        (state.answer === null ||
          state.answer === undefined ||
          String(state.answer).trim() === '')) ||
      this.isAuthCancelled()
    );
  });

  // ============================================================================
  // FINALIZATION
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
    const serveConfigs = finalConfig[REMOTE_CONFIG_KEYS.serve];

    if (mountConfigs) {
      for (const [profileName, config] of Object.entries(mountConfigs)) {
        if (config.autoStart && config.dest) {
          void this.mountManagementService.mountRemoteProfile(remoteName, profileName);
        }
      }
    }

    // Unified job dispatch — replaces four identical copy-paste blocks.
    const jobConfigMap = {
      copy: finalConfig[REMOTE_CONFIG_KEYS.copy] as Record<
        string,
        { autoStart?: boolean; source?: string; dest?: string }
      >,
      sync: finalConfig[REMOTE_CONFIG_KEYS.sync] as Record<
        string,
        { autoStart?: boolean; source?: string; dest?: string }
      >,
      bisync: finalConfig[REMOTE_CONFIG_KEYS.bisync] as Record<
        string,
        { autoStart?: boolean; source?: string; dest?: string }
      >,
      move: finalConfig[REMOTE_CONFIG_KEYS.move] as Record<
        string,
        { autoStart?: boolean; source?: string; dest?: string }
      >,
    };

    const jobStarters: Record<string, (remote: string, profile: string) => Promise<number>> = {
      copy: this.jobManagementService.startCopyProfile.bind(this.jobManagementService),
      sync: this.jobManagementService.startSyncProfile.bind(this.jobManagementService),
      bisync: this.jobManagementService.startBisyncProfile.bind(this.jobManagementService),
      move: this.jobManagementService.startMoveProfile.bind(this.jobManagementService),
    };

    for (const [jobType, configs] of Object.entries(jobConfigMap)) {
      if (!configs) continue;
      for (const [profileName, config] of Object.entries(configs)) {
        if (config.autoStart && config.source && config.dest) {
          void jobStarters[jobType]?.(remoteName, profileName);
        }
      }
    }

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
  // UTILITIES
  // ============================================================================
  public getRemoteName(): string {
    return this.dialogData?.name ?? this.remoteForm.get('name')?.value;
  }

  private cascadeProfileRename(type: SharedProfileType, oldName: string, newName: string): void {
    const remoteName = this.getRemoteName();
    if (!remoteName) return;

    const onResult = (n: number): void => {
      if (n > 0) console.debug(`Updated ${n} ${type}(s) with new profile name: ${newName}`);
    };
    const onError = (err: unknown): void =>
      console.warn(`Failed to update ${type}s with new profile name:`, err);

    if (JOB_TYPES.has(type)) {
      this.jobManagementService
        .renameProfileInCache(remoteName, oldName, newName)
        .then(onResult)
        .catch(onError);
      return;
    }

    const handlers: Partial<Record<string, () => Promise<number>>> = {
      mount: () =>
        this.mountManagementService.renameProfileInMountCache(remoteName, oldName, newName),
      serve: () =>
        this.serveManagementService.renameProfileInServeCache(remoteName, oldName, newName),
    };
    handlers[type]?.().then(onResult).catch(onError);
  }

  private getProfileUsage(
    type: SharedProfileType,
    remoteName: string,
    profileName: string
  ): { inUse: boolean; count: number; opType: string } {
    if (JOB_TYPES.has(type)) {
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

  private setProfileMode(
    type: SharedProfileType,
    mode: 'view' | 'edit' | 'add',
    tempName = ''
  ): void {
    this.profileState.update(state => ({ ...state, [type]: { mode, tempName } }));
  }

  public getProfileState(type: string): { mode: 'view' | 'edit' | 'add'; tempName: string } {
    return this.profileState()[type as SharedProfileType] ?? { mode: 'view', tempName: '' };
  }

  public setProfileTempName(type: string, name: string): void {
    const key = type as SharedProfileType;
    this.profileState.update(state => ({ ...state, [key]: { ...state[key], tempName: name } }));
  }

  asProfileType(type: string): SharedProfileType {
    return type as SharedProfileType;
  }

  profileGetSelected(type: string): string {
    return this.getSelectedProfile(type as SharedProfileType);
  }

  profileGetAll(type: string): { name: string; [key: string]: unknown }[] {
    return this.getProfiles(type as SharedProfileType);
  }

  profileSelect(type: string, name: string): void {
    this.selectProfile(type as SharedProfileType, name);
  }

  profileStartAdd(type: string): void {
    this.startAddProfile(type as SharedProfileType);
  }

  profileStartEdit(type: string): void {
    this.startEditProfile(type as SharedProfileType);
  }

  profileDelete(type: string, name: string): void {
    this.deleteProfile(type as SharedProfileType, name);
  }

  profileSave(type: string): void {
    this.saveProfile(type as SharedProfileType);
  }

  profileCancelEdit(type: string): void {
    this.cancelProfileEdit(type as SharedProfileType);
  }

  formControl(path: string): FormControl {
    return this.remoteConfigForm.get(path) as FormControl;
  }

  get runtimeRemoteConfigGroup(): FormGroup {
    return this.remoteConfigForm.get('runtimeRemoteConfig') as FormGroup;
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

    const remoteStatus = this.remoteFormStatus();
    const configStatus = this.remoteConfigFormStatus();
    const editTargetValue = this.editTarget();

    if (editTargetValue) {
      if (editTargetValue === 'remote') return remoteStatus === 'INVALID';
      void configStatus;
      return this.remoteConfigForm.get(`${editTargetValue}Config`)?.invalid ?? true;
    }

    return remoteStatus === 'INVALID' || configStatus === 'INVALID';
  });

  saveButtonLabel = computed(() => {
    if (this.isAuthInProgress() && !this.isAuthCancelled()) {
      return 'modals.remoteConfig.buttons.saving';
    }
    return this.editTarget()
      ? 'modals.remoteConfig.buttons.saveChanges'
      : 'modals.remoteConfig.buttons.save';
  });

  // ============================================================================
  // SEARCH
  // ============================================================================
  toggleSearchVisibility(): void {
    this.isSearchVisible.update(visible => !visible);
    if (!this.isSearchVisible()) this.searchQuery.set('');
  }

  onSearchInput(query: string): void {
    this.searchQuery.set(query);
  }

  scrollToSection(sectionId: string): void {
    const element = document.getElementById(sectionId);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' });
    }
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
    if (this.nautilusService.isNautilusOverlayOpen()) return;
    this.modalService.animatedClose(this.dialogRef);
  }
}
