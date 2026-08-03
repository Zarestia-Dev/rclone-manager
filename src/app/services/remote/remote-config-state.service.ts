import { Injectable, Signal, computed, signal, inject, DestroyRef, effect } from '@angular/core';
import { FormGroup, Validators, FormControl, FormArray, FormBuilder } from '@angular/forms';
import { startWith } from 'rxjs';
import {
  EditTarget,
  SharedProfileType,
  RemoteType,
  FLAG_TYPES,
  REMOTE_NAME_REGEX,
  CommandOption,
  RcConfigOption,
  REMOTE_CONFIG_KEYS,
  LINKED_PROFILE_TYPES,
  RemoteSettings,
  FlagType,
  SYNC_TYPES,
  SENSITIVE_KEYS,
  PROFILE_ICONS,
  PendingRemoteData,
} from '@app/types';
import { INITIAL_COMMAND_OPTIONS } from './utils/command-options.util';
import { findUniqueName } from './utils/unique-name.util';

import { RemoteCreationOrchestrator } from './remote-creation-orchestrator.service';
import { AuthStateService } from '../security/auth-state.service';
import { AppSettingsService } from '../settings/app-settings.service';
import { ValidatorRegistryService } from '../ui/validation/validator-registry.service';
import { RemoteManagementService } from './remote-management.service';
import { MountManagementService } from '../operations/mount-management.service';
import { ServeManagementService } from '../operations/serve-management.service';
import { FlagConfigService } from './flag-config.service';
import { RemoteFacadeService } from '../facade/remote-facade.service';
import {
  mapFormToConfigProfile,
  mapConfigToFormProfile,
  OPERATION_PATH_MAPPINGS,
} from './utils/remote-config.utils';
import { PathService } from '../infrastructure/platform/path.service';
import { TranslateService } from '@ngx-translate/core';
import { NotificationService } from '../ui/notification.service';
import { JobManagementService } from '../operations/job-management.service';
import { IconService } from '../ui/icon.service';
import { RcloneValueMapperService } from './rclone-value-mapper.service';
import { staticFlagDefinitions } from './flag-definitions';
import { toSignal } from '@angular/core/rxjs-interop';
import { RemotePresetsService } from './remote-presets';
import { getRcloneCfg } from 'src/app/shared/utils/profile-config.util';
import { ImportResult } from './cli-flag-mapper.service';

export interface StepConfig {
  readonly label: string;
  readonly icon: string;
  readonly type: EditTarget;
}
export interface DialogData {
  editTarget?: EditTarget;
  name?: string;
  remoteType: string;
  targetProfile?: string;
  autoAddProfile?: boolean;
  cloneFrom?: string;
}

type ProfileConfigMap = Record<string, unknown>;

interface ProfileUsage {
  inUse: boolean;
  count: number;
  opType: string;
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
  check: OPERATION_FIELDS,
  archivecreate: OPERATION_FIELDS,
  cryptcheck: OPERATION_FIELDS,
  delete: ['autoStart', 'cronEnabled', 'cronExpression', 'watchEnabled', 'watchDelay', 'source'],
  copyurl: OPERATION_FIELDS,
};

@Injectable()
export class RemoteConfigStateService {
  private static readonly LINKED_TYPES = new Set(['vfs', 'filter', 'backend', 'runtimeRemote']);

  static readonly AUTO_PROFILE_NAME = 'Default';

  private readonly fb = inject(FormBuilder);
  private readonly authStateService = inject(AuthStateService);
  private readonly remoteManagementService = inject(RemoteManagementService);
  private readonly mountManagementService = inject(MountManagementService);
  private readonly serveManagementService = inject(ServeManagementService);
  private readonly flagConfigService = inject(FlagConfigService);
  private readonly validatorRegistry = inject(ValidatorRegistryService);
  private readonly iconService = inject(IconService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly jobManagementService = inject(JobManagementService);
  private readonly notificationService = inject(NotificationService);
  private readonly translate = inject(TranslateService);
  readonly pathService = inject(PathService);
  private readonly valueMapper = inject(RcloneValueMapperService);
  private readonly remoteFacade = inject(RemoteFacadeService);
  private readonly presetsService = inject(RemotePresetsService);
  private readonly orchestrator = inject(RemoteCreationOrchestrator);
  private readonly appSettingsService = inject(AppSettingsService);
  private existingConfig?: RemoteSettings | null;

  readonly remoteForm: FormGroup = this.fb.group({
    name: ['', [Validators.required, Validators.pattern(REMOTE_NAME_REGEX)]],
    type: ['', [Validators.required]],
  });

  readonly remoteConfigForm = this.createRemoteConfigForm();

  readonly stepStatuses = Object.fromEntries(
    [...FLAG_TYPES, 'runtimeRemote'].map(type => {
      const fg =
        type === 'runtimeRemote'
          ? this.runtimeRemoteConfigGroup
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

  readonly remoteFormStatus = toSignal(
    this.remoteForm.statusChanges.pipe(startWith(this.remoteForm.status)),
    { initialValue: this.remoteForm.status }
  );
  readonly remoteConfigFormStatus = toSignal(
    this.remoteConfigForm.statusChanges.pipe(startWith(this.remoteConfigForm.status)),
    { initialValue: this.remoteConfigForm.status }
  );
  readonly remoteTypeSignal = toSignal(
    this.remoteForm.controls['type'].valueChanges.pipe(
      startWith(this.remoteForm.controls['type'].value as string)
    ),
    { initialValue: this.remoteForm.controls['type'].value as string }
  );
  readonly remoteNameSignal = toSignal(
    this.remoteForm.controls['name'].valueChanges.pipe(
      startWith(this.remoteForm.controls['name'].value as string)
    ),
    { initialValue: this.remoteForm.controls['name'].value as string }
  );

  readonly editTarget = signal<EditTarget>(null);
  readonly cloneTarget = signal(false);
  readonly editStack = signal<NonNullable<EditTarget>[]>([]);
  readonly currentStep = signal(1);
  readonly isInitializing = signal(true);
  readonly showObscureTool = signal(false);
  readonly showCliImport = signal(false);
  readonly isSearchVisible = signal(false);
  readonly searchQuery = signal('');
  readonly showAdvancedOptions = signal(false);
  readonly commandOptions = signal<CommandOption[]>(INITIAL_COMMAND_OPTIONS);

  readonly isAuthInProgress = this.authStateService.isAuthInProgress;
  readonly isAuthCancelled = this.authStateService.isAuthCancelled;
  readonly oauthUrl = this.authStateService.oauthUrl;
  readonly interactiveFlowState = this.orchestrator.interactiveFlowState;

  readonly isRemoteConfigLoading = signal(false);
  readonly isLoadingServeFields = signal(false);
  readonly isLoadingRuntimeRemoteFields = signal(false);

  readonly remoteTypes = signal<RemoteType[]>([]);
  readonly existingRemotes = signal<string[]>([]);
  readonly mountTypes = signal<string[]>([]);
  readonly availableServeTypes = signal<string[]>([]);
  readonly selectedServeType = signal('http');

  readonly dynamicRemoteFields = signal<RcConfigOption[]>([]);
  readonly dynamicServeFields = signal<RcConfigOption[]>([]);
  readonly dynamicRuntimeRemoteFields = signal<RcConfigOption[]>([]);
  readonly dynamicFlagFields = signal<Record<FlagType, RcConfigOption[]>>(
    this.emptyFlagFieldsRecord()
  );

  private emptyFlagFieldsRecord(): Record<FlagType, RcConfigOption[]> {
    return Object.fromEntries(
      FLAG_TYPES.map(t => [t, [] as RcConfigOption[]])
    ) as unknown as Record<FlagType, RcConfigOption[]>;
  }

  readonly PROFILE_TYPES: SharedProfileType[] = [...FLAG_TYPES, 'runtimeRemote'];
  readonly JOB_TYPES = new Set<SharedProfileType>(SYNC_TYPES);

  readonly profileState = signal(
    this.profileRecord(() => ({ mode: 'view' as 'view' | 'edit' | 'add', tempName: '' }))
  );
  readonly profiles = signal(this.profileRecord(() => ({}) as ProfileConfigMap));
  readonly selectedProfileName = signal(this.profileRecord(() => null as string | null));
  readonly highlightedFields = signal<
    { controlKey: string; flagType: SharedProfileType; profileName: string }[]
  >([]);

  readonly profileOptions = computed(() => {
    const runtimeNames = Object.keys(this.profiles()['runtimeRemote'] ?? {});
    return {
      vfs: Object.keys(this.profiles()['vfs'] ?? {}),
      filter: Object.keys(this.profiles()['filter'] ?? {}),
      backend: Object.keys(this.profiles()['backend'] ?? {}),
      runtimeRemote: runtimeNames,
    };
  });

  readonly hasAnyProfile = computed(() => {
    const map = this.profileNamesMap();
    return Object.fromEntries(
      this.PROFILE_TYPES.map(t => [t, (map[t]?.length ?? 0) > 0])
    ) as Record<SharedProfileType, boolean>;
  });

  readonly profileLists = computed(() =>
    this.profileRecord(t =>
      Object.entries(this.profiles()[t] ?? {}).map(([name, data]) => ({
        name,
        ...((data && typeof data === 'object' ? (data as Record<string, unknown>) : {}) as Record<
          string,
          unknown
        >),
      }))
    )
  );
  readonly profileNamesMap = computed(() =>
    this.profileRecord(t => Object.keys(this.profiles()[t] ?? {}))
  );
  readonly highlightedFieldsForActiveProfiles = computed(() => {
    const active = new Set<string>();
    const selected = this.selectedProfileName();
    for (const h of this.highlightedFields()) {
      if (selected[h.flagType] === h.profileName) active.add(h.controlKey);
    }
    return active;
  });

  private profileRecord<T>(factory: (type: SharedProfileType) => T): Record<SharedProfileType, T> {
    return Object.fromEntries(this.PROFILE_TYPES.map(t => [t, factory(t)] as const)) as Record<
      SharedProfileType,
      T
    >;
  }

  readonly changedRemoteFields = new Set<string>();
  readonly isPopulatingForm = signal(false);
  readonly dirtyProfileTypes = new Set<SharedProfileType>();
  dialogData: DialogData = {} as DialogData;

  private profilePopulateGenerations = new Map<string, number>();

  private getGeneration(type: string): number {
    return this.profilePopulateGenerations.get(type) || 0;
  }

  private bumpGeneration(type: string): number {
    const next = (this.profilePopulateGenerations.get(type) || 0) + 1;
    this.profilePopulateGenerations.set(type, next);
    return next;
  }

  readonly currentRemoteName = computed(
    () => this.dialogData?.name || this.remoteNameSignal() || ''
  );
  readonly stepConfigs = computed<StepConfig[]>(() => [
    {
      label: 'modals.remoteConfig.steps.remoteConfig',
      icon: this.iconService.getIconName(this.remoteTypeSignal() || 'hard-drive') || 'hard-drive',
      type: 'remote',
    },
    ...FLAG_TYPES.map(type => ({
      label: `modals.remoteConfig.steps.${type}`,
      icon: PROFILE_ICONS[type] || type,
      type,
    })),
    { label: 'modals.remoteConfig.steps.runtimeRemote', icon: 'gear', type: 'runtimeRemote' },
  ]);

  readonly editTargetStepKey = computed(() =>
    this.editTarget()
      ? `modals.remoteConfig.steps.${this.editTarget() === 'remote' ? 'remoteConfig' : this.editTarget()}`
      : null
  );
  readonly activeProfileType = computed<SharedProfileType | null>(() => {
    const t = this.editTarget();
    return !t || t === 'remote' ? null : (t as SharedProfileType);
  });

  private getFieldsForStep(stepType: NonNullable<EditTarget>): RcConfigOption[] {
    if (stepType === 'remote') return this.dynamicRemoteFields();
    if (stepType === 'runtimeRemote') return this.dynamicRuntimeRemoteFields();
    if (stepType === 'serve') return this.dynamicServeFields();
    return this.dynamicFlagFields()[stepType] ?? [];
  }

  private getGroupForStep(stepType: NonNullable<EditTarget>): FormGroup | null {
    if (stepType === 'remote') return this.remoteForm;
    if (stepType === 'runtimeRemote') return this.runtimeRemoteConfigGroup;
    if (stepType === 'serve') {
      return this.remoteConfigForm.get('serveConfig.options') as FormGroup | null;
    }
    return this.remoteConfigForm.get(`${stepType}Config.options`) as FormGroup | null;
  }

  readonly activeSensitiveFields = computed(() => {
    const stepType = this.activeStepType();
    if (!stepType) return [];

    const fields = this.getFieldsForStep(stepType);
    if (!fields) return [];

    return fields
      .filter(field => {
        const name = (field.FieldName || field.Name || '').toLowerCase();
        return (
          field.IsPassword ||
          field.Name === 'pass' ||
          SENSITIVE_KEYS.some(key => name.includes(key))
        );
      })
      .map(field => {
        const key = field.Name || field.FieldName;
        const name = field.FieldName || field.Name || '';
        return {
          key,
          name,
          help: field.Help || '',
        };
      });
  });
  readonly activeStepType = computed(
    () =>
      this.editTarget() || (this.stepConfigs()[this.currentStep() - 1]?.type as EditTarget) || null
  );
  readonly isActiveStepInvalid = computed(() => {
    const t = this.activeStepType();
    return !t || t === 'remote' ? false : this.isStepInvalid(t);
  });
  readonly isBackDisabled = computed(() => this.isAuthInProgress());
  readonly sharedReturnTarget = computed(() => this.editStack().at(-1) || null);

  readonly sharedSidebarTypes = computed(() => {
    const target = this.editTarget();
    if (!target || target === 'remote') return [];
    return [
      { type: 'vfs' as const, icon: 'vfs', label: 'modals.remoteConfig.steps.vfs' },
      { type: 'filter' as const, icon: 'filter', label: 'modals.remoteConfig.steps.filter' },
      { type: 'backend' as const, icon: 'database', label: 'modals.remoteConfig.steps.backend' },
      {
        type: 'runtimeRemote' as const,
        icon: 'gear',
        label: 'modals.remoteConfig.steps.runtimeRemote',
      },
    ].filter(
      item =>
        item.type !== target &&
        (item.type !== 'vfs' || ['mount', 'serve', 'filter', 'backend'].includes(target))
    );
  });

  readonly isStepNavigationLocked = computed(
    () => this.isAuthInProgress() || this.isRemoteConfigLoading()
  );
  readonly applicableSteps = computed(() => {
    const t = this.editTarget();
    if (!t || t === 'remote') return this.stepConfigs().map((_, i) => i + 1);
    const idx = this.stepConfigs().findIndex(s => s.type === t);
    return idx !== -1 ? [idx + 1] : [1];
  });

  readonly linkedProfileSelectFields = computed<
    { type: 'vfs' | 'filter' | 'backend' | 'runtimeRemote'; labelKey: string; profileKey: string }[]
  >(() => {
    const t = this.stepConfigs()[this.currentStep() - 1]?.type;
    if (!t || !LINKED_PROFILE_TYPES.has(t)) return [];
    const showVfs = t === 'mount' || t === 'serve';
    const all = [
      {
        type: 'vfs' as const,
        labelKey: 'modals.remoteConfig.advancedProfiles.vfs',
        profileKey: 'vfsProfile',
      },
      {
        type: 'filter' as const,
        labelKey: 'modals.remoteConfig.advancedProfiles.filter',
        profileKey: 'filterProfile',
      },
      {
        type: 'backend' as const,
        labelKey: 'modals.remoteConfig.advancedProfiles.backend',
        profileKey: 'backendProfile',
      },
      {
        type: 'runtimeRemote' as const,
        labelKey: 'modals.remoteConfig.advancedProfiles.runtimeRemote',
        profileKey: 'runtimeRemoteProfile',
      },
    ];
    return showVfs ? all : all.slice(1);
  });

  isStepClickable(step: number): boolean {
    if (this.isStepNavigationLocked()) return false;
    if (step > this.currentStep()) {
      if (this.isActiveStepInvalid()) return false;
      if (!this.editTarget() && this.remoteFormStatus() === 'INVALID') return false;
    }
    return true;
  }

  readonly oauthHelperUrl = this.orchestrator.oauthHelperUrl;
  readonly isNextDisabled = computed(() => {
    if (this.isAuthInProgress()) return true;
    if (this.currentStep() === 1) return this.remoteFormStatus() === 'INVALID';
    const type = this.stepConfigs()[this.currentStep() - 1]?.type;
    return type && type !== 'remote' ? this.isStepInvalid(type) : false;
  });

  readonly isSaveDisabled = computed(() => {
    if (this.isAuthInProgress()) return true;
    const t = this.editTarget();
    if (!t)
      return this.remoteFormStatus() === 'INVALID' || this.remoteConfigFormStatus() === 'INVALID';
    return t === 'remote' ? this.remoteFormStatus() === 'INVALID' : this.isStepInvalid(t);
  });

  readonly isInteractiveContinueDisabled = this.orchestrator.isInteractiveContinueDisabled;

  readonly saveButtonLabel = computed(() =>
    this.editTarget() ? 'modals.remoteConfig.buttons.save' : 'modals.remoteConfig.buttons.create'
  );

  isStepInvalid(stepType: string): boolean {
    return this.stepStatuses[stepType]?.() === 'INVALID';
  }

  createRemoteConfigForm(): FormGroup {
    return this.fb.group(
      Object.fromEntries([
        ...FLAG_TYPES.map(flag => [
          `${flag}Config`,
          flag === 'serve'
            ? this.createServeConfigGroup()
            : this.createConfigGroup(flag, FLAG_TYPE_FIELDS[flag] ?? []),
        ]),
        ['runtimeRemoteConfig', this.fb.group({ type: ['', Validators.required] })],
      ])
    );
  }

  createSourcePathGroup(initial?: {
    type?: string;
    path?: string;
    remote?: string;
    filename?: string;
  }): FormGroup {
    return this.fb.group({
      type: [initial?.type || 'currentRemote'],
      path: [initial?.path || ''],
      remote: [initial?.remote || ''],
      filename: [initial?.filename || ''],
    });
  }

  private createServeConfigGroup(): FormGroup {
    return this.fb.group({
      autoStart: [false],
      cronEnabled: [false],
      cronExpression: [null],
      source: this.createSourcePathGroup(),
      vfsProfile: [RemoteConfigStateService.AUTO_PROFILE_NAME],
      filterProfile: [RemoteConfigStateService.AUTO_PROFILE_NAME],
      backendProfile: [RemoteConfigStateService.AUTO_PROFILE_NAME],
      runtimeRemoteProfile: [RemoteConfigStateService.AUTO_PROFILE_NAME],
      options: this.fb.group({}),
    });
  }

  private createConfigGroup(flagType: string, fields: readonly string[]): FormGroup {
    const group: Record<string, unknown> = {};
    for (const f of fields) {
      if (f in FIELD_DEFAULTS) group[f] = [FIELD_DEFAULTS[f]];
      else if (f !== 'source' && f !== 'dest') group[f] = [''];
    }
    if (fields.includes('source'))
      group['source'] =
        flagType === 'mount' ||
        flagType === 'serve' ||
        flagType === 'bisync' ||
        flagType === 'archivecreate'
          ? this.createSourcePathGroup()
          : this.fb.array([this.createSourcePathGroup()]);
    if (fields.includes('dest'))
      group['dest'] = this.fb.group({
        type: ['local'],
        path: [''],
        remote: [''],
      });
    if (fields.includes('autoStart') && !fields.includes('type')) group['cronExpression'] = [null];
    if (LINKED_PROFILE_TYPES.has(flagType)) {
      group['vfsProfile'] = [RemoteConfigStateService.AUTO_PROFILE_NAME];
      group['filterProfile'] = [RemoteConfigStateService.AUTO_PROFILE_NAME];
      group['backendProfile'] = [RemoteConfigStateService.AUTO_PROFILE_NAME];
      group['runtimeRemoteProfile'] = [RemoteConfigStateService.AUTO_PROFILE_NAME];
    }
    group['options'] = this.fb.group({});
    return this.fb.group(group as Record<string, Parameters<FormBuilder['group']>[0][string]>);
  }

  addDynamicFieldsToForm(): void {
    const fields = this.dynamicFlagFields();
    for (const type of FLAG_TYPES) {
      const optGroup = this.remoteConfigForm.get(`${type}Config.options`) as FormGroup;
      if (!optGroup || !fields[type]) continue;
      this.syncDynamicControls(optGroup, fields[type], {
        clearExisting: false,
        keyFn: (f): string => f.Name || f.FieldName,
      });
    }
  }

  replaceDynamicFormControls(): void {
    this.syncDynamicControls(this.remoteForm, this.dynamicRemoteFields(), {
      preserveKeys: new Set(['name', 'type']),
      keyFn: (f): string => f.Name,
    });
  }

  replaceRuntimeRemoteFormControls(): void {
    if (!this.runtimeRemoteConfigGroup) return;
    this.syncDynamicControls(this.runtimeRemoteConfigGroup, this.dynamicRuntimeRemoteFields(), {
      preserveKeys: new Set(['type']),
      useValidators: false,
    });
  }

  rebuildServeOptionsGroup(): void {
    const g = this.remoteConfigForm.get('serveConfig.options') as FormGroup;
    if (!g) return;
    this.syncDynamicControls(g, this.dynamicServeFields(), {
      preserveKeys: new Set(['type']),
      keyFn: (f): string => f.Name || f.FieldName,
      skipField: (f): boolean => f.FieldName === 'type' || f.Name === 'type',
      ensureControls: [{ key: 'type', control: new FormControl('http') }],
    });
  }

  private syncDynamicControls(
    group: FormGroup,
    fields: RcConfigOption[],
    opts: {
      preserveKeys?: Set<string>;
      keyFn?: (f: RcConfigOption) => string;
      useValidators?: boolean;
      skipField?: (f: RcConfigOption) => boolean;
      ensureControls?: { key: string; control: FormControl }[];
      clearExisting?: boolean;
    } = {}
  ): void {
    const {
      preserveKeys,
      keyFn = (f: RcConfigOption): string => f.Name,
      useValidators = true,
      skipField = (): boolean => false,
      ensureControls = [],
      clearExisting = false,
    } = opts;

    if (clearExisting) {
      for (const k of Object.keys(group.controls)) group.removeControl(k);
    } else if (preserveKeys) {
      for (const k of Object.keys(group.controls)) {
        if (!preserveKeys.has(k)) group.removeControl(k);
      }
    }

    for (const { key, control } of ensureControls) {
      if (!group.contains(key)) group.addControl(key, control);
    }

    for (const f of fields) {
      if (skipField(f)) continue;
      const key = keyFn(f);
      group.addControl(
        key,
        useValidators
          ? new FormControl(f.Value ?? f.Default, f.Required ? [Validators.required] : [])
          : new FormControl(f.Value ?? f.Default)
      );
    }
  }

  private cleanData(
    formData: Record<string, unknown>,
    fields: RcConfigOption[]
  ): Record<string, unknown> {
    const map = new Map(fields.map(f => [f.Name || f.FieldName, f]));
    return Object.entries(formData).reduce(
      (acc, [k, v]) => {
        const f = map.get(k);
        if (f) {
          if (!this.valueMapper.isDefaultValue(v, f)) acc[f.Name || f.FieldName] = v;
        } else if (v !== undefined && v !== null && v !== '') acc[k] = v;
        return acc;
      },
      {} as Record<string, unknown>
    );
  }

  getRuntimeRemoteOptions(
    remoteName: string,
    config: Record<string, unknown>
  ): Record<string, unknown> {
    const scoped = config[remoteName];
    return scoped && typeof scoped === 'object' && !Array.isArray(scoped)
      ? (scoped as Record<string, unknown>)
      : config;
  }

  buildProfileConfig(
    type: SharedProfileType,
    remoteName: string,
    configData: Record<string, unknown>
  ): Record<string, unknown> {
    if (type === 'runtimeRemote') {
      const opts = this.dynamicRuntimeRemoteFields().reduce<Record<string, unknown>>((acc, f) => {
        if (
          Object.prototype.hasOwnProperty.call(configData, f.Name) &&
          !this.valueMapper.isDefaultValue(configData[f.Name], f)
        )
          acc[f.Name || f.FieldName] = configData[f.Name];
        return acc;
      }, {});
      return { [remoteName]: opts };
    }
    if (type === 'vfs' || type === 'filter' || type === 'backend')
      return this.cleanData(
        (configData['options'] as Record<string, unknown>) || {},
        this.getFieldsForStep(type)
      );
    return mapFormToConfigProfile(type, configData, {
      remoteName,
      pathService: this.pathService,
      runtimeRemoteProfileNames: this.profileOptions().runtimeRemote,
      cleanData: (opts, fields) => this.cleanData(opts, fields),
      dynamicFields: this.getFieldsForStep(type),
      flatOptionNames: new Set((staticFlagDefinitions[type] || []).map(f => f.Name || f.FieldName)),
    });
  }

  cleanFormData(formData: Record<string, unknown>): PendingRemoteData {
    const map = new Map(this.dynamicRemoteFields().map(f => [f.Name, f]));
    const res: PendingRemoteData = {
      name: formData['name'] as string,
      type: formData['type'] as string,
    };
    for (const [k, v] of Object.entries(formData)) {
      if (k === 'name' || k === 'type') continue;
      const f = map.get(k);
      if (f) {
        if (!this.valueMapper.isDefaultValue(v, f) || this.changedRemoteFields.has(k))
          res[f.Name || k] = v;
      } else if (v !== null && v !== undefined && v !== '') res[k] = v;
    }
    return res;
  }

  constructor() {
    effect(() => this.setFormState(this.isAuthInProgress()));
    effect(() => {
      const rName = this.currentRemoteName();
      if (!this.isNewRemoteCreation() || !rName) return;

      for (const type of ['mount', 'bisync'] as const) {
        const group = this.remoteConfigForm.get(`${type}Config`) as FormGroup;
        if (!group) continue;
        const dstCtrl = group.get('dest') as FormGroup;
        if (!dstCtrl) continue;

        const pathCtrl = dstCtrl.get('path');
        if (pathCtrl && pathCtrl.pristine) {
          const generation = this.bumpGeneration(type);
          void this.pathService.resolveDefaultPath(rName, type).then(defaultPath => {
            if (generation !== this.getGeneration(type)) return;
            if (pathCtrl.pristine) {
              dstCtrl.patchValue({ type: 'local', path: defaultPath });
            }
          });
        }
      }
    });
  }

  async init(dialogData: DialogData | undefined): Promise<void> {
    this.dialogData = dialogData ?? ({} as DialogData);
    this.editTarget.set(dialogData?.editTarget || null);
    this.cloneTarget.set(!!dialogData?.cloneFrom);

    await Promise.all([
      this.remoteFacade.loadRemotes(),
      this.loadExistingRemotes(),
      this.loadRemoteTypes(),
      this.loadMountTypes(),
      this.loadServeTypes(),
    ]);

    await Promise.all([this.loadAllFlagFields(), this.loadServeFields()]);

    if (dialogData?.cloneFrom) {
      this.existingConfig = await this.remoteFacade.cloneRemote(dialogData.cloneFrom);
    } else if (dialogData?.name !== undefined && dialogData?.name !== null) {
      this.existingConfig = {
        config: this.remoteFacade.activeRemotes().find(r => r.name === dialogData.name)?.config,
        ...this.remoteFacade.getRemoteSettings(dialogData.name),
      };
    } else {
      this.existingConfig = null;
    }

    this.refreshRemoteNameValidator();
    this.initProfiles(this.dialogData, this.dialogData?.autoAddProfile, this.editTarget());
    this.initCurrentStep();
    await this.populateFormIfEditingOrCloning();

    for (const t of FLAG_TYPES) {
      const group = this.remoteConfigForm.get(`${t}Config`) as FormGroup;
      if (group?.contains('autoStart')) {
        this.validatorRegistry.setupOperationValidation(group, this.destroyRef);
      }
    }
  }

  private async loadExistingRemotes(): Promise<void> {
    await this.safeLoad(
      () => this.remoteManagementService.getRemotes(),
      value => {
        this.existingRemotes.set(value);
        this.refreshRemoteNameValidator();
      }
    );
  }

  private async loadRemoteTypes(): Promise<void> {
    await this.safeLoad(
      () => this.remoteManagementService.getRemoteTypes(),
      value => {
        this.remoteTypes.set(value.map(p => ({ value: p.name, label: p.description })));
      }
    );
  }

  private async loadMountTypes(): Promise<void> {
    await this.safeLoad(
      () => this.mountManagementService.getMountTypes(),
      value => this.mountTypes.set(value)
    );
  }

  private async loadServeTypes(): Promise<void> {
    await this.safeLoad(
      () => this.serveManagementService.getServeTypes(),
      value => {
        this.availableServeTypes.set(value);
        if (value.length) this.selectedServeType.set(value[0]);
      }
    );
  }

  private async safeLoad<T>(
    loader: () => Promise<T>,
    onSuccess: (value: T) => void
  ): Promise<void> {
    try {
      onSuccess(await loader());
    } catch (e) {
      console.error(e);
    }
  }

  private async loadAllFlagFields(): Promise<void> {
    const fields = await this.flagConfigService.loadAllFlagFields();
    this.dynamicFlagFields.set(fields);
    const mOpt = fields.mount?.find(f => f.Name === 'mountType');
    if (mOpt)
      mOpt.Examples = this.mountTypes().map(t => ({
        Value: t,
        Help: this.translate.instant(`mount_type_${t}.title`) || t,
      }));
    const sOpt = fields.serve?.find(f => f.Name === 'type');
    if (sOpt)
      sOpt.Examples = this.availableServeTypes().map(t => ({
        Value: t,
        Help: this.translate.instant(`serve_type_${t}.title`) || t,
      }));
    this.addDynamicFieldsToForm();
  }

  private async loadServeFields(): Promise<void> {
    const t = this.selectedServeType();
    if (!t) return;
    this.isLoadingServeFields.set(true);
    const token = ++this._serveLoadToken;
    try {
      const fields = await this.flagConfigService.loadServeFlagFields(t);
      if (token !== this._serveLoadToken) return;
      const opt = fields.find(f => f.Name === 'type');
      if (opt)
        opt.Examples = this.availableServeTypes().map(type => ({
          Value: type,
          Help: this.translate.instant(`serve_type_${type}.title`) || type,
        }));
      this.dynamicServeFields.set(fields);
      this.rebuildServeOptionsGroup();
    } catch (e) {
      console.error(e);
    } finally {
      if (token === this._serveLoadToken) this.isLoadingServeFields.set(false);
    }
  }
  private _serveLoadToken = 0;

  private async loadRuntimeRemoteFields(type: string): Promise<void> {
    if (!type) return;
    this.isLoadingRuntimeRemoteFields.set(true);
    const token = ++this._runtimeRemoteLoadToken;
    try {
      const fields = await this.remoteManagementService.getRemoteConfigFields(type);
      if (token !== this._runtimeRemoteLoadToken) return;
      this.dynamicRuntimeRemoteFields.set(fields);
      this.replaceRuntimeRemoteFormControls();
    } catch (e) {
      console.error(e);
    } finally {
      if (token === this._runtimeRemoteLoadToken) this.isLoadingRuntimeRemoteFields.set(false);
    }
  }
  private _runtimeRemoteLoadToken = 0;

  async syncRuntimeRemoteType(): Promise<void> {
    const type = String(
      this.remoteForm.get('type')?.value || this.dialogData?.remoteType || ''
    ).trim();
    this.runtimeRemoteConfigGroup.get('type')?.setValue(type, { emitEvent: false });
    if (!type) this.dynamicRuntimeRemoteFields.set([]);
    else await this.loadRuntimeRemoteFields(type);
  }

  private refreshRemoteNameValidator(): void {
    const ctrl = this.remoteForm.get('name');
    if (!ctrl) return;
    const isEdit = this.editTarget() === 'remote',
      isClone = isEdit && this.cloneTarget();
    ctrl.setValidators([
      Validators.required,
      Validators.pattern(REMOTE_NAME_REGEX),
      ...(isEdit && !isClone
        ? []
        : [this.validatorRegistry.createRemoteNameValidator(this.existingRemotes())]),
    ]);
    ctrl.updateValueAndValidity({ onlySelf: true, emitEvent: false });
  }

  private setFormState(disabled: boolean): void {
    const opts = { emitEvent: false };
    if (disabled) {
      this.remoteForm.disable(opts);
      this.remoteConfigForm.disable(opts);
    } else {
      const isRemoteEdit = this.editTarget() === 'remote';
      const isOtherEdit = this.editTarget() && !isRemoteEdit;

      if (isOtherEdit) {
        this.remoteForm.disable(opts);
      } else {
        this.remoteForm.enable(opts);
        if (isRemoteEdit) {
          this.remoteForm.get('type')?.disable(opts);
          if (!this.cloneTarget()) {
            this.remoteForm.get('name')?.disable(opts);
          }
        }
      }
      this.remoteConfigForm.enable(opts);
    }
  }

  private initCurrentStep(): void {
    const t = this.editTarget();
    if (!t) {
      this.currentStep.set(1);
      return;
    }
    const idx = this.stepConfigs().findIndex(s => s.type === t);
    this.currentStep.set(idx !== -1 ? idx + 1 : 1);
  }

  isNewRemoteCreation(): boolean {
    return (
      !this.dialogData?.name &&
      !this.dialogData?.cloneFrom &&
      !this.editTarget() &&
      !this.cloneTarget()
    );
  }

  applyPresets(remoteType: string): void {
    const vendor = this.remoteForm.get('vendor')?.value;
    const preset = this.presetsService.resolvePresets(remoteType, vendor);

    const profileRecord = (
      type: SharedProfileType,
      name: string
    ): Record<string, unknown> | null => {
      const p = this.profiles()[type]?.[name];
      return p && typeof p === 'object' ? (p as Record<string, unknown>) : null;
    };

    // 1. Patch the currently-selected VFS profile
    if (preset.vfs) {
      const selected = this.selectedProfileName()['vfs'];
      if (selected) {
        const current = profileRecord('vfs', selected) ?? {};
        this.profiles.update(p => ({
          ...p,
          vfs: {
            ...p.vfs,
            [selected]: { ...current, ...preset.vfs },
          },
        }));
      }
    }

    // 2. Patch the currently-selected mount profile's options
    if (preset.mount && Object.keys(preset.mount).length) {
      const selected = this.selectedProfileName()['mount'];
      if (selected) {
        const currentMount = profileRecord('mount', selected) ?? {};
        const rclone = (currentMount['rclone'] as Record<string, unknown> | undefined) ?? {};
        const { mountType, ...otherMountOpts } = preset.mount;
        this.profiles.update(p => ({
          ...p,
          mount: {
            ...p.mount,
            [selected]: {
              ...currentMount,
              rclone: {
                ...rclone,
                ...(mountType ? { mountType: mountType as string } : {}),
                ...otherMountOpts,
              },
            },
          },
        }));
      }
    }

    // 3. Patch the currently-selected backend profile
    if (preset.backend) {
      const selected = this.selectedProfileName()['backend'];
      if (selected) {
        const current = profileRecord('backend', selected) ?? {};
        this.profiles.update(p => ({
          ...p,
          backend: {
            ...p.backend,
            [selected]: { ...current, ...preset.backend },
          },
        }));
      }
    }

    // 4. Patch remote-specific config options
    if (preset.remote) {
      this.remoteForm.patchValue(preset.remote, { emitEvent: false });
      for (const key of Object.keys(preset.remote)) {
        this.onRemoteFieldChanged(key, true);
      }
    }

    // 5. Sync active profile forms with updated profile presets
    for (const flagType of this.PROFILE_TYPES) {
      const activeProfile = this.selectedProfileName()[flagType];
      if (!activeProfile) continue;
      const profileData = profileRecord(flagType, activeProfile);
      if (profileData) {
        void this.populateProfileForm(flagType, profileData);
      }
    }
  }

  initProfiles(dialogData: DialogData, autoAddProfile?: boolean, editTarget?: EditTarget): void {
    const newProfiles = { ...this.profiles() },
      newSelected = { ...this.selectedProfileName() };
    for (const type of this.PROFILE_TYPES) {
      const val =
        this.existingConfig?.[REMOTE_CONFIG_KEYS[type as keyof typeof REMOTE_CONFIG_KEYS]];
      const hasExisting = !!val && typeof val === 'object' && Object.keys(val).length > 0;
      newProfiles[type] = hasExisting
        ? { ...(val as ProfileConfigMap) }
        : { [RemoteConfigStateService.AUTO_PROFILE_NAME]: {} };
      newSelected[type] =
        dialogData?.targetProfile &&
        Object.keys(newProfiles[type]).includes(dialogData.targetProfile)
          ? dialogData.targetProfile
          : (Object.keys(newProfiles[type])[0] ?? null);
    }
    this.profiles.set(newProfiles);
    this.selectedProfileName.set(newSelected);

    if (this.isNewRemoteCreation() && dialogData?.remoteType) {
      this.applyPresets(dialogData.remoteType);
    }

    if (
      autoAddProfile &&
      editTarget &&
      editTarget !== 'remote' &&
      this.PROFILE_TYPES.includes(editTarget)
    )
      this.startAddProfile(editTarget);
  }

  private computeProfileActionState(
    type: string,
    profileName: string,
    action: 'rename' | 'delete'
  ): { disabled: boolean; reason: string } {
    const t = type as SharedProfileType;
    if (
      (action === 'rename' && !this.JOB_TYPES.has(t)) ||
      (action === 'delete' && !this.JOB_TYPES.has(t) && t !== 'mount' && t !== 'serve') ||
      !this.currentRemoteName()
    )
      return { disabled: false, reason: '' };
    const usage = this.getProfileUsage(t, profileName);
    return usage.inUse
      ? {
          disabled: true,
          reason: this.translate.instant('modals.remoteConfig.profile.disabledReason.inUse', {
            operation: this.JOB_TYPES.has(t) ? `${t} job` : t,
          }),
        }
      : { disabled: false, reason: '' };
  }

  getProfileActionState(
    type: string,
    name: string
  ): {
    rename: { disabled: boolean; reason: string };
    delete: { disabled: boolean; reason: string };
  } {
    return {
      rename: this.computeProfileActionState(type, name, 'rename'),
      delete: this.computeProfileActionState(type, name, 'delete'),
    };
  }

  getProfileUsage(type: SharedProfileType, name: string): ProfileUsage {
    const r = this.currentRemoteName();
    if (this.JOB_TYPES.has(type)) {
      const j = this.jobManagementService.getActiveJobsForRemote(r, name);
      return { inUse: j.length > 0, count: j.length, opType: 'job' };
    }
    if (type === 'mount') {
      const m = this.mountManagementService.getMountsForRemoteProfile(r, name);
      return { inUse: m.length > 0, count: m.length, opType: 'mount' };
    }
    if (type === 'serve') {
      const s = this.serveManagementService.getServesForRemoteProfile(r, name);
      return { inUse: s.length > 0, count: s.length, opType: 'serve' };
    }
    return { inUse: false, count: 0, opType: '' };
  }

  startAddProfile(type: string): void {
    const t = type as SharedProfileType;
    const existing = Object.keys(this.profiles()[t] || {});
    const name = findUniqueName('profile', existing);
    this.setProfileMode(t, 'add', name);
  }

  /**
   * Clones an existing profile's config under a new auto-generated name
   * (e.g. `profile`, `profile-2`, …) and immediately enters rename mode
   * so the user can name the duplicate. The new profile becomes selected.
   */
  duplicateProfile(type: string, sourceName: string): void {
    const t = type as SharedProfileType;
    const source = this.profiles()[t]?.[sourceName];
    if (!source) return;
    const existing = Object.keys(this.profiles()[t] || {});
    const newName = findUniqueName(sourceName || 'profile', existing);
    this.dirtyProfileTypes.add(t);
    this.profiles.update(p => ({
      ...p,
      [t]: { ...p[t], [newName]: structuredClone(source) },
    }));
    void this.selectProfile(t, newName).then(() => {
      // Enter rename mode so the user can name the duplicate.
      this.setProfileMode(t, 'edit', newName);
    });
  }

  startEditProfile(type: string): void {
    const t = type as SharedProfileType,
      n = this.selectedProfileName()[t];
    if (n) this.setProfileMode(t, 'edit', n);
  }

  cancelProfileEdit(type: string): void {
    this.setProfileMode(type as SharedProfileType, 'view');
  }

  saveProfile(type: string): void {
    const t = type as SharedProfileType;
    this.dirtyProfileTypes.add(t);
    const state = this.profileState()[t],
      newName = state.tempName.trim();
    if (!newName) return;

    if (state.mode === 'add') {
      this.profiles.update(p => ({ ...p, [t]: { ...p[t], [newName]: {} } }));
      void this.selectProfile(t, newName);
    } else if (state.mode === 'edit') {
      const oldName = this.selectedProfileName()[t];
      if (!oldName) {
        this.cancelProfileEdit(t);
        return;
      }
      if (oldName === newName) {
        this.cancelProfileEdit(t);
        return;
      }
      if (this.profiles()[t][newName] !== undefined) return;
      const data = this.profiles()[t][oldName];
      this.profiles.update(p => {
        const u = { ...p, [t]: { ...p[t], [newName]: data } };
        delete u[t][oldName];
        return u;
      });
      this.selectedProfileName.update(s => ({ ...s, [t]: newName }));
      void this.cascadeProfileRename(t, oldName, newName);
    }
    this.setProfileMode(t, 'view');
  }

  deleteProfile(type: string, name: string): void {
    const t = type as SharedProfileType;
    this.dirtyProfileTypes.add(t);

    if (this.currentRemoteName()) {
      const u = this.getProfileUsage(t, name);
      if (u.inUse) {
        this.notificationService.showWarning(
          this.translate.instant('modals.remoteConfig.profile.inUseWarning', {
            name,
            count: u.count,
            type: u.opType,
          })
        );
        return;
      }
    }

    this.profiles.update(p => {
      const r = { ...p[t] };
      delete r[name];
      return { ...p, [t]: r };
    });
    if (this.selectedProfileName()[t] === name) {
      const remaining = Object.keys(this.profiles()[t] || {});
      if (remaining.length) {
        void this.selectProfile(t, remaining[0]);
      } else {
        this.selectedProfileName.update(p => ({ ...p, [t]: null }));
        const group = this.remoteConfigForm.get(`${t}Config`);
        if (group) {
          group.reset({}, { emitEvent: false });
        }
      }
    }
  }

  setProfileTempName(type: string, name: string): void {
    this.profileState.update(p => ({
      ...p,
      [type]: { ...p[type as SharedProfileType], tempName: name },
    }));
  }
  setProfileMode(type: SharedProfileType, mode: 'view' | 'edit' | 'add', tempName = ''): void {
    this.profileState.update(p => ({ ...p, [type]: { mode, tempName } }));
  }

  private async cascadeProfileRename(
    type: SharedProfileType,
    oldName: string,
    newName: string
  ): Promise<void> {
    const r = this.currentRemoteName();
    if (!r) return;
    try {
      if (type === 'mount')
        await this.mountManagementService.renameProfileInMountCache(r, oldName, newName);
      else if (type === 'serve')
        await this.serveManagementService.renameProfileInServeCache(r, oldName, newName);
    } catch (e) {
      console.warn(e);
    }
  }

  highlightField(key: string, flagType: SharedProfileType, profileName: string): void {
    this.highlightedFields.update(list =>
      list.some(
        h => h.controlKey === key && h.flagType === flagType && h.profileName === profileName
      )
        ? list
        : [...list, { controlKey: key, flagType, profileName }]
    );
  }

  updateProfileConfig(
    type: SharedProfileType,
    name: string,
    config: Record<string, unknown>
  ): void {
    this.profiles.update(p => ({ ...p, [type]: { ...p[type], [name]: config } }));
  }

  async selectProfile(type: EditTarget, name: string): Promise<void> {
    if (!type) return;
    const t = type as SharedProfileType;
    const profile = this.profiles()[t]?.[name];
    if (!profile) return;
    const curr = this.selectedProfileName()[t];
    if (curr && this.profiles()[t]?.[curr]) this.saveCurrentProfile(t);
    this.selectedProfileName.update(p => ({ ...p, [t]: name }));
    await this.populateProfileForm(t, profile as Record<string, unknown>);
  }

  async selectLinkedProfile(type: SharedProfileType, name: string): Promise<void> {
    const n = this.profileNamesMap()[type]?.includes(name)
      ? name
      : (this.profileNamesMap()[type]?.[0] ?? null);
    this.selectedProfileName.update(p => ({ ...p, [type]: n }));
    if (n) {
      const c = this.profiles()[type]?.[n];
      if (c && typeof c === 'object') {
        await this.populateProfileForm(type, c as Record<string, unknown>);
      }
    }
  }

  async populateActiveProfiles(): Promise<void> {
    for (const flagType of this.PROFILE_TYPES) {
      const activeProf = this.selectedProfileName()[flagType];
      const profile = activeProf ? this.profiles()[flagType]?.[activeProf] : undefined;
      if (profile && typeof profile === 'object') {
        await this.populateProfileForm(flagType, profile as Record<string, unknown>);
      }
    }
  }

  async selectRemote(remoteName: string): Promise<void> {
    this.remoteForm.controls['name']?.setValue(remoteName, { emitEvent: false });
    await this.init({ name: remoteName, remoteType: '' });
    await this.populateActiveProfiles();
  }

  async saveRemoteProfiles(
    targetRemote?: string,
    activeType?: SharedProfileType
  ): Promise<boolean> {
    const remote = targetRemote || this.currentRemoteName();
    if (!remote) {
      this.notificationService.showWarning(
        this.translate.instant('modals.remoteConfig.warnings.selectRemoteToSave') ||
          'Please select a remote to save profiles.'
      );
      return false;
    }

    if (activeType) {
      this.saveCurrentProfile(activeType);
      this.dirtyProfileTypes.add(activeType);
    } else {
      this.PROFILE_TYPES.forEach(t => this.saveCurrentProfile(t));
    }

    const profiles = this.profiles();
    const updatedConfig: Record<string, unknown> = {};
    for (const [type, key] of Object.entries(REMOTE_CONFIG_KEYS)) {
      if (profiles[type as SharedProfileType]) {
        updatedConfig[key] = profiles[type as SharedProfileType];
      }
    }

    try {
      await this.appSettingsService.saveRemoteSettings(remote, updatedConfig);
      await this.remoteFacade.loadRemotes();
      try {
        await this.pathService.createRequiredDirectories(updatedConfig);
      } catch (err) {
        console.error('Failed to create required directories:', err);
      }
      const selName = (activeType && this.selectedProfileName()[activeType]) || 'Default';
      this.notificationService.showSuccess(
        this.translate.instant('modals.remoteConfig.profileSaved', { profile: selName, remote }) ||
          `Profile "${selName}" saved for remote "${remote}"`
      );
      return true;
    } catch (e) {
      console.error('Failed to save profile settings:', e);
      this.notificationService.showError(
        this.translate.instant('modals.remoteConfig.profileSaveFailed') ||
          'Failed to save profile settings'
      );
      return false;
    }
  }

  saveCurrentProfile(type: EditTarget): void {
    if (!type) return;
    const t = type as SharedProfileType,
      n = this.selectedProfileName()[t],
      g = this.remoteConfigForm.get(`${t}Config`);
    if (n && g)
      this.updateProfileConfig(t, n, this.buildProfileConfig(t, this.currentRemoteName(), g.value));
  }

  private saveCurrentAndMarkDirty(target: NonNullable<EditTarget>): void {
    if (target !== 'remote') {
      this.saveCurrentProfile(target);
      this.dirtyProfileTypes.add(target);
    }
  }

  navigateToShared(type: EditTarget): void {
    if (!type) return;
    const curr = this.editTarget();
    if (curr) {
      this.saveCurrentAndMarkDirty(curr);
      this.editStack.update(s => [...s, curr]);
    }
    this.editTarget.set(type);
    const idx = this.stepConfigs().findIndex(s => s.type === type);
    if (idx !== -1) this.currentStep.set(idx + 1);
  }

  returnFromShared(): void {
    const stack = this.editStack();
    if (!stack.length) return;
    const target = stack[stack.length - 1];
    if (target === undefined) return;
    const curr = this.editTarget();
    if (curr) this.saveCurrentAndMarkDirty(curr);
    this.editStack.update(s => s.slice(0, -1));
    this.editTarget.set(target);
    const idx = this.stepConfigs().findIndex(s => s.type === target);
    if (idx !== -1) this.currentStep.set(idx + 1);
  }

  async onServeTypeChange(type: string): Promise<void> {
    if (this.selectedServeType() === type && this.dynamicServeFields().length) return;
    this.selectedServeType.set(type || 'http');
    this.remoteConfigForm.get('serveConfig.options.type')?.setValue(type, { emitEvent: false });
    await this.loadServeFields();
  }

  async onRemoteTypeChange(): Promise<void> {
    const t = this.remoteForm.get('type')?.value as string;
    await Promise.all([this.loadRemoteFields(t), this.syncRuntimeRemoteType()]);

    if (this.isNewRemoteCreation() && t) {
      this.applyPresets(t);
      for (const flagType of this.PROFILE_TYPES) {
        const activeProfile = this.selectedProfileName()[flagType];
        if (!activeProfile) continue;
        const profileData = this.profiles()[flagType]?.[activeProfile];
        if (profileData && typeof profileData === 'object') {
          await this.populateProfileForm(flagType, profileData as Record<string, unknown>);
        }
      }
    }
  }

  private async loadRemoteFields(type: string): Promise<void> {
    this.isRemoteConfigLoading.set(true);
    this.dynamicRemoteFields.set([]);
    const token = ++this._remoteFieldsLoadToken;
    try {
      const fields = await this.remoteManagementService.getRemoteConfigFields(type);
      if (token !== this._remoteFieldsLoadToken) return;
      this.dynamicRemoteFields.set(fields);
      this.replaceDynamicFormControls();
    } catch (e) {
      console.error(e);
    } finally {
      if (token === this._remoteFieldsLoadToken) this.isRemoteConfigLoading.set(false);
    }
  }
  private _remoteFieldsLoadToken = 0;

  onRemoteFieldChanged(name: string, changed: boolean): void {
    if (!this.isPopulatingForm()) {
      if (changed || this.editTarget() === 'remote') this.changedRemoteFields.add(name);
      else this.changedRemoteFields.delete(name);

      if (
        name === 'vendor' &&
        this.isNewRemoteCreation() &&
        this.remoteForm.get('type')?.value === 'webdav'
      ) {
        const t = this.remoteForm.get('type')?.value;
        this.applyPresets(t);
        for (const flagType of this.PROFILE_TYPES) {
          const activeProfile = this.selectedProfileName()[flagType];
          if (!activeProfile) continue;
          const profileData = this.profiles()[flagType]?.[activeProfile];
          if (profileData && typeof profileData === 'object') {
            void this.populateProfileForm(flagType, profileData as Record<string, unknown>);
          }
        }
      }
    }
  }
  toggleObscureToolVisibility(): void {
    this.showObscureTool.update(v => !v);
    if (this.showObscureTool()) this.showCliImport.set(false);
  }

  toggleCliImportVisibility(): void {
    this.showCliImport.update(v => !v);
    if (this.showCliImport()) this.showObscureTool.set(false);
  }

  applyObscuredValue(controlKey: string, value: string): void {
    const stepType = this.activeStepType();
    if (!stepType) return;

    const group = this.getGroupForStep(stepType);
    const control = group?.get(controlKey);
    if (!control) return;

    control.setValue(value);
    control.markAsDirty();
    control.markAsTouched();
  }

  /**
   * Applies a parsed CLI import to a profile. Merges paths and selected flags
   * into the profile config data BEFORE re-populating the form, so form
   * controls are created with the correct values from the start (avoids the
   * zoneless issue where patching form controls after creation doesn't reach
   * the template).
   *
   * Handles three modes:
   *  - 'new': creates a new profile entry with the merged config
   *  - 'override': replaces an existing profile's config with the merged values
   *  - 'patch': merges into the currently selected profile
   */
  async applyImportResult(event: {
    result: ImportResult;
    profileName: string;
    mode: 'new' | 'override' | 'patch';
    importSourcePath: boolean;
    importDestPath: boolean;
  }): Promise<void> {
    const { result, profileName, mode, importSourcePath, importDestPath } = event;
    const targetType = (result.verb || this.editTarget() || 'sync') as SharedProfileType;

    // Determine the active profile name based on mode
    const activeProfileName =
      mode === 'patch' ? (this.selectedProfileName()[targetType] ?? profileName) : profileName;

    // For 'new' mode: ensure the profile entry exists
    if (mode === 'new') {
      this.setProfileMode(targetType, 'view');
      if (!this.profiles()[targetType]?.[activeProfileName]) {
        this.profiles.update(p => ({
          ...p,
          [targetType]: { ...p[targetType], [activeProfileName]: {} },
        }));
      }
    }

    // For 'new' mode with linked types: seed linked profile entries
    if (mode === 'new' && LINKED_PROFILE_TYPES.has(targetType)) {
      for (const linkedType of RemoteConfigStateService.LINKED_TYPES) {
        const lt = linkedType as SharedProfileType;
        if (!this.profiles()[lt]?.[activeProfileName]) {
          const existingEntries = Object.values(this.profiles()[lt] ?? {});
          const seedEntry = existingEntries[0] ?? {};
          this.profiles.update(p => ({
            ...p,
            [lt]: { ...p[lt], [activeProfileName]: structuredClone(seedEntry) },
          }));
        }
      }
    }

    // Get existing config (empty for new, existing for override/patch)
    const existing =
      mode === 'new'
        ? {}
        : ((this.profiles()[targetType]?.[activeProfileName] as Record<string, unknown>) ?? {});

    // Merge the import into the config
    const merged = this.mergeImportIntoConfig(
      targetType,
      existing,
      result,
      importSourcePath,
      importDestPath
    );

    // Write merged config back to profiles
    this.profiles.update(p => ({
      ...p,
      [targetType]: { ...p[targetType], [activeProfileName]: merged },
    }));

    // Merge linked flags into their respective profile entries
    this.mergeLinkedImportFlags(result, targetType, activeProfileName, mode);

    // Navigate to the target step
    if (this.editTarget() && this.editTarget() !== targetType) this.editTarget.set(targetType);
    const idx = this.stepConfigs().findIndex(s => s.type === targetType);
    if (idx !== -1) this.currentStep.set(idx + 1);

    // For serve, set the subtype before populate so right fields load
    if (targetType === 'serve' && result.serveSubtype) {
      this.selectedServeType.set(result.serveSubtype);
    }

    // Re-select the profile so populateProfileForm creates controls with
    // the merged values from the start.
    await this.selectProfile(targetType, activeProfileName);

    // Reload serve fields if subtype changed
    if (targetType === 'serve' && result.serveSubtype) {
      await this.onServeTypeChange(result.serveSubtype);
    }

    // Set mount subtype on the form
    if (targetType === 'mount' && result.mountSubtype) {
      const group = this.remoteConfigForm.get(`${targetType}Config`) as FormGroup;
      group?.get('options.mountType')?.setValue(result.mountSubtype);
    }

    // Highlight all imported fields
    for (const cls of result.classified) {
      if (cls.status !== 'mapped' || !cls.fieldName) continue;
      const flagType = (cls.flagType || targetType) as SharedProfileType;
      this.highlightField(cls.fieldName, flagType, activeProfileName);
    }

    // Mark dirty
    if (mode === 'new' && LINKED_PROFILE_TYPES.has(targetType)) {
      for (const linkedType of RemoteConfigStateService.LINKED_TYPES) {
        this.dirtyProfileTypes.add(linkedType as SharedProfileType);
      }
    }
    this.dirtyProfileTypes.add(targetType);

    this.showCliImport.set(false);
    this.showObscureTool.set(false);
  }

  private mergeImportIntoConfig(
    type: SharedProfileType,
    existing: Record<string, unknown>,
    result: ImportResult,
    importSourcePath: boolean,
    importDestPath: boolean
  ): Record<string, unknown> {
    // Linked types: flat options
    if (type === 'vfs' || type === 'filter' || type === 'backend') {
      return this.mergeFlagsFlat(existing, result, type);
    }

    // runtimeRemote: { [remoteName]: opts }
    if (type === 'runtimeRemote') {
      const rName = this.currentRemoteName();
      const opts =
        (existing[rName] as Record<string, unknown>) ?? (existing as Record<string, unknown>);
      const merged = this.mergeFlagsFlat(opts, result, type);
      return { ...existing, [rName]: merged };
    }

    // Operation types: { app, rclone }
    const existingApp = (existing['app'] as Record<string, unknown>) ?? {};
    const existingRclone = (existing['rclone'] as Record<string, unknown>) ?? {};
    const rclone: Record<string, unknown> = { ...existingRclone };

    // Merge paths
    const mapping = OPERATION_PATH_MAPPINGS[type];
    if (mapping) {
      if (result.sourcePath && importSourcePath) {
        rclone[mapping.sourceKey] = mapping.isSourceArray ? [result.sourcePath] : result.sourcePath;
      }
      if (mapping.destKey && result.destPath && importDestPath) {
        rclone[mapping.destKey] = result.destPath;
      }
      if (type === 'mount' && result.mountSubtype) {
        rclone['mountType'] = result.mountSubtype;
      }
      if (type === 'serve' && result.serveSubtype) {
        rclone['type'] = result.serveSubtype;
      }
    }

    // Merge mapped flags that belong to THIS target type
    for (const cls of result.classified) {
      if (cls.status !== 'mapped' || !cls.fieldName) continue;
      const flagType = (cls.flagType || type) as SharedProfileType;
      if (flagType !== type) continue; // linked flags handled separately
      rclone[cls.fieldName] = cls.coercedValue;
    }

    return { ...existing, app: { ...existingApp }, rclone };
  }

  private mergeFlagsFlat(
    existing: Record<string, unknown>,
    result: ImportResult,
    type: SharedProfileType
  ): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...existing };

    for (const cls of result.classified) {
      if (cls.status !== 'mapped' || !cls.fieldName) continue;
      const flagType = (cls.flagType || type) as SharedProfileType;
      if (flagType !== type) continue;
      merged[cls.fieldName] = cls.coercedValue;
    }

    return merged;
  }

  private mergeLinkedImportFlags(
    result: ImportResult,
    targetType: SharedProfileType,
    profileName: string,
    mode: 'new' | 'override' | 'patch'
  ): void {
    const processed = new Set<SharedProfileType>();

    for (const cls of result.classified) {
      if (cls.status !== 'mapped' || !cls.fieldName) continue;
      const flagType = (cls.flagType || targetType) as SharedProfileType;
      if (flagType === targetType) continue;
      if (processed.has(flagType)) continue;
      if (!RemoteConfigStateService.LINKED_TYPES.has(flagType)) continue;

      processed.add(flagType);

      const existing = (this.profiles()[flagType]?.[profileName] as Record<string, unknown>) ?? {};
      const merged = this.mergeFlagsFlat(existing, result, flagType);

      this.profiles.update(p => ({
        ...p,
        [flagType]: { ...p[flagType], [profileName]: merged },
      }));

      // Select the linked profile so it gets populated
      if (mode === 'new' || mode === 'patch') {
        const group = this.remoteConfigForm.get(`${targetType}Config`) as FormGroup;
        const pCtrl = group?.get(`${flagType}Profile`);
        if (pCtrl) pCtrl.setValue(profileName);
      }
    }
  }

  private async populateFormIfEditingOrCloning(): Promise<void> {
    if (!this.existingConfig) return;
    if (this.editTarget() === 'remote' || this.cloneTarget()) {
      const remoteSpecs = (this.existingConfig['config'] || this.existingConfig) as Record<
        string,
        unknown
      >;
      await this.populateRemoteForm(remoteSpecs);

      if (this.cloneTarget()) {
        const promises: Promise<void>[] = [];
        for (const t of FLAG_TYPES) {
          const configs = this.existingConfig?.[
            REMOTE_CONFIG_KEYS[t as keyof typeof REMOTE_CONFIG_KEYS]
          ] as Record<string, unknown> | undefined;
          if (configs && typeof configs === 'object' && Object.keys(configs).length) {
            const firstProfile = Object.values(configs)[0];
            if (firstProfile && typeof firstProfile === 'object') {
              promises.push(this.populateProfileForm(t, firstProfile as Record<string, unknown>));
            }
          }
        }
        const rConfigs = this.existingConfig?.[REMOTE_CONFIG_KEYS.runtimeRemote] as
          Record<string, unknown> | undefined;
        if (rConfigs && typeof rConfigs === 'object' && Object.keys(rConfigs).length) {
          const firstRuntimeProfile = Object.values(rConfigs)[0];
          if (firstRuntimeProfile && typeof firstRuntimeProfile === 'object') {
            promises.push(
              this.populateProfileForm(
                'runtimeRemote',
                firstRuntimeProfile as Record<string, unknown>
              )
            );
          }
        }
        await Promise.all(promises);
      }
    } else if (this.editTarget()) {
      if (this.dialogData?.remoteType)
        this.remoteForm.get('type')?.setValue(this.dialogData.remoteType);
      await this.syncRuntimeRemoteType();
      const type = this.editTarget() as SharedProfileType,
        selectedName = this.selectedProfileName()[type],
        profile = selectedName
          ? (this.profiles()[type]?.[selectedName] as Record<string, unknown> | undefined)
          : undefined;
      if (type === 'runtimeRemote') {
        const runtimeProfiles = this.profiles()['runtimeRemote'] as Record<
          string,
          Record<string, unknown>
        >;
        const runtimeType = Object.values(runtimeProfiles).find(
          p => p && typeof p['type'] === 'string'
        )?.['type'];
        this.remoteForm.get('type')?.setValue(this.dialogData?.remoteType || runtimeType || '');
      }
      if (profile) await this.populateProfileForm(type, profile);
    }
    if (this.cloneTarget()) this.generateNewCloneName();
  }

  async populateRemoteForm(config: Record<string, unknown>): Promise<void> {
    this.isPopulatingForm.set(true);
    this.remoteForm.patchValue({ name: config['name'], type: config['type'] });
    await this.onRemoteTypeChange();
    for (const [k, v] of Object.entries(config)) {
      if (k !== 'name' && k !== 'type' && !this.remoteForm.contains(k))
        this.remoteForm.addControl(k, new FormControl(v));
    }
    this.remoteForm.patchValue(config);
    this.isPopulatingForm.set(false);
  }

  async populateProfileForm(
    type: SharedProfileType,
    config: Record<string, unknown>
  ): Promise<void> {
    this.isPopulatingForm.set(true);
    const group = this.remoteConfigForm.get(`${type}Config`) as FormGroup;
    if (!group) {
      this.isPopulatingForm.set(false);
      return;
    }

    if (type === 'runtimeRemote') {
      await this.populateRuntimeRemoteProfile(group, config);
      this.isPopulatingForm.set(false);
      return;
    }

    if (type === 'serve') {
      this.selectedServeType.set(
        String(getRcloneCfg(config)?.['type'] || config['type'] || 'http')
      );
      await this.loadServeFields();
    }

    const generation = this.bumpGeneration(type);
    const rName = this.currentRemoteName();
    const vals = mapConfigToFormProfile(type, config, {
      remoteName: rName,
      existingRemotes: this.existingRemotes(),
      pathService: this.pathService,
    });

    this.patchProfileFields(group, vals);
    this.populateProfilePaths(group, type, vals, rName, generation);
    this.populateProfileOptions(group, type, vals);

    if (LINKED_PROFILE_TYPES.has(type)) {
      await Promise.all([
        this.selectLinkedProfile('vfs', String(vals['vfsProfile'] ?? '')),
        this.selectLinkedProfile('filter', String(vals['filterProfile'] ?? '')),
        this.selectLinkedProfile('backend', String(vals['backendProfile'] ?? '')),
        this.selectLinkedProfile('runtimeRemote', String(vals['runtimeRemoteProfile'] ?? '')),
      ]);
    }
    this.isPopulatingForm.set(false);
  }

  private async populateRuntimeRemoteProfile(
    group: FormGroup,
    config: Record<string, unknown>
  ): Promise<void> {
    const rName = this.currentRemoteName();
    const opts = this.getRuntimeRemoteOptions(rName, config);
    const rType = String(
      this.remoteForm.get('type')?.value || opts['type'] || config['type'] || ''
    ).trim();
    group.get('type')?.setValue(rType, { emitEvent: false });
    await this.loadRuntimeRemoteFields(rType);
    for (const f of this.dynamicRuntimeRemoteFields()) {
      group.get(f.Name)?.setValue(opts[f.FieldName] ?? opts[f.Name] ?? f.Value ?? f.Default, {
        emitEvent: false,
      });
    }
  }

  private patchProfileFields(group: FormGroup, vals: Record<string, unknown>): void {
    group.patchValue({
      autoStart: vals['autoStart'],
      cronEnabled: vals['cronEnabled'],
      cronExpression: vals['cronExpression'],
      watchEnabled: vals['watchEnabled'],
      watchDelay: vals['watchDelay'],
      vfsProfile: vals['vfsProfile'],
      filterProfile: vals['filterProfile'],
      backendProfile: vals['backendProfile'],
      runtimeRemoteProfile: vals['runtimeRemoteProfile'],
    });
  }

  private populateProfilePaths(
    group: FormGroup,
    type: SharedProfileType,
    vals: Record<string, unknown>,
    rName: string,
    generation: number
  ): void {
    const srcCtrl = group.get('source');
    if (srcCtrl instanceof FormArray) {
      srcCtrl.clear();
      const rawSource = vals['source'] as unknown;
      const arr = Array.isArray(rawSource) ? rawSource : [];
      if (!arr.length) {
        srcCtrl.push(this.createSourcePathGroup());
      } else {
        arr.forEach(s =>
          srcCtrl.push(
            this.createSourcePathGroup(
              s as {
                type?: string;
                path?: string;
                remote?: string;
                filename?: string;
              }
            )
          )
        );
      }
    } else if (srcCtrl instanceof FormGroup) {
      srcCtrl.patchValue(vals['source'] as Record<string, unknown>);
    }

    const dstCtrl = group.get('dest');
    if (!(dstCtrl instanceof FormGroup)) return;

    dstCtrl.patchValue(vals['dest'] as Record<string, unknown>);
    const destVal = vals['dest'] as { path?: string } | undefined;
    if ((type === 'mount' || type === 'bisync') && !destVal?.path) {
      const opType = type as 'mount' | 'bisync';
      void this.pathService.resolveDefaultPath(rName, opType).then(defaultPath => {
        if (generation !== this.getGeneration(type)) return;
        if (!dstCtrl.get('path')?.value) {
          dstCtrl.patchValue({ type: 'local', path: defaultPath });
        }
      });
    }
  }

  private populateProfileOptions(
    group: FormGroup,
    type: SharedProfileType,
    vals: Record<string, unknown>
  ): void {
    const optsGroup = group.get('options') as FormGroup;
    if (!optsGroup) return;

    const subtypeCtrl = optsGroup.get(type === 'serve' ? 'type' : 'mountType');
    for (const k of Object.keys(optsGroup.controls)) {
      if (k !== 'type' && k !== 'mountType') optsGroup.removeControl(k);
    }
    if (!subtypeCtrl && (type === 'serve' || type === 'mount')) {
      optsGroup.addControl(
        type === 'serve' ? 'type' : 'mountType',
        new FormControl(type === 'serve' ? 'http' : 'mount')
      );
    }

    const fields = this.getFieldsForStep(type);
    for (const f of fields) {
      if (['type', 'mountType'].includes(f.FieldName || f.Name)) continue;
      optsGroup.addControl(f.Name || f.FieldName, new FormControl(f.Value ?? f.Default));
    }

    const incomingOptions = (vals['options'] as Record<string, unknown>) || {};
    for (const [k, v] of Object.entries(incomingOptions)) {
      if (k === 'fs') continue;
      const matchedField = fields.find(f => f.FieldName === k || f.Name === k);
      const cKey = matchedField ? matchedField.Name || matchedField.FieldName : k;
      const control = optsGroup.get(cKey);
      if (control) {
        control.setValue(v, { emitEvent: false });
      } else {
        optsGroup.addControl(cKey, new FormControl(v), { emitEvent: false });
      }
    }
  }

  generateNewCloneName(): void {
    const base = `${this.remoteForm.get('name')?.value || 'remote'}-clone`;
    const name = findUniqueName(base, this.existingRemotes());
    this.remoteForm.get('name')?.setValue(name);
  }
}
