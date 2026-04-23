import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  HostListener,
  inject,
  OnInit,
  signal,
  effect,
  Signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { startWith } from 'rxjs';
import { NgTemplateOutlet } from '@angular/common';
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
import {
  RemoteConfigStepComponent,
  INITIAL_COMMAND_OPTIONS,
} from '../../../../shared/remote-config/remote-config-step/remote-config-step.component';
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
  CommandOption,
} from '@app/types';
import {
  buildPathString,
  getDefaultAnswerFromQuestion,
  createInitialInteractiveFlowState,
  convertBoolAnswerToString,
  parseFsString,
} from '../../../../services/remote/utils/remote-config.utils';
import { MatExpansionModule } from '@angular/material/expansion';
import { CopyToClipboardDirective } from 'src/app/shared/directives/copy-to-clipboard.directive';

// ── Types ─────────────────────────────────────────────────────────────────────

interface DialogData {
  editTarget?: EditTarget;
  cloneTarget?: boolean;
  existingConfig?: RemoteConfigSections;
  name?: string;
  remoteType: string;
  targetProfile?: string;
  autoAddProfile?: boolean;
}

interface PendingRemoteData {
  name: string;
  type: string;
  [key: string]: unknown;
}

type ProfileData = Record<string, unknown>;

type ProfilesMap = Record<string, ProfileData>;

type SharedProfileType = FlagType | 'runtimeRemote';

interface JobProfile {
  autoStart?: boolean;
  source?: string;
  dest?: string;
}

type JobMap = Record<string, JobProfile>;

const PROFILE_TYPES: SharedProfileType[] = [...FLAG_TYPES, 'runtimeRemote'];

/** Operation types managed by jobManagementService */
const JOB_TYPES = new Set(['sync', 'copy', 'bisync', 'move']);

const LINKED_PROFILE_TYPES = new Set<FlagType>([
  'mount',
  'serve',
  'sync',
  'copy',
  'move',
  'bisync',
]);

function profileRecord<T>(factory: () => T): Record<SharedProfileType, T> {
  return Object.fromEntries(PROFILE_TYPES.map(t => [t, factory()])) as Record<SharedProfileType, T>;
}

// ── Component ─────────────────────────────────────────────────────────────────

@Component({
  selector: 'app-remote-config-modal',
  standalone: true,
  imports: [
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
    CopyToClipboardDirective,
  ],
  templateUrl: './remote-config-modal.component.html',
  styleUrls: ['./remote-config-modal.component.scss', '../../../../styles/_shared-modal.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RemoteConfigModalComponent implements OnInit {
  // ── Injections ────────────────────────────────────────────────────────────────

  private readonly fb = inject(FormBuilder);
  private readonly dialogRef = inject(MatDialogRef<RemoteConfigModalComponent>);
  private readonly hostEl = inject(ElementRef<HTMLElement>);
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

  // ── Static config ─────────────────────────────────────────────────────────────
  // FLAG_TYPES and LINKED_PROFILE_TYPES are exposed so the template can use them.

  readonly FLAG_TYPES = FLAG_TYPES;
  readonly LINKED_PROFILE_TYPES = LINKED_PROFILE_TYPES;

  private static readonly STATIC_STEP_CONFIGS = [
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
  ] as const;

  readonly stepConfigs = computed(() => {
    const remoteType = this.remoteTypeSignal();
    const remoteIcon = this.iconService.getIconName(remoteType || 'hard-drive');
    return [
      {
        label: 'modals.remoteConfig.steps.remoteConfig',
        icon: remoteIcon,
        type: 'remote' as const,
      },
      ...RemoteConfigModalComponent.STATIC_STEP_CONFIGS,
    ];
  });

  readonly stepLabels = computed(() => this.stepConfigs().map(s => s.label));

  // ── Forms ─────────────────────────────────────────────────────────────────────

  remoteForm!: FormGroup;
  remoteConfigForm!: FormGroup;

  readonly remoteFormStatus!: Signal<string>;
  readonly remoteConfigFormStatus!: Signal<string>;
  readonly remoteTypeSignal!: Signal<string>;
  readonly remoteNameSignal!: Signal<string>;

  // ── State signals ─────────────────────────────────────────────────────────────

  readonly remoteTypes = signal<RemoteType[]>([]);
  readonly existingRemotes = signal<string[]>([]);
  readonly mountTypes = signal<string[]>([]);
  readonly availableServeTypes = signal<string[]>([]);
  readonly selectedServeType = signal('http');

  readonly dynamicRemoteFields = signal<RcConfigOption[]>([]);
  readonly dynamicServeFields = signal<RcConfigOption[]>([]);
  readonly dynamicRuntimeRemoteFields = signal<RcConfigOption[]>([]);
  readonly dynamicFlagFields = signal<Record<FlagType, RcConfigOption[]>>(
    Object.fromEntries(FLAG_TYPES.map(t => [t, [] as RcConfigOption[]])) as Record<
      FlagType,
      RcConfigOption[]
    >
  );

  readonly profileState = signal<
    Record<SharedProfileType, { mode: 'view' | 'edit' | 'add'; tempName: string }>
  >(profileRecord(() => ({ mode: 'view' as const, tempName: '' })));

  readonly profiles = signal<Record<SharedProfileType, ProfilesMap>>(
    profileRecord(() => ({}) as ProfilesMap)
  );

  readonly selectedProfileName = signal<Record<SharedProfileType, string>>(
    profileRecord(() => DEFAULT_PROFILE_NAME)
  );

  readonly profileLists = computed(
    (): Record<SharedProfileType, { name: string; [key: string]: unknown }[]> => {
      const p = this.profiles();
      return Object.fromEntries(
        PROFILE_TYPES.map(t => [
          t,
          Object.entries(p[t] ?? {}).map(([name, data]) => ({ name, ...(data as object) })),
        ])
      ) as Record<SharedProfileType, { name: string; [key: string]: unknown }[]>;
    }
  );

  readonly editTarget = signal<EditTarget>(null);
  readonly cloneTarget = signal(false);
  readonly editStack = signal<NonNullable<EditTarget>[]>([]);

  readonly sharedReturnTarget = computed<EditTarget>(() => {
    const s = this.editStack();
    return s.length > 0 ? (s[s.length - 1] as EditTarget) : null;
  });

  readonly editTargetStepKey = computed(() => {
    const t = this.editTarget();
    if (!t) return null;
    return 'modals.remoteConfig.steps.' + (t === 'remote' ? 'remoteConfig' : t);
  });

  readonly activeProfileType = computed<Exclude<EditTarget, null | 'remote'> | null>(() => {
    const target = this.editTarget();
    if (!target || target === 'remote') return null;
    return target;
  });

  readonly sharedSidebarTypes = computed(
    (): { type: Exclude<EditTarget, null | 'remote'>; icon: string; label: string }[] => {
      const target = this.editTarget();
      if (!target || target === 'remote') return [];
      const vfsEligible: Exclude<EditTarget, null | 'remote'>[] = [
        'mount',
        'serve',
        'filter',
        'backend',
      ];
      const candidates: {
        type: Exclude<EditTarget, null | 'remote'>;
        icon: string;
        label: string;
      }[] = [
        { type: 'vfs', icon: 'vfs', label: 'modals.remoteConfig.steps.vfs' },
        { type: 'filter', icon: 'filter', label: 'modals.remoteConfig.steps.filter' },
        { type: 'backend', icon: 'database', label: 'modals.remoteConfig.steps.backend' },
        { type: 'runtimeRemote', icon: 'gear', label: 'modals.remoteConfig.steps.runtimeRemote' },
      ];
      return candidates
        .filter(item => item.type !== target)
        .filter(item => item.type !== 'vfs' || vfsEligible.includes(target));
    }
  );

  readonly PROFILE_ICONS: Record<string, string> = {
    mount: 'hard-drive',
    sync: 'refresh',
    copy: 'copy',
    move: 'move',
    bisync: 'right-left',
    serve: 'server',
    vfs: 'vfs',
    filter: 'filter',
    backend: 'database',
    runtimeRemote: 'gear',
  };

  readonly profileOptions = computed(() => {
    const p = this.profiles();
    const runtimeNames = Object.keys(p['runtimeRemote'] ?? {});
    return {
      vfs: Object.keys(p['vfs'] ?? {}),
      filter: Object.keys(p['filter'] ?? {}),
      backend: Object.keys(p['backend'] ?? {}),
      runtimeRemote: runtimeNames.length > 0 ? runtimeNames : [DEFAULT_PROFILE_NAME],
    };
  });

  readonly commandOptions = signal<CommandOption[]>(INITIAL_COMMAND_OPTIONS);
  readonly showAdvancedOptions = signal(false);
  readonly isRemoteConfigLoading = signal(false);
  readonly isLoadingServeFields = signal(false);
  readonly isLoadingRuntimeRemoteFields = signal(false);
  readonly isAuthInProgress = this.authStateService.isAuthInProgress;
  readonly isAuthCancelled = this.authStateService.isAuthCancelled;
  readonly oauthUrl = this.authStateService.oauthUrl;
  readonly oauthHelperUrl = computed(() =>
    this.isAuthInProgress() && !this.isAuthCancelled() ? this.oauthUrl() : null
  );
  readonly shouldShowRemoteOAuthFallback = this.authStateService.shouldShowRemoteOAuthFallback;
  readonly currentStep = signal(1);
  readonly interactiveFlowState = signal<InteractiveFlowState>(createInitialInteractiveFlowState());

  readonly isSearchVisible = signal(false);
  readonly searchQuery = signal('');
  readonly isInitializing = signal(true);

  readonly isStepNavigationLocked = computed(
    () => this.isAuthInProgress() || this.isRemoteConfigLoading()
  );

  readonly currentRemoteName = computed(() => this.dialogData?.name ?? this.remoteNameSignal());

  readonly remoteEditCategories = [
    { id: 'section-general', label: 'modals.remoteConfig.editMode.sections.general', icon: 'gear' },
    { id: 'section-auth', label: 'modals.remoteConfig.editMode.sections.auth', icon: 'lock' },
    {
      id: 'section-advanced',
      label: 'modals.remoteConfig.editMode.sections.advanced',
      icon: 'wrench',
    },
  ];

  readonly visibleSections = computed(() => {
    const step = this.configStep();
    if (!step) return new Set<string>();

    const visible = new Set<string>();
    if (step.showNameField() || step.showAdvancedToggle()) visible.add('section-general');
    if (step.providerField()) visible.add('section-auth');
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
  private readonly isPopulatingForm = signal(false);
  private readonly dirtyProfileTypes = new Set<SharedProfileType>();

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  constructor() {
    this.editTarget.set(this.dialogData?.editTarget ?? null);
    this.cloneTarget.set(this.dialogData?.cloneTarget ?? false);

    this.remoteForm = this.createRemoteForm();
    this.remoteConfigForm = this.createRemoteConfigForm();

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
    this.remoteNameSignal = toSignal(
      this.remoteForm
        .get('name')!
        .valueChanges.pipe(startWith(this.remoteForm.get('name')!.value as string)),
      { initialValue: this.remoteForm.get('name')?.value ?? '' }
    );

    this.setupAuthStateListeners();
    this.destroyRef.onDestroy(() => this.authStateService.cancelAuth());
  }

  async ngOnInit(): Promise<void> {
    try {
      await Promise.all([
        this.loadExistingRemotes(),
        this.loadRemoteTypes(),
        this.loadAllFlagFields(),
        this.loadMountTypes(),
        this.loadServeTypes(),
      ]);
      await this.loadServeFields();
      this.initProfiles();
      this.initCurrentStep();
      await this.populateFormIfEditingOrCloning();
      this.setupAutoStartValidators();
    } finally {
      this.isInitializing.set(false);
    }
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

    // Auto-enter "add profile" mode when triggered from app detail.
    if (this.dialogData?.autoAddProfile && this.editTarget()) {
      const type = this.editTarget() as SharedProfileType;
      if (PROFILE_TYPES.includes(type)) {
        this.startAddProfile(type);
      }
    }
  }

  // ── Data loading ──────────────────────────────────────────────────────────────

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
      console.error('Error fetching mount types:', error);
    }
  }

  private async loadServeTypes(): Promise<void> {
    try {
      const types = await this.serveManagementService.getServeTypes();
      this.availableServeTypes.set(types);
      if (types.length > 0) this.selectedServeType.set(types[0]);
    } catch (error) {
      console.error('Error fetching serve types:', error);
    }
  }

  private async loadServeFields(): Promise<void> {
    const type = this.selectedServeType();
    if (!type) return;

    this.isLoadingServeFields.set(true);
    this.dynamicServeFields.set([]);
    try {
      this.dynamicServeFields.set(await this.flagConfigService.loadServeFlagFields(type));
      this.rebuildServeOptionsGroup();
    } catch (error) {
      console.error('Error loading serve config fields:', error);
    } finally {
      this.isLoadingServeFields.set(false);
    }
  }

  private async loadRuntimeRemoteFields(type: string): Promise<void> {
    if (!type) return;

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

    const currentRemoteType =
      String(this.remoteForm.get('type')?.value ?? '').trim() ||
      String(this.dialogData?.remoteType ?? '').trim();
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
        optionsGroup.addControl(
          uniqueKey,
          new FormControl(field.Value ?? field.Default, field.Required ? [Validators.required] : [])
        );
      });
    });
  }

  readonly getUniqueControlKey = (flagType: FlagType, field: RcConfigOption): string => {
    return flagType === 'serve' ? field.Name : `${flagType}---${field.Name}`;
  };

  // ── Form creation ─────────────────────────────────────────────────────────────

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
      group[`${flag}Config`] =
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
      source: this.fb.group({ pathType: ['currentRemote'], path: [''], otherRemoteName: [''] }),
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

  // ── Form setup ────────────────────────────────────────────────────────────────

  private static readonly AUTO_START_OP_TYPES = new Set(['sync', 'copy', 'move', 'bisync']);

  private setupAutoStartValidators(): void {
    if (this.editTarget() === 'remote' || !this.editTarget() || this.cloneTarget()) {
      FLAG_TYPES.forEach(type => {
        if (type !== 'mount' && !RemoteConfigModalComponent.AUTO_START_OP_TYPES.has(type)) return;

        const opGroup = this.remoteConfigForm.get(`${type}Config`);
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
          const cronEnabledCtrl = opGroup.get('cronEnabled');
          const cronExpressionCtrl = opGroup.get('cronExpression');

          sourcePathCtrl?.setValidators(this.validatorRegistry.requiredIfLocal());
          destPathCtrl?.setValidators(this.validatorRegistry.requiredIfLocal());
          cronExpressionCtrl?.setValidators(this.validatorRegistry.requiredIfCronEnabled());

          autoStartCtrl?.valueChanges.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
            sourcePathCtrl?.updateValueAndValidity();
            destPathCtrl?.updateValueAndValidity();
          });
          cronEnabledCtrl?.valueChanges.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
            cronExpressionCtrl?.updateValueAndValidity();
          });
          sourcePathTypeCtrl?.valueChanges
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(() => sourcePathCtrl?.updateValueAndValidity());
          destPathTypeCtrl?.valueChanges
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(() => destPathCtrl?.updateValueAndValidity());
        }
      });
    }
  }

  private setupAuthStateListeners(): void {
    effect(() => {
      const isInProgress = this.authStateService.isAuthInProgress();
      this.setFormState(isInProgress);
    });
  }

  // ── Form population ───────────────────────────────────────────────────────────

  private async populateFormIfEditingOrCloning(): Promise<void> {
    if (!this.dialogData?.existingConfig) return;

    if (this.editTarget() === 'remote' || this.cloneTarget()) {
      const remoteSpecs = this.cloneTarget()
        ? this.dialogData.existingConfig['config']
        : this.dialogData.existingConfig;
      await this.populateRemoteForm(remoteSpecs);

      if (this.cloneTarget()) {
        const clonePromises: Promise<void>[] = [];

        this.FLAG_TYPES.forEach(type => {
          const configKey = REMOTE_CONFIG_KEYS[
            type as keyof typeof REMOTE_CONFIG_KEYS
          ] as keyof RemoteConfigSections;
          const configs = this.dialogData.existingConfig?.[configKey] as
            | Record<string, unknown>
            | undefined;
          if (configs && Object.keys(configs).length > 0) {
            clonePromises.push(
              this.populateProfileForm(type, Object.values(configs)[0] as Record<string, unknown>)
            );
          }
        });

        const runtimeConfigs = this.dialogData.existingConfig?.[
          REMOTE_CONFIG_KEYS.runtimeRemote
        ] as Record<string, unknown> | undefined;
        if (runtimeConfigs && Object.keys(runtimeConfigs).length > 0) {
          clonePromises.push(
            this.populateProfileForm(
              'runtimeRemote',
              Object.values(runtimeConfigs)[0] as Record<string, unknown>
            )
          );
        }

        await Promise.all(clonePromises);
      }
    } else if (this.editTarget()) {
      if (this.dialogData?.remoteType) {
        this.remoteForm.get('type')?.setValue(this.dialogData.remoteType, { emitEvent: false });
      }
      await this.syncRuntimeRemoteType();

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

      if (profile) await this.populateProfileForm(type, profile);
    }

    if (this.cloneTarget()) this.generateNewCloneName();
  }

  private async populateRemoteForm(config: Record<string, unknown>): Promise<void> {
    this.isPopulatingForm.set(true);
    this.remoteForm.patchValue({ name: config['name'], type: config['type'] });
    await this.onRemoteTypeChange();
    for (const [key, value] of Object.entries(config)) {
      if (key !== 'name' && key !== 'type' && !this.remoteForm.contains(key)) {
        this.remoteForm.addControl(key, new FormControl(value));
      }
    }

    this.remoteForm.patchValue(config);
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
          this.currentRemoteName(),
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
      const flagType = type as FlagType;
      const hasActualData = Object.keys(config).some(k => k !== 'name');

      const patchData: Record<string, unknown> = {
        autoStart: config['autoStart'] ?? false,
        cronEnabled: config['cronEnabled'] ?? false,
        cronExpression: config['cronExpression'] ?? null,
        vfsProfile: config['vfsProfile'] ?? DEFAULT_PROFILE_NAME,
        filterProfile: config['filterProfile'] ?? DEFAULT_PROFILE_NAME,
        backendProfile: config['backendProfile'] ?? DEFAULT_PROFILE_NAME,
        runtimeRemoteProfile: config['runtimeRemoteProfile'] ?? DEFAULT_PROFILE_NAME,
      };

      if (flagType === 'mount' && config['type'] !== undefined) patchData['type'] = config['type'];

      if (config['source'] !== undefined) {
        patchData['source'] = parseFsString(
          config['source'] as string,
          'currentRemote',
          this.currentRemoteName(),
          this.existingRemotes()
        );
      }
      if (config['dest'] !== undefined) {
        patchData['dest'] =
          flagType === 'mount'
            ? config['dest']
            : parseFsString(
                config['dest'] as string,
                'local',
                this.currentRemoteName(),
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

        const knownControlKeys = new Set(
          this.dynamicFlagFields()[flagType].map(f => this.getUniqueControlKey(flagType, f))
        );
        Object.keys(optionsGroup.controls).forEach(key => {
          if (!knownControlKeys.has(key)) {
            optionsGroup.removeControl(key, { emitEvent: false });
          }
        });

        if (config['options']) {
          Object.entries(config['options'] as Record<string, unknown>).forEach(
            ([fieldName, value]) => {
              const field = this.dynamicFlagFields()[flagType].find(f => f.FieldName === fieldName);
              if (field) {
                optionsGroup.get(this.getUniqueControlKey(flagType, field))?.setValue(value);
              } else {
                const controlKey = `${flagType}---${fieldName}`;
                const existing = optionsGroup.get(controlKey);
                if (existing) {
                  existing.setValue(value, { emitEvent: false });
                } else {
                  optionsGroup.addControl(controlKey, new FormControl(value), { emitEvent: false });
                }
              }
            }
          );
        }
      }
    }

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

  // ── Step navigation ───────────────────────────────────────────────────────────

  readonly applicableSteps = computed(() => {
    const editTargetValue = this.editTarget();
    if (!editTargetValue || editTargetValue === 'remote') {
      return this.stepConfigs().map((_, i) => i + 1);
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
    if (this.isStepNavigationLocked()) return true;
    return !this.editTarget() && step > 1 && this.remoteFormStatus() === 'INVALID';
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
    this.hostEl.nativeElement.querySelector('.modal-content')?.scrollTo(0, 0);
  }

  // ── Event handlers ────────────────────────────────────────────────────────────

  async onRemoteTypeChange(): Promise<void> {
    const remoteType = this.remoteForm.get('type')?.value;
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
      this.remoteForm.addControl(
        field.Name,
        new FormControl(field.Value ?? field.Default, field.Required ? [Validators.required] : [])
      );
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
    // In edit mode track every field so existing values aren't silently dropped on save.
    // In create mode track only actual user changes.
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

  // ── Form submission ───────────────────────────────────────────────────────────

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
      if (!this.interactiveFlowState().isActive) {
        this.authStateService.resetAuthState();
      }
    }
  }

  private async handleCreateMode(): Promise<{ success: boolean }> {
    PROFILE_TYPES.forEach(type => this.saveCurrentProfile(type));
    const remoteData = this.cleanFormData(this.remoteForm.getRawValue());
    const finalConfig = this.buildFinalConfig();
    await this.authStateService.startAuth(remoteData.name, false);

    const requiresInteractiveFlow = this.commandOptions().some(
      o => o.key === 'nonInteractive' && o.value === true
    );

    if (!requiresInteractiveFlow) {
      await this.remoteManagementService.createRemote(
        remoteData.name,
        remoteData,
        this.remoteManagementService.buildOpt(this.commandOptions())
      );
      this.pendingConfig = { remoteData, finalConfig };
      await this.finalizeRemoteCreation();
      return { success: true };
    }

    this.pendingConfig = { remoteData, finalConfig };
    return await this.startInteractiveRemoteConfig(remoteData);
  }

  private async handleEditMode(): Promise<{ success: boolean }> {
    const remoteName = this.currentRemoteName();
    await this.authStateService.startAuth(remoteName, true);

    const requiresInteractiveFlow = this.commandOptions().some(
      o => o.key === 'nonInteractive' && o.value === true
    );

    if (this.editTarget() === 'remote') {
      const remoteData = this.cleanFormData(this.remoteForm.getRawValue());
      if (requiresInteractiveFlow) {
        this.pendingConfig = { remoteData, finalConfig: this.createEmptyFinalConfig() };
        return await this.startInteractiveRemoteConfig(remoteData);
      }
      await this.remoteManagementService.updateRemote(remoteData.name, remoteData);
      return { success: true };
    }

    const updatedConfig = this.buildUpdateConfig();
    await this.appSettingsService.saveRemoteSettings(remoteName, updatedConfig);
    return { success: true };
  }

  // ── Config building ───────────────────────────────────────────────────────────

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

  readonly isNextDisabled = computed(() => {
    if (this.isAuthInProgress()) return true;

    if (this.currentStep() === 1) {
      if (this.remoteFormStatus() === 'INVALID') return true;
    } else {
      const stepType = this.stepConfigs()[this.currentStep() - 1]?.type;
      if (stepType && stepType !== 'remote') {
        const group = this.remoteConfigForm.get(`${stepType}Config`);
        if (group?.invalid) return true;
      }
    }

    return false;
  });

  readonly isSaveDisabled = computed(() => {
    if (this.isAuthInProgress()) return true;

    if (!this.editTarget()) {
      return this.remoteFormStatus() === 'INVALID' || this.remoteConfigFormStatus() === 'INVALID';
    }

    if (this.editTarget() === 'remote') {
      return this.remoteFormStatus() === 'INVALID';
    }

    const target = this.editTarget() as SharedProfileType;
    const group = this.remoteConfigForm.get(`${target}Config`);
    return group?.invalid ?? false;
  });

  readonly saveButtonLabel = computed(() => {
    if (this.editTarget() === 'remote') return 'modals.remoteConfig.buttons.save';
    if (this.editTarget()) return 'modals.remoteConfig.buttons.save';
    return 'modals.remoteConfig.buttons.create';
  });

  private buildUpdateConfig(): Record<string, unknown> {
    const target = this.editTarget() as SharedProfileType;
    if (!target) return {};

    this.saveCurrentProfile(target);

    this.dirtyProfileTypes.add(target);

    const updatedConfig: Record<string, unknown> = {};
    for (const dirty of this.dirtyProfileTypes) {
      const key = REMOTE_CONFIG_KEYS[dirty as keyof typeof REMOTE_CONFIG_KEYS];
      if (key) updatedConfig[key] = this.profiles()[dirty];
    }

    return updatedConfig;
  }

  private createEmptyFinalConfig(): RemoteConfigSections {
    const empty = Object.fromEntries(
      Object.values(REMOTE_CONFIG_KEYS).map(k => [k, {}])
    ) as unknown as RemoteConfigSections;
    return { ...empty, showOnTray: true };
  }

  // ── Profile management ────────────────────────────────────────────────────────

  saveCurrentStepProfile(): void {
    const editTargetValue = this.editTarget();
    const type =
      editTargetValue && editTargetValue !== 'remote'
        ? editTargetValue
        : this.stepConfigs()[this.currentStep() - 1]?.type;
    if (type && type !== 'remote') this.saveCurrentProfile(type as SharedProfileType);
  }

  isRenameProfileDisabled(type: string, profileName: string): boolean {
    const t = type as SharedProfileType;
    if (!profileName || profileName.toLowerCase() === DEFAULT_PROFILE_NAME) return true;
    if (!JOB_TYPES.has(t)) return false;

    const remoteName = this.currentRemoteName();
    if (!remoteName) return false;

    return this.getProfileUsage(t, remoteName, profileName).inUse;
  }

  isDeleteProfileDisabled(type: string, profileName: string): boolean {
    const t = type as SharedProfileType;
    const profileList = this.profileLists()[t] ?? [];

    if (!profileName || profileName.toLowerCase() === DEFAULT_PROFILE_NAME) return true;
    if (profileList.length <= 1) return true;

    if (!JOB_TYPES.has(t) && t !== 'mount' && t !== 'serve') return false;

    const remoteName = this.currentRemoteName();
    if (!remoteName) return false;

    return this.getProfileUsage(t, remoteName, profileName).inUse;
  }

  getRenameProfileDisabledReason(type: string, profileName: string): string {
    const t = type as SharedProfileType;

    if (!profileName || profileName.toLowerCase() === DEFAULT_PROFILE_NAME) {
      return this.translate.instant('modals.remoteConfig.profile.disabledReason.defaultProtected');
    }

    if (!JOB_TYPES.has(t)) return '';

    const remoteName = this.currentRemoteName();
    if (!remoteName) return '';

    const usage = this.getProfileUsage(t, remoteName, profileName);
    if (!usage.inUse) return '';

    return this.translate.instant('modals.remoteConfig.profile.disabledReason.inUse', {
      operation: this.getProfileUsageOperationLabel(t),
    });
  }

  getDeleteProfileDisabledReason(type: string, profileName: string): string {
    const t = type as SharedProfileType;
    const profileList = this.profileLists()[t] ?? [];

    if (!profileName || profileName.toLowerCase() === DEFAULT_PROFILE_NAME) {
      return this.translate.instant('modals.remoteConfig.profile.disabledReason.defaultProtected');
    }

    if (profileList.length <= 1) {
      return this.translate.instant('modals.remoteConfig.profile.disabledReason.lastProfile');
    }

    if (!JOB_TYPES.has(t) && t !== 'mount' && t !== 'serve') return '';

    const remoteName = this.currentRemoteName();
    if (!remoteName) return '';

    const usage = this.getProfileUsage(t, remoteName, profileName);
    if (!usage.inUse) return '';

    return this.translate.instant('modals.remoteConfig.profile.disabledReason.inUse', {
      operation: this.getProfileUsageOperationLabel(t),
    });
  }

  startAddProfile(type: string): void {
    const t = type as SharedProfileType;
    const existingNames = Object.keys(this.profiles()[t] ?? {});
    let counter = 1;
    while (existingNames.includes(`profile-${counter}`)) counter++;
    this.setProfileMode(t, 'add', `profile-${counter}`);
  }

  startEditProfile(type: string): void {
    const t = type as SharedProfileType;
    const currentName = this.selectedProfileName()[t];
    if (!currentName || currentName.toLowerCase() === DEFAULT_PROFILE_NAME) return;
    this.setProfileMode(t, 'edit', currentName);
  }

  cancelProfileEdit(type: string): void {
    this.setProfileMode(type as SharedProfileType, 'view');
  }

  saveProfile(type: string): void {
    const t = type as SharedProfileType;
    const state = this.profileState()[t];
    const newName = state.tempName.trim();
    if (!newName) return;

    if (state.mode === 'add') {
      this.profiles.update(p => ({ ...p, [t]: { ...p[t], [newName]: {} } }));
      this.selectProfile(t, newName);
    } else if (state.mode === 'edit') {
      const oldName = this.selectedProfileName()[t];
      if (oldName === newName) {
        this.cancelProfileEdit(t);
        return;
      }
      if (this.profiles()[t][newName] !== undefined) return;

      const profileData = this.profiles()[t][oldName];
      this.profiles.update(p => {
        const updated = { ...p, [t]: { ...p[t], [newName]: profileData } };
        delete updated[t][oldName];
        return updated;
      });
      this.selectedProfileName.update(s => ({ ...s, [t]: newName }));
      this.cascadeProfileRename(t, oldName, newName);
    }
    this.setProfileMode(t, 'view');
  }

  deleteProfile(type: string, name: string): void {
    const t = type as SharedProfileType;
    if (name.toLowerCase() === DEFAULT_PROFILE_NAME) return;

    const remoteName = this.currentRemoteName();
    if (remoteName) {
      const usage = this.getProfileUsage(t, remoteName, name);
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
      const rest = { ...p[t] };
      delete rest[name];
      return { ...p, [t]: rest };
    });

    if (this.selectedProfileName()[t] === name) {
      const remaining = Object.keys(this.profiles()[t] ?? {});
      if (remaining.length > 0) {
        this.selectProfile(t, remaining[0]);
      } else {
        this.profiles.update(p => ({ ...p, [t]: { [DEFAULT_PROFILE_NAME]: {} } }));
        this.selectProfile(t, DEFAULT_PROFILE_NAME);
      }
    }
  }

  selectProfile(type: EditTarget, name: string): void {
    if (!type) return;
    const t = type as SharedProfileType;
    if (!this.profiles()[t]?.[name]) return;
    this.saveCurrentProfile(t);
    this.selectedProfileName.update(prev => ({ ...prev, [t]: name }));
    void this.populateProfileForm(t, this.profiles()[t][name] as Record<string, unknown>);
  }

  saveCurrentProfile(type: EditTarget): void {
    if (!type) return;
    const t = type as SharedProfileType;
    const currentName = this.selectedProfileName()[t];
    if (!this.profiles()[t]?.[currentName]) return;
    const formValue = this.remoteConfigForm.get(`${t}Config`)?.getRawValue();
    if (!formValue) return;
    this.profiles.update(p => ({
      ...p,
      [t]: {
        ...p[t],
        [currentName]: this.buildProfileConfig(
          t,
          this.currentRemoteName(),
          formValue as Record<string, unknown>
        ),
      },
    }));
  }

  navigateToShared(type: EditTarget): void {
    if (!type) return;
    const current = this.editTarget();

    if (current && current !== 'remote') {
      this.saveCurrentProfile(current as SharedProfileType);
      this.dirtyProfileTypes.add(current as SharedProfileType);
    }
    if (current) {
      this.editStack.update(s => [...s, current as NonNullable<EditTarget>]);
    }

    this.editTarget.set(type);
    const idx = this.stepConfigs().findIndex(s => s.type === type);
    if (idx !== -1) this.currentStep.set(idx + 1);
  }

  returnFromShared(): void {
    const stack = this.editStack();
    if (stack.length === 0) return;

    const current = this.editTarget();

    if (current && current !== 'remote') {
      this.saveCurrentProfile(current as SharedProfileType);
      this.dirtyProfileTypes.add(current as SharedProfileType);
    }

    const target = stack[stack.length - 1];
    this.editStack.update(s => s.slice(0, -1));
    this.editTarget.set(target as EditTarget);
    const idx = this.stepConfigs().findIndex(s => s.type === target);
    if (idx !== -1) this.currentStep.set(idx + 1);
  }

  private buildProfileConfig(
    type: SharedProfileType,
    remoteName: string,
    configData: Record<string, unknown>
  ): Record<string, unknown> {
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
    const result: Record<string, unknown> = {};
    for (const key in configData) {
      result[key] =
        key === 'source' || key === 'dest'
          ? buildPathString(configData[key], remoteName)
          : configData[key];
    }

    const isMainOp = LINKED_PROFILE_TYPES.has(type as FlagType);
    if (isMainOp) {
      const runtimeOptions = this.profileOptions().runtimeRemote;
      const selectedProfile = String(result['runtimeRemoteProfile'] ?? '').trim();
      result['runtimeRemoteProfile'] = runtimeOptions.includes(selectedProfile)
        ? selectedProfile
        : DEFAULT_PROFILE_NAME;
    } else {
      delete result['vfsProfile'];
      delete result['filterProfile'];
      delete result['backendProfile'];
      delete result['runtimeRemoteProfile'];
    }

    result['options'] = this.cleanData(
      configData['options'] as Record<string, unknown>,
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

  // ── Data cleaning ─────────────────────────────────────────────────────────────

  private cleanFormData(formData: Record<string, unknown>): PendingRemoteData {
    const fieldsByName = new Map(this.dynamicRemoteFields().map(f => [f.Name, f]));

    const result: PendingRemoteData = {
      name: formData['name'] as string,
      type: formData['type'] as string,
    };

    for (const [key, value] of Object.entries(formData)) {
      if (key === 'name' || key === 'type') continue;
      const field = fieldsByName.get(key);
      if (field) {
        if (!this.isDefaultValue(value, field) || this.changedRemoteFields.has(key))
          result[field.FieldName || key] = value;
      } else if (value !== null && value !== undefined && value !== '') {
        result[key] = value;
      }
    }

    return result;
  }

  private cleanData(
    formData: Record<string, unknown>,
    fieldDefinitions: RcConfigOption[],
    flagType: FlagType
  ): Record<string, unknown> {
    const fieldMap = new Map<string, RcConfigOption>();
    fieldDefinitions.forEach(f => fieldMap.set(this.getUniqueControlKey(flagType, f), f));

    return Object.entries(formData).reduce(
      (acc, [key, value]) => {
        const field = fieldMap.get(key);
        if (field) {
          if (!this.isDefaultValue(value, field)) acc[field.FieldName] = value;
        } else if (value !== undefined && value !== null && value !== '') {
          const prefix = `${flagType}---`;
          const cleanKey = key.startsWith(prefix) ? key.slice(prefix.length) : key;
          acc[cleanKey] = value;
        }
        return acc;
      },
      {} as Record<string, unknown>
    );
  }

  private isDefaultValue(value: unknown, field: RcConfigOption): boolean {
    if (value === null || value === undefined) return true;
    const strVal = String(value);
    return strVal === String(field.Default) || strVal === String(field.DefaultStr) || strVal === '';
  }

  // ── Interactive flow ──────────────────────────────────────────────────────────

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
      this.remoteManagementService.buildOpt(this.commandOptions())
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

      const resp = await this.remoteManagementService.continueRemoteConfigInteractive(
        name,
        state.question.State,
        processedAnswer,
        paramRest,
        this.remoteManagementService.buildOpt(this.commandOptions())
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

  readonly isInteractiveContinueDisabled = computed(() => {
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

  // ── Finalization ──────────────────────────────────────────────────────────────

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
    if (mountConfigs) {
      for (const [profileName, config] of Object.entries(mountConfigs)) {
        if (config.autoStart && config.dest) {
          void this.mountManagementService.mountRemoteProfile(remoteName, profileName);
        }
      }
    }

    const jobStarters: Record<string, (remote: string, profile: string) => Promise<number>> = {
      copy: this.jobManagementService.startCopyProfile.bind(this.jobManagementService),
      sync: this.jobManagementService.startSyncProfile.bind(this.jobManagementService),
      bisync: this.jobManagementService.startBisyncProfile.bind(this.jobManagementService),
      move: this.jobManagementService.startMoveProfile.bind(this.jobManagementService),
    };

    for (const [jobType, starter] of Object.entries(jobStarters)) {
      const configs = finalConfig[
        REMOTE_CONFIG_KEYS[jobType as keyof typeof REMOTE_CONFIG_KEYS]
      ] as JobMap | undefined;
      if (!configs) continue;
      for (const [profileName, config] of Object.entries(configs)) {
        if (config.autoStart && config.source && config.dest) {
          void starter(remoteName, profileName);
        }
      }
    }

    const serveConfigs = finalConfig[REMOTE_CONFIG_KEYS.serve];
    if (serveConfigs) {
      for (const [profileName, config] of Object.entries(serveConfigs)) {
        if (config.autoStart && (config as Record<string, unknown>)['options']) {
          void this.serveManagementService.startServeProfile(remoteName, profileName);
        }
      }
    }
  }

  async cancelAuth(): Promise<void> {
    await this.authStateService.cancelAuth();
    this.interactiveFlowState.set(createInitialInteractiveFlowState());
  }

  // ── Utilities ─────────────────────────────────────────────────────────────────

  private cascadeProfileRename(type: SharedProfileType, oldName: string, newName: string): void {
    const remoteName = this.currentRemoteName();
    if (!remoteName) return;

    const onResult = (n: number): void => {
      if (n > 0) console.debug(`Updated ${n} ${type}(s) with new profile name: ${newName}`);
    };
    const onError = (err: unknown): void =>
      console.warn(`Failed to update ${type}s with new profile name:`, err);

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

  private getProfileUsageOperationLabel(type: SharedProfileType): string {
    if (JOB_TYPES.has(type)) return `${type} job`;
    if (type === 'mount') return 'mount';
    if (type === 'serve') return 'serve';
    return type;
  }

  private setProfileMode(
    type: SharedProfileType,
    mode: 'view' | 'edit' | 'add',
    tempName = ''
  ): void {
    this.profileState.update(state => ({ ...state, [type]: { mode, tempName } }));
  }

  public setProfileTempName(type: EditTarget, name: string): void {
    if (!type) return;
    const key = type as SharedProfileType;
    this.profileState.update(state => ({ ...state, [key]: { ...state[key], tempName: name } }));
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

  // ── Search ────────────────────────────────────────────────────────────────────

  toggleSearchVisibility(): void {
    this.isSearchVisible.update(visible => !visible);
    if (!this.isSearchVisible()) this.searchQuery.set('');
  }

  onSearchInput(query: string): void {
    this.searchQuery.set(query);
  }

  scrollToSection(sectionId: string): void {
    this.hostEl.nativeElement
      .querySelector('#' + sectionId)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' });
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
