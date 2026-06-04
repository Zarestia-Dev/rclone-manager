import { Injectable, Signal, computed, signal, inject, DestroyRef, effect } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  FormGroup,
  Validators,
  FormControl,
  FormArray,
  AbstractControl,
  FormBuilder,
} from '@angular/forms';
import { startWith } from 'rxjs';
import {
  EditTarget,
  FlagType,
  SharedProfileType,
  RemoteType,
  RemoteConfigSections,
  FLAG_TYPES,
  REMOTE_NAME_REGEX,
  DEFAULT_PROFILE_NAME,
  CommandOption,
  RcConfigOption,
  InteractiveFlowState,
  REMOTE_CONFIG_KEYS,
  LINKED_PROFILE_TYPES,
} from '@app/types';

import { AuthStateService } from '../security/auth-state.service';
import { ValidatorRegistryService } from '../ui/validation/validator-registry.service';
import { RemoteManagementService } from './remote-management.service';
import { MountManagementService } from '../operations/mount-management.service';
import { ServeManagementService } from '../operations/serve-management.service';
import { FlagConfigService } from './flag-config.service';
import { CliFlagMapperService, ImportResult } from './cli-flag-mapper.service';
import {
  createInitialInteractiveFlowState,
  getControlKey,
  mapFormToConfigProfile,
  mapConfigToFormProfile,
} from './utils/remote-config.utils';
import { PathService } from '../infrastructure/platform/path.service';
import { TranslateService } from '@ngx-translate/core';
import { NotificationService } from '../ui/notification.service';
import { JobManagementService } from '../operations/job-management.service';
import { IconService } from '../ui/icon.service';
import { RcloneValueMapperService } from './rclone-value-mapper.service';
import { staticFlagDefinitions } from './flag-definitions';

export interface StepConfig {
  readonly label: string;
  readonly icon: string;
  readonly type: string;
}

export interface DialogData {
  editTarget?: EditTarget;
  cloneTarget?: boolean;
  existingConfig?: RemoteConfigSections;
  name?: string;
  remoteType: string;
  targetProfile?: string;
  autoAddProfile?: boolean;
}

export interface PendingRemoteData {
  name: string;
  type: string;
  [key: string]: unknown;
}

const OPERATION_FIELDS = [
  'autoStart',
  'cronEnabled',
  'cronExpression',
  'watchEnabled',
  'watchDelay',
  'source',
  'dest',
] as const;

const FIELD_DEFAULTS: Record<string, unknown> = {
  autoStart: false,
  cronEnabled: false,
  watchEnabled: false,
  watchDelay: 5,
};

const FLAG_TYPE_FIELDS: Partial<Record<string, readonly string[]>> = {
  mount: ['autoStart', 'dest', 'source'],
  sync: OPERATION_FIELDS,
  copy: OPERATION_FIELDS,
  move: OPERATION_FIELDS,
  bisync: OPERATION_FIELDS,
};

@Injectable()
export class RemoteConfigStateService {
  private static readonly ARRAY_TYPES = new Set([
    'stringArray',
    'CommaSepList',
    'SpaceSepList',
    'Bits',
    'Encoding',
    'DumpFlags',
  ]);
  private static readonly LINKED_TYPES = new Set(['vfs', 'filter', 'backend', 'runtimeRemote']);

  // ── Services ──
  private readonly fb = inject(FormBuilder);
  private readonly authStateService = inject(AuthStateService);
  private readonly remoteManagementService = inject(RemoteManagementService);
  private readonly mountManagementService = inject(MountManagementService);
  private readonly serveManagementService = inject(ServeManagementService);
  private readonly flagConfigService = inject(FlagConfigService);
  private readonly cliFlagMapper = inject(CliFlagMapperService);
  private readonly validatorRegistry = inject(ValidatorRegistryService);
  private readonly iconService = inject(IconService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly jobManagementService = inject(JobManagementService);
  private readonly notificationService = inject(NotificationService);
  private readonly translate = inject(TranslateService);
  private readonly pathService = inject(PathService);
  private readonly valueMapper = inject(RcloneValueMapperService);

  // ── Form References & Setup ──
  readonly remoteForm: FormGroup = this.fb.group({
    name: ['', [Validators.required, Validators.pattern(REMOTE_NAME_REGEX)]],
    type: ['', [Validators.required]],
  });

  readonly remoteConfigForm = this.createRemoteConfigForm();

  readonly stepStatuses = Object.fromEntries(
    [...FLAG_TYPES, 'runtimeRemote'].map(type => {
      const fg =
        type === 'runtimeRemote'
          ? (this.remoteConfigForm.get('runtimeRemoteConfig') as FormGroup)
          : (this.remoteConfigForm.get(`${type}Config`) as FormGroup);
      return [
        type,
        toSignal(fg.statusChanges.pipe(startWith(fg.status)), { initialValue: fg.status }),
      ];
    })
  ) as Record<string, Signal<string>>;

  get runtimeRemoteConfigGroup(): FormGroup {
    return this.remoteConfigForm.get('runtimeRemoteConfig') as FormGroup;
  }

  // ── Form Status Signals ──
  readonly remoteFormStatus = toSignal(
    this.remoteForm.statusChanges.pipe(startWith(this.remoteForm.status)),
    { initialValue: this.remoteForm.status }
  );

  readonly remoteConfigFormStatus = toSignal(
    this.remoteConfigForm.statusChanges.pipe(startWith(this.remoteConfigForm.status)),
    { initialValue: this.remoteConfigForm.status }
  );

  readonly remoteTypeSignal = toSignal(
    this.remoteForm
      .get('type')!
      .valueChanges.pipe(startWith(this.remoteForm.get('type')!.value as string)),
    { initialValue: this.remoteForm.get('type')!.value as string }
  );

  readonly remoteNameSignal = toSignal(
    this.remoteForm
      .get('name')!
      .valueChanges.pipe(startWith(this.remoteForm.get('name')!.value as string)),
    { initialValue: this.remoteForm.get('name')!.value as string }
  );

  // ── Core signals ──
  readonly editTarget = signal<EditTarget>(null);
  readonly cloneTarget = signal(false);
  readonly editStack = signal<NonNullable<EditTarget>[]>([]);
  readonly currentStep = signal(1);
  readonly isInitializing = signal(true);
  readonly showCliImport = signal(false);
  readonly isSearchVisible = signal(false);
  readonly searchQuery = signal('');
  readonly showAdvancedOptions = signal(false);
  readonly commandOptions = signal<CommandOption[]>([]);

  // ── Static step definitions ──
  private static readonly STATIC_STEP_CONFIGS: readonly StepConfig[] = [
    { label: 'modals.remoteConfig.steps.mount', icon: 'mount', type: 'mount' },
    { label: 'modals.remoteConfig.steps.serve', icon: 'satellite-dish', type: 'serve' },
    { label: 'modals.remoteConfig.steps.sync', icon: 'sync', type: 'sync' },
    { label: 'modals.remoteConfig.steps.bisync', icon: 'right-left', type: 'bisync' },
    { label: 'modals.remoteConfig.steps.move', icon: 'move', type: 'move' },
    { label: 'modals.remoteConfig.steps.copy', icon: 'copy', type: 'copy' },
    { label: 'modals.remoteConfig.steps.filter', icon: 'filter', type: 'filter' },
    { label: 'modals.remoteConfig.steps.vfs', icon: 'vfs', type: 'vfs' },
    { label: 'modals.remoteConfig.steps.backend', icon: 'server', type: 'backend' },
    { label: 'modals.remoteConfig.steps.runtimeRemote', icon: 'gear', type: 'runtimeRemote' },
  ];

  // ── Auth / interactive signals ──
  readonly isAuthInProgress = this.authStateService.isAuthInProgress;
  readonly isAuthCancelled = this.authStateService.isAuthCancelled;
  readonly oauthUrl = this.authStateService.oauthUrl;
  readonly shouldShowRemoteOAuthFallback = this.authStateService.shouldShowRemoteOAuthFallback;

  readonly interactiveFlowState = signal<InteractiveFlowState>(createInitialInteractiveFlowState());

  // ── Loading signals ──
  readonly isRemoteConfigLoading = signal(false);
  readonly isLoadingServeFields = signal(false);
  readonly isLoadingRuntimeRemoteFields = signal(false);

  // ── Dynamic Options lists ──
  readonly remoteTypes = signal<RemoteType[]>([]);
  readonly existingRemotes = signal<string[]>([]);
  readonly mountTypes = signal<string[]>([]);
  readonly availableServeTypes = signal<string[]>([]);
  readonly selectedServeType = signal('http');

  // ── Field definitions ──
  readonly dynamicRemoteFields = signal<RcConfigOption[]>([]);
  readonly dynamicServeFields = signal<RcConfigOption[]>([]);
  readonly dynamicRuntimeRemoteFields = signal<RcConfigOption[]>([]);
  readonly dynamicFlagFields = signal<Record<FlagType, RcConfigOption[]>>(
    Object.fromEntries(FLAG_TYPES.map(t => [t, [] as RcConfigOption[]])) as Record<
      FlagType,
      RcConfigOption[]
    >
  );

  readonly allFlagFields = computed(
    () =>
      ({
        ...this.dynamicFlagFields(),
        runtimeRemote: this.dynamicRuntimeRemoteFields(),
      }) as Record<SharedProfileType, RcConfigOption[]>
  );

  readonly lookupTable = computed(() =>
    this.cliFlagMapper.buildLookupTable(this.allFlagFields(), this.remoteTypeSignal() || undefined)
  );

  // ── Profile configs ──
  readonly PROFILE_TYPES: SharedProfileType[] = [...FLAG_TYPES, 'runtimeRemote'];
  readonly LINKED_PROFILE_TYPES = LINKED_PROFILE_TYPES;
  readonly JOB_TYPES = new Set<SharedProfileType>(['sync', 'copy', 'move', 'bisync']);

  // ── Profile states ──
  readonly profileState = signal<
    Record<SharedProfileType, { mode: 'view' | 'edit' | 'add'; tempName: string }>
  >(this.profileRecord(() => ({ mode: 'view' as const, tempName: '' })));

  readonly profiles = signal<Record<SharedProfileType, Record<string, Record<string, any>>>>(
    this.profileRecord(() => ({}))
  );

  readonly selectedProfileName = signal<Record<SharedProfileType, string>>(
    this.profileRecord(() => DEFAULT_PROFILE_NAME)
  );

  readonly highlightedFields = signal<
    { controlKey: string; flagType: SharedProfileType; profileName: string }[]
  >([]);

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

  readonly profileLists = computed(
    (): Record<SharedProfileType, { name: string; [key: string]: unknown }[]> =>
      Object.fromEntries(
        this.PROFILE_TYPES.map(t => [
          t,
          Object.entries(this.profiles()[t] ?? {}).map(([name, data]) => ({
            name,
            ...(data as object),
          })),
        ])
      ) as Record<SharedProfileType, { name: string; [key: string]: unknown }[]>
  );

  readonly profileNamesMap = computed(
    (): Record<SharedProfileType, string[]> =>
      Object.fromEntries(
        this.PROFILE_TYPES.map(t => [t, Object.keys(this.profiles()[t] ?? {})])
      ) as Record<SharedProfileType, string[]>
  );

  readonly highlightedFieldsForActiveProfiles = computed(() => {
    const activeHighlights = new Set<string>();
    const selectedProfiles = this.selectedProfileName();

    this.highlightedFields().forEach(h => {
      if (selectedProfiles[h.flagType] === h.profileName) {
        activeHighlights.add(h.controlKey);
      }
    });

    return activeHighlights;
  });

  private profileRecord<T>(factory: () => T): Record<SharedProfileType, T> {
    return Object.fromEntries(this.PROFILE_TYPES.map(t => [t, factory()])) as Record<
      SharedProfileType,
      T
    >;
  }

  // ── Helpers ──
  readonly changedRemoteFields = new Set<string>();
  readonly optionToFlagTypeMap: Record<string, FlagType> = {};
  readonly optionToFieldNameMap: Record<string, string> = {};
  readonly isPopulatingForm = signal(false);
  readonly dirtyProfileTypes = new Set<SharedProfileType>();
  dialogData!: DialogData;

  // ── Computed states ──
  readonly currentRemoteName = computed(
    () => this.dialogData?.name ?? this.remoteNameSignal() ?? ''
  );

  readonly stepConfigs = computed((): StepConfig[] => {
    const remoteType = this.remoteTypeSignal() ?? '';
    const remoteIcon = this.iconService.getIconName(remoteType || 'hard-drive') ?? 'hard-drive';
    return [
      { label: 'modals.remoteConfig.steps.remoteConfig', icon: remoteIcon, type: 'remote' },
      ...RemoteConfigStateService.STATIC_STEP_CONFIGS,
    ];
  });

  readonly stepLabels = computed(() => this.stepConfigs().map(s => s.label));

  // ── Computed edit targets ──
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

  readonly activeStepType = computed<EditTarget>(() => {
    const target = this.editTarget();
    if (target) return target;
    return (this.stepConfigs()[this.currentStep() - 1]?.type as EditTarget) || null;
  });

  readonly isActiveStepInvalid = computed(() => {
    const activeType = this.activeStepType();
    if (!activeType || activeType === 'remote') return false;
    return this.isStepInvalid(activeType);
  });

  readonly isBackDisabled = computed(() => {
    return this.isAuthInProgress?.() ?? false;
  });

  readonly sharedReturnTarget = computed<EditTarget>(() => {
    const s = this.editStack();
    return s.length > 0 ? (s[s.length - 1] as EditTarget) : null;
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

  // ── Computed navigation ──
  readonly isStepNavigationLocked = computed(
    () => (this.isAuthInProgress?.() ?? false) || this.isRemoteConfigLoading()
  );

  readonly applicableSteps = computed(() => {
    const editTargetValue = this.editTarget();
    if (!editTargetValue || editTargetValue === 'remote') {
      return this.stepConfigs().map((_, i) => i + 1);
    }
    const index = this.stepConfigs().findIndex(s => s.type === editTargetValue);
    return index !== -1 ? [index + 1] : [1];
  });

  // ── Computed footer ──
  readonly oauthHelperUrl = computed(() =>
    (this.isAuthInProgress?.() ?? false) && !(this.isAuthCancelled?.() ?? false)
      ? (this.oauthUrl?.() ?? null)
      : null
  );

  readonly isNextDisabled = computed(() => {
    if (this.isAuthInProgress?.()) return true;

    if (this.currentStep() === 1) {
      if (this.remoteFormStatus?.() === 'INVALID') return true;
    } else {
      const stepType = this.stepConfigs()[this.currentStep() - 1]?.type;
      if (stepType && stepType !== 'remote') {
        return this.isStepInvalid(stepType);
      }
    }

    return false;
  });

  readonly isSaveDisabled = computed(() => {
    if (this.isAuthInProgress?.()) return true;

    const target = this.editTarget();

    if (!target) {
      return (
        this.remoteFormStatus?.() === 'INVALID' || this.remoteConfigFormStatus?.() === 'INVALID'
      );
    }

    if (target === 'remote') {
      return this.remoteFormStatus?.() === 'INVALID';
    }

    return this.isStepInvalid(target);
  });

  readonly isInteractiveContinueDisabled = computed(() => {
    const state = this.interactiveFlowState();
    return (
      state.isProcessing ||
      (state.question?.Option?.Type !== 'password' &&
        (state.answer == null || String(state.answer).trim() === '')) ||
      (this.isAuthCancelled?.() ?? false)
    );
  });

  readonly saveButtonLabel = computed(() =>
    this.editTarget() ? 'modals.remoteConfig.buttons.save' : 'modals.remoteConfig.buttons.create'
  );

  isStepInvalid(stepType: string): boolean {
    const statusSignal = this.stepStatuses[stepType];
    return statusSignal ? statusSignal() === 'INVALID' : false;
  }

  // ── Form creation methods ──
  private getFieldsForFlagType(type: string): readonly string[] {
    return FLAG_TYPE_FIELDS[type] ?? [];
  }

  createRemoteConfigForm(): FormGroup {
    const group: Record<string, AbstractControl> = {};

    for (const flag of FLAG_TYPES) {
      group[`${flag}Config`] =
        flag === 'serve'
          ? this.createServeConfigGroup()
          : this.createConfigGroup(flag, this.getFieldsForFlagType(flag));
    }
    group['runtimeRemoteConfig'] = this.createRuntimeRemoteConfigGroup('');

    return this.fb.group(group);
  }

  createRuntimeRemoteConfigGroup(initialType: string): FormGroup {
    return this.fb.group({
      type: [initialType, Validators.required],
    });
  }

  createSourcePathGroup(initial?: { type?: string; path?: string; remote?: string }): FormGroup {
    return this.fb.group({
      type: [initial?.type ?? 'currentRemote'],
      path: [initial?.path ?? '', [this.validatorRegistry.operationPathValidator()]],
      remote: [initial?.remote ?? ''],
    });
  }

  private createServeConfigGroup(): FormGroup {
    return this.fb.group({
      autoStart: [false],
      cronEnabled: [false],
      cronExpression: [null],
      source: this.createSourcePathGroup(),
      vfsProfile: [DEFAULT_PROFILE_NAME],
      filterProfile: [DEFAULT_PROFILE_NAME],
      backendProfile: [DEFAULT_PROFILE_NAME],
      runtimeRemoteProfile: [DEFAULT_PROFILE_NAME],
      options: this.fb.group({}),
    });
  }

  private createConfigGroup(
    flagType: string,
    fields: readonly string[],
    includeProfiles = true
  ): FormGroup {
    const group: Record<string, unknown> = {};

    for (const field of fields) {
      if (field in FIELD_DEFAULTS) {
        group[field] = [FIELD_DEFAULTS[field]];
      } else if (field !== 'source' && field !== 'dest') {
        group[field] = [''];
      }
    }

    if (fields.includes('source')) {
      const sourceGroup = this.createSourcePathGroup();
      group['source'] =
        flagType === 'mount' || flagType === 'serve' || flagType === 'bisync'
          ? sourceGroup
          : this.fb.array([sourceGroup]);
    }

    if (fields.includes('dest')) {
      group['dest'] = this.fb.group({
        type: ['local'],
        path: ['', [this.validatorRegistry.operationPathValidator()]],
        remote: [''],
      });
    }

    if (fields.includes('autoStart') && !fields.includes('type')) {
      group['cronExpression'] = [null];
    }

    if (includeProfiles && LINKED_PROFILE_TYPES.has(flagType)) {
      group['vfsProfile'] = [DEFAULT_PROFILE_NAME];
      group['filterProfile'] = [DEFAULT_PROFILE_NAME];
      group['backendProfile'] = [DEFAULT_PROFILE_NAME];
      group['runtimeRemoteProfile'] = [DEFAULT_PROFILE_NAME];
    }

    group['options'] = this.fb.group({});
    return this.fb.group(group);
  }

  addDynamicFieldsToForm(): void {
    const dynamicFields = this.dynamicFlagFields();
    for (const flagType of FLAG_TYPES) {
      const optionsGroup = this.remoteConfigForm.get(`${flagType}Config.options`) as FormGroup;
      if (!optionsGroup || !dynamicFields[flagType]) continue;

      for (const field of dynamicFields[flagType]) {
        const uniqueKey = getControlKey(field);
        this.optionToFlagTypeMap[uniqueKey] = flagType;
        this.optionToFieldNameMap[uniqueKey] = field.FieldName;
        optionsGroup.addControl(
          uniqueKey,
          new FormControl(field.Value ?? field.Default, field.Required ? [Validators.required] : [])
        );
      }
    }
  }

  replaceDynamicFormControls(): void {
    const dynamicRemoteFields = this.dynamicRemoteFields();
    for (const key of Object.keys(this.remoteForm.controls)) {
      if (key !== 'name' && key !== 'type') this.remoteForm.removeControl(key);
    }
    for (const field of dynamicRemoteFields) {
      this.remoteForm.addControl(
        field.Name,
        new FormControl(field.Value ?? field.Default, field.Required ? [Validators.required] : [])
      );
    }
  }

  replaceRuntimeRemoteFormControls(): void {
    const group = this.remoteConfigForm.get('runtimeRemoteConfig') as FormGroup;
    if (!group) return;
    for (const key of Object.keys(group.controls)) {
      if (key !== 'type') group.removeControl(key);
    }
    for (const field of this.dynamicRuntimeRemoteFields()) {
      group.addControl(field.Name, new FormControl(field.Value ?? field.Default));
    }
  }

  rebuildServeOptionsGroup(): void {
    const optionsGroup = this.remoteConfigForm.get('serveConfig.options') as FormGroup;
    if (!optionsGroup) return;

    const typeControl = optionsGroup.get('type');

    for (const key of Object.keys(optionsGroup.controls)) {
      if (key !== 'type') {
        optionsGroup.removeControl(key);
      }
    }

    if (!typeControl) {
      optionsGroup.addControl('type', new FormControl('http'));
    }

    for (const field of this.dynamicServeFields()) {
      if (field.FieldName === 'type' || field.Name === 'type') continue;
      optionsGroup.addControl(
        getControlKey(field, 'serve'),
        new FormControl(field.Value ?? field.Default, field.Required ? [Validators.required] : [])
      );
    }
  }

  private cleanData(
    formData: Record<string, unknown>,
    fieldDefinitions: RcConfigOption[],
    type?: string
  ): Record<string, unknown> {
    const fieldMap = new Map(fieldDefinitions.map(f => [getControlKey(f, type), f]));

    return Object.entries(formData).reduce(
      (acc, [key, value]) => {
        const field = fieldMap.get(key);
        if (field) {
          if (!this.valueMapper.isDefaultValue(value, field)) {
            const outKey = type === 'serve' ? field.Name || field.FieldName : field.FieldName;
            acc[outKey] = value;
          }
        } else if (value !== undefined && value !== null && value !== '') {
          acc[key] = value;
        }
        return acc;
      },
      {} as Record<string, unknown>
    );
  }

  getRuntimeRemoteOptions(
    remoteName: string,
    config: Record<string, unknown>
  ): Record<string, unknown> {
    if (
      config[remoteName] &&
      typeof config[remoteName] === 'object' &&
      !Array.isArray(config[remoteName])
    ) {
      return config[remoteName] as Record<string, unknown>;
    }
    return config;
  }

  private buildRuntimeRemoteOptions(
    remoteName: string,
    configData: Record<string, unknown>
  ): Record<string, unknown> {
    const options = this.dynamicRuntimeRemoteFields().reduce(
      (acc, field) => {
        if (!Object.prototype.hasOwnProperty.call(configData, field.Name)) return acc;
        const value = configData[field.Name];
        if (!this.valueMapper.isDefaultValue(value, field))
          acc[field.FieldName || field.Name] = value;
        return acc;
      },
      {} as Record<string, unknown>
    );
    return { [remoteName]: options };
  }

  buildProfileConfig(
    type: SharedProfileType,
    remoteName: string,
    configData: Record<string, unknown>
  ): Record<string, unknown> {
    if (type === 'runtimeRemote') {
      return this.buildRuntimeRemoteOptions(remoteName, configData);
    }

    if (type === 'vfs' || type === 'filter' || type === 'backend') {
      return this.cleanData(
        (configData['options'] as Record<string, unknown>) ?? {},
        this.dynamicFlagFields()[type as FlagType] ?? [],
        type
      );
    }

    const flatDefs = staticFlagDefinitions[type] || [];
    const flatOptionNames = new Set(flatDefs.map(f => f.FieldName || f.Name));

    return mapFormToConfigProfile(type, configData, {
      remoteName,
      pathService: this.pathService,
      runtimeRemoteProfileNames: this.profileOptions().runtimeRemote,
      cleanData: (opts, fields) => this.cleanData(opts, fields, type),
      dynamicFields:
        type === 'serve'
          ? this.dynamicServeFields()
          : (this.dynamicFlagFields()[type as FlagType] ?? []),
      flatOptionNames,
    });
  }

  cleanFormData(formData: Record<string, unknown>): PendingRemoteData {
    const fieldsByName = new Map(this.dynamicRemoteFields().map(f => [f.Name, f]));
    const result: PendingRemoteData = {
      name: formData['name'] as string,
      type: formData['type'] as string,
    };

    for (const [key, value] of Object.entries(formData)) {
      if (key === 'name' || key === 'type') continue;
      const field = fieldsByName.get(key);
      if (field) {
        if (!this.valueMapper.isDefaultValue(value, field) || this.changedRemoteFields.has(key)) {
          result[field.FieldName || key] = value;
        }
      } else if (value !== null && value !== undefined && value !== '') {
        result[key] = value;
      }
    }

    return result;
  }

  constructor() {
    effect(() => {
      const isInProgress = this.isAuthInProgress();
      this.setFormState(isInProgress);
    });
  }

  // ── Initializer ──
  async init(dialogData: DialogData): Promise<void> {
    this.dialogData = dialogData;
    this.editTarget.set(dialogData?.editTarget ?? null);
    this.cloneTarget.set(dialogData?.cloneTarget ?? false);

    this.refreshRemoteNameValidator();

    await Promise.all([
      this.loadExistingRemotes(),
      this.loadRemoteTypes(),
      this.loadMountTypes(),
      this.loadServeTypes(),
    ]);
    await this.loadAllFlagFields();
    await this.loadServeFields();

    this.initProfiles(
      this.dialogData,
      this.dialogData?.autoAddProfile,
      this.editTarget() as SharedProfileType
    );
    this.initCurrentStep();
    await this.populateFormIfEditingOrCloning();
    this.setupAutoStartValidators();
  }

  // ── Private loaders ──
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
    const fields = await this.flagConfigService.loadAllFlagFields();
    this.dynamicFlagFields.set(fields);

    if (fields.mount) {
      const mountTypeOpt = fields.mount.find(f => f.Name === 'mountType');
      if (mountTypeOpt) {
        mountTypeOpt.Examples = this.mountTypes().map(t => ({ Value: t, Help: t }));
      }
    }

    if (fields.serve) {
      const serveTypeOpt = fields.serve.find(f => f.Name === 'type');
      if (serveTypeOpt) {
        serveTypeOpt.Examples = this.availableServeTypes().map(t => ({ Value: t, Help: t }));
      }
    }

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
      const fields = await this.flagConfigService.loadServeFlagFields(type);
      const serveTypeOpt = fields.find(f => f.Name === 'type');
      if (serveTypeOpt) {
        serveTypeOpt.Examples = this.availableServeTypes().map(t => ({ Value: t, Help: t }));
      }
      this.dynamicServeFields.set(fields);
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

  async syncRuntimeRemoteType(): Promise<void> {
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

  formControl(path: string): FormControl {
    return this.remoteConfigForm.get(path) as FormControl;
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

  private static readonly AUTO_START_OP_TYPES = new Set([
    'serve',
    'sync',
    'copy',
    'move',
    'bisync',
  ]);

  private setupAutoStartValidators(): void {
    if (this.editTarget() === 'remote' || !this.editTarget() || this.cloneTarget()) {
      for (const type of FLAG_TYPES) {
        if (type !== 'mount' && !RemoteConfigStateService.AUTO_START_OP_TYPES.has(type)) continue;

        const opGroup = this.remoteConfigForm.get(`${type}Config`);
        if (opGroup instanceof FormGroup) {
          this.validatorRegistry.setupOperationValidation(opGroup, this.destroyRef);
        }
      }
    }
  }

  private setFormState(disabled: boolean): void {
    const opts = { emitEvent: false } as const;
    if (disabled) {
      if (this.remoteForm.enabled) this.remoteForm.disable(opts);
      if (this.remoteConfigForm.enabled) this.remoteConfigForm.disable(opts);
    } else {
      const shouldEnableRemote = !(this.editTarget() && this.editTarget() !== 'remote');
      if (shouldEnableRemote) {
        if (this.remoteForm.disabled) this.remoteForm.enable(opts);
      } else {
        if (this.remoteForm.enabled) this.remoteForm.disable(opts);
      }
      if (this.remoteConfigForm.disabled) this.remoteConfigForm.enable(opts);
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

  // ── Profile CRUD & Initialization ──
  initProfiles(
    dialogData: DialogData,
    autoAddProfile?: boolean,
    editTarget?: SharedProfileType
  ): void {
    const newProfiles = { ...this.profiles() };
    const newSelectedNames = { ...this.selectedProfileName() };

    this.PROFILE_TYPES.forEach(type => {
      const multiKey = REMOTE_CONFIG_KEYS[type as keyof typeof REMOTE_CONFIG_KEYS];
      const multiVal = dialogData?.existingConfig?.[multiKey] as
        | Record<string, unknown>
        | undefined;

      newProfiles[type] =
        multiVal && Object.keys(multiVal).length > 0
          ? ({ ...multiVal } as Record<string, Record<string, any>>)
          : { [DEFAULT_PROFILE_NAME]: {} };

      const profileNames = Object.keys(newProfiles[type]);
      const targetProfile = dialogData?.targetProfile;
      newSelectedNames[type] =
        targetProfile && profileNames.includes(targetProfile)
          ? targetProfile
          : (profileNames[0] ?? DEFAULT_PROFILE_NAME);
    });

    this.profiles.set(newProfiles);
    this.selectedProfileName.set(newSelectedNames);

    if (autoAddProfile && editTarget) {
      if (this.PROFILE_TYPES.includes(editTarget)) {
        this.startAddProfile(editTarget);
      }
    }
  }

  private getProfileActionState(
    type: string,
    profileName: string,
    action: 'rename' | 'delete'
  ): { disabled: boolean; reason: string } {
    const t = type as SharedProfileType;
    const profileList = this.profileLists()[t] ?? [];

    if (!profileName || profileName.toLowerCase() === DEFAULT_PROFILE_NAME) {
      return {
        disabled: true,
        reason: this.translate.instant(
          'modals.remoteConfig.profile.disabledReason.defaultProtected'
        ),
      };
    }

    if (action === 'delete' && profileList.length <= 1) {
      return {
        disabled: true,
        reason: this.translate.instant('modals.remoteConfig.profile.disabledReason.lastProfile'),
      };
    }

    if (action === 'rename' && !this.JOB_TYPES.has(t)) {
      return { disabled: false, reason: '' };
    }

    if (action === 'delete' && !this.JOB_TYPES.has(t) && t !== 'mount' && t !== 'serve') {
      return { disabled: false, reason: '' };
    }

    const currentRemoteName = this.currentRemoteName();
    if (!currentRemoteName) {
      return { disabled: false, reason: '' };
    }

    const usage = this.getProfileUsage(t, profileName);
    if (!usage.inUse) {
      return { disabled: false, reason: '' };
    }

    return {
      disabled: true,
      reason: this.translate.instant('modals.remoteConfig.profile.disabledReason.inUse', {
        operation: this.getProfileUsageOperationLabel(t),
      }),
    };
  }

  isRenameProfileDisabled(type: string, profileName: string): boolean {
    return this.getProfileActionState(type, profileName, 'rename').disabled;
  }

  isDeleteProfileDisabled(type: string, profileName: string): boolean {
    return this.getProfileActionState(type, profileName, 'delete').disabled;
  }

  getRenameProfileDisabledReason(type: string, profileName: string): string {
    return this.getProfileActionState(type, profileName, 'rename').reason;
  }

  getDeleteProfileDisabledReason(type: string, profileName: string): string {
    return this.getProfileActionState(type, profileName, 'delete').reason;
  }

  getProfileUsage(
    type: SharedProfileType,
    profileName: string
  ): { inUse: boolean; count: number; opType: string } {
    const remoteName = this.currentRemoteName();
    if (this.JOB_TYPES.has(type)) {
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
    if (this.JOB_TYPES.has(type)) return `${type} job`;
    if (type === 'mount') return 'mount';
    if (type === 'serve') return 'serve';
    return type;
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
    this.dirtyProfileTypes.add(t);
    const state = this.profileState()[t];
    const newName = state.tempName.trim();
    if (!newName) return;

    if (state.mode === 'add') {
      this.profiles.update(p => ({ ...p, [t]: { ...p[t], [newName]: {} } }));
      void this.selectProfile(t, newName);
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
    this.dirtyProfileTypes.add(t);
    if (name.toLowerCase() === DEFAULT_PROFILE_NAME) return;

    const currentRemoteName = this.currentRemoteName();
    if (currentRemoteName) {
      const usage = this.getProfileUsage(t, name);
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
        void this.selectProfile(t, remaining[0]);
      } else {
        this.profiles.update(p => ({ ...p, [t]: { [DEFAULT_PROFILE_NAME]: {} } }));
        void this.selectProfile(t, DEFAULT_PROFILE_NAME);
      }
    }
  }

  setProfileTempName(type: string, name: string): void {
    this.profileState.update(prev => ({
      ...prev,
      [type]: { ...prev[type as SharedProfileType], tempName: name },
    }));
  }

  setProfileMode(type: SharedProfileType, mode: 'view' | 'edit' | 'add', tempName = ''): void {
    this.profileState.update(prev => ({
      ...prev,
      [type]: { mode, tempName },
    }));
  }

  private async cascadeProfileRename(
    type: SharedProfileType,
    oldName: string,
    newName: string
  ): Promise<void> {
    const currentRemoteName = this.currentRemoteName();
    if (!currentRemoteName) return;

    try {
      let updatedCount = 0;
      if (type === 'mount') {
        updatedCount = await this.mountManagementService.renameProfileInMountCache(
          currentRemoteName,
          oldName,
          newName
        );
      } else if (type === 'serve') {
        updatedCount = await this.serveManagementService.renameProfileInServeCache(
          currentRemoteName,
          oldName,
          newName
        );
      }
      if (updatedCount > 0) {
        console.debug(`Updated ${updatedCount} ${type}(s) with new profile name: ${newName}`);
      }
    } catch (err) {
      console.warn(`Failed to update ${type}s with new profile name:`, err);
    }
  }

  highlightField(key: string, flagType: SharedProfileType, profileName: string): void {
    this.highlightedFields.update(list => {
      if (
        list.some(
          h => h.controlKey === key && h.flagType === flagType && h.profileName === profileName
        )
      ) {
        return list;
      }
      return [...list, { controlKey: key, flagType, profileName }];
    });
  }

  updateProfileConfig(
    type: SharedProfileType,
    name: string,
    config: Record<string, unknown>
  ): void {
    this.profiles.update(p => ({
      ...p,
      [type]: {
        ...p[type],
        [name]: config,
      },
    }));
  }

  // ── Profile selection ──
  async selectProfile(type: EditTarget, name: string): Promise<void> {
    if (!type) return;
    const t = type as SharedProfileType;
    if (!this.profiles()[t]?.[name]) return;

    const currentName = this.selectedProfileName()[t];
    if (currentName && this.profiles()[t]?.[currentName]) {
      this.saveCurrentProfile(t);
    }
    this.selectedProfileName.update(prev => ({ ...prev, [t]: name }));

    await this.populateProfileForm(t, this.profiles()[t][name] as Record<string, unknown>);
  }

  async selectLinkedProfile(type: SharedProfileType, name: string): Promise<void> {
    const list = this.profileNamesMap()[type] || [];
    const actualName = list.includes(name) ? name : list[0] || DEFAULT_PROFILE_NAME;
    this.selectedProfileName.update(prev => ({ ...prev, [type]: actualName }));

    const config = this.profiles()[type]?.[actualName] as Record<string, unknown>;
    if (config) {
      await this.populateProfileForm(type, config);
    }
  }

  saveCurrentProfile(type: EditTarget): void {
    if (!type) return;
    const t = type as SharedProfileType;
    const currentName = this.selectedProfileName()[t];
    if (!currentName) return;

    const group = this.remoteConfigForm.get(`${t}Config`);
    if (!group) return;

    const cleaned = this.buildProfileConfig(
      t,
      this.currentRemoteName(),
      group.value as Record<string, unknown>
    );
    this.updateProfileConfig(t, currentName, cleaned);
  }

  private saveCurrentAndMarkDirty(target: NonNullable<EditTarget>): void {
    if (target !== 'remote') {
      this.saveCurrentProfile(target as SharedProfileType);
      this.dirtyProfileTypes.add(target as SharedProfileType);
    }
  }

  navigateToShared(type: EditTarget): void {
    if (!type) return;
    const current = this.editTarget();
    if (current) this.saveCurrentAndMarkDirty(current);
    if (current) this.editStack.update(s => [...s, current as NonNullable<EditTarget>]);

    this.editTarget.set(type);
    const idx = this.stepConfigs().findIndex(s => s.type === type);
    if (idx !== -1) this.currentStep.set(idx + 1);
  }

  returnFromShared(): void {
    const stack = this.editStack();
    if (stack.length === 0) return;

    const returnTarget = stack[stack.length - 1];
    const current = this.editTarget();
    if (current) this.saveCurrentAndMarkDirty(current);

    this.editStack.update(s => s.slice(0, -1));
    this.editTarget.set(returnTarget);

    const idx = this.stepConfigs().findIndex(s => s.type === returnTarget);
    if (idx !== -1) this.currentStep.set(idx + 1);
  }

  // ── Event Handlers ──
  async onServeTypeChange(type: string): Promise<void> {
    const currentType = this.selectedServeType();
    if (currentType === type && this.dynamicServeFields().length > 0) {
      return;
    }
    this.selectedServeType.set(type || 'http');
    this.remoteConfigForm.get('serveConfig.options.type')?.setValue(type, { emitEvent: false });
    await this.loadServeFields();
  }

  async onRemoteTypeChange(): Promise<void> {
    const remoteType = this.remoteForm.get('type')?.value as string;
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

  onRemoteFieldChanged(fieldName: string, isChanged: boolean): void {
    if (this.isPopulatingForm()) return;
    if (isChanged || this.editTarget() === 'remote') {
      this.changedRemoteFields.add(fieldName);
    } else {
      this.changedRemoteFields.delete(fieldName);
    }
  }

  toggleCliImportVisibility(): void {
    if (this.currentStep() === 1 && !this.editTarget()) return;
    this.showCliImport.update(v => !v);
  }

  async applyImportResult(event: {
    result: ImportResult;
    profileName: string;
    mode: 'new' | 'override' | 'patch';
  }): Promise<void> {
    const { result, profileName, mode } = event;
    const targetType = (result.verb || this.editTarget() || 'sync') as SharedProfileType;

    if (mode === 'new') {
      this.setProfileMode(targetType, 'view');
      this.profiles.update(p => ({
        ...p,
        [targetType]: { ...p[targetType], [profileName]: {} },
      }));
      await this.selectProfile(targetType, profileName);
    } else if (mode === 'override') {
      await this.selectProfile(targetType, profileName);
    }

    const activeProfileName =
      mode === 'patch'
        ? this.selectedProfileName()[targetType] || DEFAULT_PROFILE_NAME
        : profileName;

    if (this.editTarget() && this.editTarget() !== targetType) {
      this.editTarget.set(targetType);
    }

    const stepIdx = this.stepConfigs().findIndex(s => s.type === targetType);
    if (stepIdx !== -1) {
      this.currentStep.set(stepIdx + 1);
    }

    const group = this.remoteConfigForm.get(`${targetType}Config`) as FormGroup;
    if (!group) return;

    if (targetType === 'serve' && result.serveSubtype) {
      await this.onServeTypeChange(result.serveSubtype);
    }
    if (targetType === 'mount' && result.mountSubtype) {
      group.get('options.mountType')?.setValue(result.mountSubtype);
    }

    // 1. Contextual handling of absolute paths
    this.applyImportPaths(group, result);

    // 2. Process linked sub-profiles safely
    const processedLinkedTypes = new Set<SharedProfileType>();
    await this.applyImportLinkedProfiles(
      group,
      result,
      activeProfileName,
      processedLinkedTypes,
      mode
    );

    // 3. Write flags directly using atomic assignments
    this.applyImportFlags(group, result, targetType, activeProfileName);

    processedLinkedTypes.forEach(flagType => this.dirtyProfileTypes.add(flagType));
    this.dirtyProfileTypes.add(targetType);
    this.showCliImport.set(false);

    this.dirtyProfileTypes.forEach(flagType => {
      this.saveCurrentProfile(flagType);
    });
  }

  private applyImportPaths(group: FormGroup, result: ImportResult): void {
    if (result.sourcePath) {
      const sourceCtrl = group.get('source');
      const parsedSource = this.pathService.parseFsString(
        result.sourcePath,
        'currentRemote',
        this.currentRemoteName(),
        this.existingRemotes()
      );

      if (sourceCtrl instanceof FormArray) {
        sourceCtrl.clear();
        sourceCtrl.push(this.createSourcePathGroup(parsedSource));
      } else {
        sourceCtrl?.patchValue(parsedSource);
      }
    }

    if (result.destPath) {
      group
        .get('dest')
        ?.patchValue(
          this.pathService.parseFsString(
            result.destPath,
            'local',
            this.currentRemoteName(),
            this.existingRemotes()
          )
        );
    }
  }

  private async applyImportLinkedProfiles(
    group: FormGroup,
    result: ImportResult,
    profileName: string,
    processedLinkedTypes: Set<SharedProfileType>,
    mode: 'new' | 'override' | 'patch'
  ): Promise<void> {
    const targetType = (result.verb || this.editTarget() || 'sync') as SharedProfileType;
    for (const cls of result.classified) {
      if (cls.status !== 'mapped' || !cls.fieldName) continue;

      const targetFlagType = (cls.flagType || targetType) as SharedProfileType;
      if (targetFlagType === targetType || processedLinkedTypes.has(targetFlagType)) continue;

      processedLinkedTypes.add(targetFlagType);
      const profileCtrl = group.get(`${targetFlagType}Profile`);
      if (!profileCtrl) continue;

      const currentProfileVal = profileCtrl.value || DEFAULT_PROFILE_NAME;
      if (mode !== 'patch' && currentProfileVal === DEFAULT_PROFILE_NAME) {
        const targetProfiles = this.profiles()[targetFlagType] ?? {};
        if (!targetProfiles[profileName]) {
          const defaultData = targetProfiles[DEFAULT_PROFILE_NAME] ?? {};
          this.profiles.update(p => ({
            ...p,
            [targetFlagType]: {
              ...p[targetFlagType],
              [profileName]: structuredClone(defaultData),
            },
          }));
        }
        profileCtrl.setValue(profileName);
        await this.selectLinkedProfile(targetFlagType, profileName);
      } else {
        await this.selectLinkedProfile(targetFlagType, currentProfileVal);
      }
    }
  }

  private applyImportFlags(
    group: FormGroup,
    result: ImportResult,
    targetType: SharedProfileType,
    profileName: string
  ): void {
    const arrayTypes = RemoteConfigStateService.ARRAY_TYPES;
    const linkedTypes = RemoteConfigStateService.LINKED_TYPES;
    const processedKeys = new Set<string>();

    for (const cls of result.classified) {
      if (cls.status !== 'mapped' || !cls.fieldName) continue;

      const fieldNameLower = cls.fieldName.toLowerCase();
      const targetFlagType = (cls.flagType || targetType) as SharedProfileType;
      const targetGroup = this.remoteConfigForm.get(`${targetFlagType}Config`) as FormGroup;
      const isRuntimeRemote = targetFlagType === 'runtimeRemote';

      const targetOptionsGroup = isRuntimeRemote
        ? targetGroup
        : (targetGroup?.get('options') as FormGroup);

      if (!targetOptionsGroup) continue;

      const fields = isRuntimeRemote
        ? this.dynamicRuntimeRemoteFields()
        : targetFlagType === 'serve'
          ? this.dynamicServeFields()
          : (this.dynamicFlagFields()[targetFlagType as FlagType] ?? []);
      const matchedField = fields.find(
        f =>
          f.Name?.toLowerCase() === fieldNameLower || f.FieldName?.toLowerCase() === fieldNameLower
      );
      if (!matchedField) continue;

      const uniqueKey = isRuntimeRemote
        ? matchedField.Name
        : getControlKey(matchedField, targetFlagType);
      const control = targetOptionsGroup.get(uniqueKey);
      if (!control) continue;

      if (arrayTypes.has(matchedField.Type)) {
        let newArray: unknown[] = [];

        if (processedKeys.has(uniqueKey)) {
          const currentVal = control.value;
          if (Array.isArray(currentVal)) {
            newArray = [...currentVal];
          } else if (typeof currentVal === 'string' && currentVal) {
            newArray = currentVal
              .split(matchedField.Type === 'SpaceSepList' ? /\s+/ : ',')
              .map(v => v.trim())
              .filter(Boolean);
          }
        }

        const coerced = cls.coercedValue;
        if (Array.isArray(coerced)) {
          coerced.forEach(v => {
            if (!newArray.includes(v)) newArray.push(v);
          });
        } else if (coerced != null && coerced !== '') {
          if (!newArray.includes(coerced)) newArray.push(coerced);
        }
        control.setValue(newArray);
      } else {
        control.setValue(cls.coercedValue);
      }

      control.markAsDirty();
      control.markAsTouched();
      processedKeys.add(uniqueKey);

      const targetProfileName = linkedTypes.has(targetFlagType)
        ? group.get(`${targetFlagType}Profile`)?.value || DEFAULT_PROFILE_NAME
        : profileName;

      this.highlightField(uniqueKey, targetFlagType, targetProfileName);
    }
  }

  private async populateFormIfEditingOrCloning(): Promise<void> {
    if (!this.dialogData?.existingConfig) return;

    if (this.editTarget() === 'remote' || this.cloneTarget()) {
      const remoteSpecs = this.cloneTarget()
        ? this.dialogData.existingConfig['config']
        : this.dialogData.existingConfig;
      await this.populateRemoteForm(remoteSpecs);

      if (this.cloneTarget()) {
        const clonePromises: Promise<void>[] = [];

        for (const type of FLAG_TYPES) {
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
        }

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
        this.remoteForm.get('type')?.setValue(this.dialogData.remoteType);
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
        this.remoteForm.get('type')?.setValue(remoteType);
      }

      if (profile) {
        await this.populateProfileForm(type, profile);
      }
    }

    if (this.cloneTarget()) {
      this.generateNewCloneName();
    }
  }

  async populateRemoteForm(config: Record<string, unknown>): Promise<void> {
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

  async populateProfileForm(
    type: SharedProfileType,
    config: Record<string, unknown>
  ): Promise<void> {
    this.isPopulatingForm.set(true);
    const group = this.remoteConfigForm.get(`${type}Config`);
    if (!group) {
      this.isPopulatingForm.set(false);
      return;
    }

    const currentRemoteName = this.currentRemoteName();

    if (type === 'runtimeRemote') {
      const options = this.getRuntimeRemoteOptions(currentRemoteName, config);
      const runtimeType =
        String(this.remoteForm.get('type')?.value ?? '').trim() ||
        (options['type'] as string) ||
        (config['type'] as string) ||
        '';
      group.get('type')?.setValue(runtimeType, { emitEvent: false });
      await this.loadRuntimeRemoteFields(runtimeType);
      for (const field of this.dynamicRuntimeRemoteFields()) {
        const value =
          options[field.FieldName] ?? options[field.Name] ?? field.Value ?? field.Default;
        group.get(field.Name)?.setValue(value, { emitEvent: false });
      }
      this.isPopulatingForm.set(false);
      return;
    }

    if (type === 'serve') {
      const serveType = ((config as any)['rclone']?.['type'] ??
        (config as any)['type'] ??
        'http') as string;
      this.selectedServeType.set(serveType);
      await this.loadServeFields();
    }

    const formValues = mapConfigToFormProfile(type, config, {
      remoteName: currentRemoteName,
      existingRemotes: this.existingRemotes(),
      pathService: this.pathService,
    });

    // 1. Patch basic/automation fields
    group.patchValue({
      autoStart: formValues['autoStart'],
      cronEnabled: formValues['cronEnabled'],
      cronExpression: formValues['cronExpression'],
      watchEnabled: formValues['watchEnabled'],
      watchDelay: formValues['watchDelay'],
      vfsProfile: formValues['vfsProfile'],
      filterProfile: formValues['filterProfile'],
      backendProfile: formValues['backendProfile'],
      runtimeRemoteProfile: formValues['runtimeRemoteProfile'],
    });

    // 2. Patch path fields (handling FormArray/FormGroup)
    const sourceCtrl = group.get('source');
    if (sourceCtrl instanceof FormArray) {
      sourceCtrl.clear();
      const sources = (formValues['source'] || []) as any[];
      if (sources.length === 0) {
        sourceCtrl.push(this.createSourcePathGroup());
      } else {
        for (const s of sources) {
          sourceCtrl.push(this.createSourcePathGroup(s));
        }
      }
    } else if (sourceCtrl instanceof FormGroup) {
      sourceCtrl.patchValue(formValues['source']);
    }

    const destCtrl = group.get('dest');
    if (destCtrl instanceof FormGroup) {
      destCtrl.patchValue(formValues['dest']);
    }

    // 3. Patch dynamic fields under 'options'
    const optionsGroup = group.get('options') as FormGroup;
    if (optionsGroup) {
      const typeCtrl = optionsGroup.get(type === 'serve' ? 'type' : 'mountType');
      for (const key of Object.keys(optionsGroup.controls)) {
        if (key !== 'type' && key !== 'mountType') {
          optionsGroup.removeControl(key);
        }
      }

      if (!typeCtrl && (type === 'serve' || type === 'mount')) {
        const ctrlName = type === 'serve' ? 'type' : 'mountType';
        optionsGroup.addControl(ctrlName, new FormControl(type === 'serve' ? 'http' : 'mount'));
      }

      const fields =
        type === 'serve'
          ? this.dynamicServeFields()
          : (this.dynamicFlagFields()[type as FlagType] ?? []);
      for (const field of fields) {
        if (
          field.FieldName === 'type' ||
          field.Name === 'type' ||
          field.FieldName === 'mountType' ||
          field.Name === 'mountType'
        )
          continue;
        const uniqueKey = getControlKey(field, type);
        optionsGroup.addControl(uniqueKey, new FormControl(field.Value ?? field.Default));
      }

      for (const [key, value] of Object.entries(formValues['options'] || {})) {
        if (key === 'fs') continue;
        const controlKey = getControlKey({ FieldName: key, Name: key } as RcConfigOption, type);
        const existing = optionsGroup.get(controlKey);
        if (existing) {
          existing.setValue(value, { emitEvent: false });
        } else {
          optionsGroup.addControl(controlKey, new FormControl(value), { emitEvent: false });
        }
      }
    }

    if (LINKED_PROFILE_TYPES.has(type)) {
      await this.selectLinkedProfile('vfs', formValues['vfsProfile']);
      await this.selectLinkedProfile('filter', formValues['filterProfile']);
      await this.selectLinkedProfile('backend', formValues['backendProfile']);
      await this.selectLinkedProfile('runtimeRemote', formValues['runtimeRemoteProfile']);
    }

    this.isPopulatingForm.set(false);
  }

  generateNewCloneName(): void {
    const base = `${this.remoteForm.get('name')?.value || 'remote'}-clone`;
    let name = base;
    let counter = 1;
    while (this.existingRemotes().includes(name)) {
      name = `${base}-${counter++}`;
    }
    this.remoteForm.get('name')?.setValue(name);
  }
}
