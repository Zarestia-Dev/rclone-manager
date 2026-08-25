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
  PROFILE_ICONS,
  PendingRemoteData,
  TemplateCategory,
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
import { PathInspectionService } from '../infrastructure/platform/path-inspection.service';
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

// ── Module-level constants (previously instance/static fields, recreated per dialog open) ───

const PROFILE_TYPES: readonly SharedProfileType[] = [...FLAG_TYPES, 'runtimeRemote'];
const JOB_TYPES: ReadonlySet<SharedProfileType> = new Set(SYNC_TYPES);
const LINKED_TYPES: ReadonlySet<string> = new Set(['vfs', 'filter', 'backend', 'runtimeRemote']);
const AUTO_PROFILE_NAME = 'Default';

const OPERATION_FIELDS = [
  'autoStart',
  'cronEnabled',
  'cronExpression',
  'watchEnabled',
  'watchDelay',
  'watchChangedOnly',
  'source',
  'dest',
] as const;
const FIELD_DEFAULTS: Record<string, unknown> = {
  autoStart: false,
  cronEnabled: false,
  watchEnabled: false,
  watchDelay: 5,
  watchChangedOnly: false,
};
// Form fields each operation type uses (besides the dynamic `options` group).
const FLAG_TYPE_FIELDS: Partial<Record<string, readonly string[]>> = {
  mount: ['autoStart', 'dest', 'source'],
  sync: OPERATION_FIELDS,
  copy: OPERATION_FIELDS,
  move: OPERATION_FIELDS,
  bisync: OPERATION_FIELDS,
  check: OPERATION_FIELDS,
  archivecreate: OPERATION_FIELDS,
  cryptcheck: OPERATION_FIELDS,
  delete: [
    'autoStart',
    'cronEnabled',
    'cronExpression',
    'watchEnabled',
    'watchDelay',
    'watchChangedOnly',
    'source',
  ],
  copyurl: OPERATION_FIELDS,
};

// Fields patched when populating a profile form (excluding `source`/`dest` which are
// handled separately because their shape varies per operation).
const PROFILE_FORM_FIELDS = [
  'autoStart',
  'cronEnabled',
  'cronExpression',
  'watchEnabled',
  'watchDelay',
  'watchChangedOnly',
  'vfsProfile',
  'filterProfile',
  'backendProfile',
  'runtimeRemoteProfile',
] as const;

@Injectable()
export class RemoteConfigStateService {
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
  private readonly pathService = inject(PathService);
  private readonly pathInspectionService = inject(PathInspectionService);
  private readonly translate = inject(TranslateService);
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
      return [type, toSignal(fg.statusChanges.pipe(startWith(fg.status)))];
    })
  ) as Record<string, Signal<string>>;

  get runtimeRemoteConfigGroup(): FormGroup {
    return this.remoteConfigForm.get('runtimeRemoteConfig') as FormGroup;
  }

  readonly remoteFormStatus = toSignal(
    this.remoteForm.statusChanges.pipe(startWith(this.remoteForm.status))
  );
  readonly remoteConfigFormStatus = toSignal(
    this.remoteConfigForm.statusChanges.pipe(startWith(this.remoteConfigForm.status))
  );
  readonly remoteTypeSignal = toSignal(
    this.remoteForm.controls['type'].valueChanges.pipe(
      startWith(this.remoteForm.controls['type'].value as string)
    )
  );
  readonly remoteNameSignal = toSignal(
    this.remoteForm.controls['name'].valueChanges.pipe(
      startWith(this.remoteForm.controls['name'].value as string)
    )
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

  readonly PROFILE_TYPES: readonly SharedProfileType[] = PROFILE_TYPES;
  readonly JOB_TYPES: ReadonlySet<SharedProfileType> = JOB_TYPES;

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
  private readonly dialogData = signal<DialogData>({ remoteType: '' });

  private readonly profilePopulateGenerations = new Map<string, number>();

  private getGeneration(type: string): number {
    return this.profilePopulateGenerations.get(type) || 0;
  }

  private bumpGeneration(type: string): number {
    const next = (this.profilePopulateGenerations.get(type) || 0) + 1;
    this.profilePopulateGenerations.set(type, next);
    return next;
  }

  readonly currentRemoteName = computed(
    () => this.dialogData().name || this.remoteNameSignal() || ''
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

  readonly isEditingExisting = computed(() => {
    const data = this.dialogData();
    return !!(data.name || data.cloneFrom);
  });

  readonly editTargetStepKey = computed(() =>
    this.editTarget() && (this.isEditingExisting() || this.editTarget() !== 'remote')
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
    return this.valueMapper.extractSensitiveFields(fields);
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
    if (!t) return this.stepConfigs().map((_, i) => i + 1);
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
    this.isEditingExisting() ? 'common.save' : 'common.create'
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
      vfsProfile: [AUTO_PROFILE_NAME],
      filterProfile: [AUTO_PROFILE_NAME],
      backendProfile: [AUTO_PROFILE_NAME],
      runtimeRemoteProfile: [AUTO_PROFILE_NAME],
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
      group['vfsProfile'] = [AUTO_PROFILE_NAME];
      group['filterProfile'] = [AUTO_PROFILE_NAME];
      group['backendProfile'] = [AUTO_PROFILE_NAME];
      group['runtimeRemoteProfile'] = [AUTO_PROFILE_NAME];
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
      if (group.contains(key)) continue;
      group.addControl(
        key,
        useValidators
          ? new FormControl(f.Value ?? f.Default, f.Required ? [Validators.required] : [])
          : new FormControl(f.Value ?? f.Default)
      );
    }
  }

  private getRuntimeRemoteOptions(
    remoteName: string,
    config: Record<string, unknown>
  ): Record<string, unknown> {
    const scoped = config[remoteName];
    return scoped && typeof scoped === 'object' && !Array.isArray(scoped)
      ? (scoped as Record<string, unknown>)
      : config;
  }

  private buildProfileConfig(
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
      return this.valueMapper.cleanData(
        (configData['options'] as Record<string, unknown>) || {},
        this.getFieldsForStep(type)
      );
    return mapFormToConfigProfile(type, configData, {
      remoteName,
      pathService: this.pathService,
      runtimeRemoteProfileNames: this.profileOptions().runtimeRemote,
      cleanData: (opts, fields) => this.valueMapper.cleanData(opts, fields),
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
          this.runPathResolve(type, rName, dstCtrl, pathCtrl);
        }
      }
    });
  }

  private runPathResolve(
    type: 'mount' | 'bisync',
    remoteName: string,
    dstCtrl: FormGroup,
    pathCtrl: unknown
  ): void {
    const token = ++this.pathResolveTokens[type];
    this.pathInspectionService
      .resolveDefaultPath(remoteName, type)
      .then(defaultPath => {
        if (token !== this.pathResolveTokens[type]) return;
        if ((pathCtrl as { pristine: boolean }).pristine) {
          dstCtrl.patchValue({ type: 'local', path: defaultPath });
        }
      })
      .catch(err => console.warn(`[RemoteConfigState] resolveDefaultPath(${type}) failed:`, err));
  }
  private readonly pathResolveTokens: Record<'mount' | 'bisync', number> = { mount: 0, bisync: 0 };

  async init(dialogData: DialogData | undefined): Promise<void> {
    this.dialogData.set(dialogData ?? { remoteType: '' });
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
    this.initProfiles(this.dialogData(), this.dialogData()?.autoAddProfile, this.editTarget());
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

  private async cancellableLoad<T>(
    tokenSlot: { token: number },
    loader: () => Promise<T>,
    onSuccess: (value: T) => void,
    loadingSignal: { set(v: boolean): void }
  ): Promise<void> {
    const token = ++tokenSlot.token;
    loadingSignal.set(true);
    try {
      const value = await loader();
      if (token !== tokenSlot.token) return;
      onSuccess(value);
    } catch (e) {
      console.error(e);
    } finally {
      if (token === tokenSlot.token) loadingSignal.set(false);
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
    await this.cancellableLoad(
      this._serveLoadToken,
      () => this.flagConfigService.loadServeFlagFields(t),
      fields => {
        const opt = fields.find(f => f.Name === 'type');
        if (opt)
          opt.Examples = this.availableServeTypes().map(type => ({
            Value: type,
            Help: this.translate.instant(`serve_type_${type}.title`) || type,
          }));
        this.dynamicServeFields.set(fields);
        this.rebuildServeOptionsGroup();
      },
      this.isLoadingServeFields
    );
  }
  private readonly _serveLoadToken = { token: 0 };

  private async loadRuntimeRemoteFields(type: string): Promise<void> {
    if (!type) return;
    await this.cancellableLoad(
      this._runtimeRemoteLoadToken,
      () => this.remoteManagementService.getRemoteConfigFields(type),
      fields => {
        this.dynamicRuntimeRemoteFields.set(fields);
        this.replaceRuntimeRemoteFormControls();
      },
      this.isLoadingRuntimeRemoteFields
    );
  }
  private readonly _runtimeRemoteLoadToken = { token: 0 };

  async syncRuntimeRemoteType(): Promise<void> {
    const type = String(
      this.remoteForm.get('type')?.value || this.dialogData().remoteType || ''
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
      !this.dialogData().name &&
      !this.dialogData().cloneFrom &&
      !this.editTarget() &&
      !this.cloneTarget()
    );
  }

  applyPresets(remoteType: string): void {
    const vendor = this.remoteForm.get('vendor')?.value;
    const preset = this.presetsService.resolvePresets(remoteType, vendor);
    this.applyTemplate(preset);
  }

  applyTemplate(values: Partial<Record<TemplateCategory, Record<string, unknown>>>): void {
    const patchProfile = (
      type: SharedProfileType,
      overrides: Record<string, unknown> | undefined
    ): void => {
      if (!overrides || !Object.keys(overrides).length) return;
      const selected = this.selectedProfileName()[type];
      if (!selected) return;
      const current = this.readProfileRecord(type, selected);
      this.profiles.update(p => ({
        ...p,
        [type]: { ...p[type], [selected]: { ...current, ...overrides } },
      }));
    };

    if (values.vfs) patchProfile('vfs', values.vfs);
    if (values.backend) patchProfile('backend', values.backend);
    if (values.filter) patchProfile('filter', values.filter);
    if (values.sync) patchProfile('sync', values.sync);
    if (values.copy) patchProfile('copy', values.copy);
    if (values.bisync) patchProfile('bisync', values.bisync);
    if (values.move) patchProfile('move', values.move);
    if (values.serve) patchProfile('serve', values.serve);

    if (values.mount) {
      const { mountType, ...otherMountOpts } = values.mount;
      const selected = this.selectedProfileName()['mount'];
      if (selected) {
        const current = this.readProfileRecord('mount', selected);
        const rclone = (current['rclone'] as Record<string, unknown> | undefined) ?? {};
        this.profiles.update(p => ({
          ...p,
          mount: {
            ...p.mount,
            [selected]: {
              ...current,
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

    if (values.remote) {
      this.remoteForm.patchValue(values.remote, { emitEvent: false });
      for (const key of Object.keys(values.remote)) this.onRemoteFieldChanged(key, true);
    }

    // Re-sync active profile forms so they reflect the patched template values.
    for (const flagType of this.PROFILE_TYPES) {
      const activeProfile = this.selectedProfileName()[flagType];
      if (!activeProfile) continue;
      const profileData = this.readProfileRecord(flagType, activeProfile);
      if (profileData) void this.populateProfileForm(flagType, profileData);
    }
  }

  private readProfileRecord(type: SharedProfileType, name: string): Record<string, unknown> {
    const p = this.profiles()[type]?.[name];
    return p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
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
        : { [AUTO_PROFILE_NAME]: {} };
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
    const isJob = this.JOB_TYPES.has(t);
    const isInUseCheckable =
      (action === 'rename' && isJob) ||
      (action === 'delete' && (isJob || t === 'mount' || t === 'serve'));

    if (!isInUseCheckable || !this.currentRemoteName()) return { disabled: false, reason: '' };

    const usage = this.getProfileUsage(t, profileName);
    if (!usage.inUse) return { disabled: false, reason: '' };
    return {
      disabled: true,
      reason: this.translate.instant('modals.remoteConfig.profile.disabledReason.inUse', {
        operation: isJob ? `${t} job` : t,
      }),
    };
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

  private getProfileUsage(type: SharedProfileType, name: string): ProfileUsage {
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
    if (curr && curr !== name && this.profiles()[t]?.[curr]) this.saveCurrentProfile(t);
    this.selectedProfileName.update(p => ({ ...p, [t]: name }));
    await this.populateProfileForm(t, profile as Record<string, unknown>);
  }

  private async selectLinkedProfile(type: SharedProfileType, name: string): Promise<void> {
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
        await this.pathInspectionService.createRequiredDirectories(updatedConfig);
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
    if (this.selectedServeType() === type) return;
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
    this.dynamicRemoteFields.set([]);
    await this.cancellableLoad(
      this._remoteFieldsLoadToken,
      () => this.remoteManagementService.getRemoteConfigFields(type),
      fields => {
        this.dynamicRemoteFields.set(fields);
        this.replaceDynamicFormControls();
      },
      this.isRemoteConfigLoading
    );
  }
  private readonly _remoteFieldsLoadToken = { token: 0 };

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
    const activeProfileName =
      mode === 'patch' ? (this.selectedProfileName()[targetType] ?? profileName) : profileName;

    if (mode === 'new') {
      this.setProfileMode(targetType, 'view');
      this.ensureProfileEntry(targetType, activeProfileName);
      // Seed linked profile entries so import flags targeting vfs/filter/backend/runtimeRemote
      // have somewhere to land.
      if (LINKED_PROFILE_TYPES.has(targetType)) {
        for (const linkedType of LINKED_TYPES) {
          this.ensureProfileEntry(linkedType as SharedProfileType, activeProfileName, true);
        }
      }
    }

    const existing =
      mode === 'new'
        ? {}
        : ((this.profiles()[targetType]?.[activeProfileName] as Record<string, unknown>) ?? {});

    const merged = this.mergeImportIntoConfig(
      targetType,
      existing,
      result,
      importSourcePath,
      importDestPath
    );
    this.profiles.update(p => ({
      ...p,
      [targetType]: { ...p[targetType], [activeProfileName]: merged },
    }));
    this.mergeLinkedImportFlags(result, targetType, activeProfileName, mode);

    if (this.editTarget() && this.editTarget() !== targetType) this.editTarget.set(targetType);
    const idx = this.stepConfigs().findIndex(s => s.type === targetType);
    if (idx !== -1) this.currentStep.set(idx + 1);

    // Set serve subtype before populate so the right fields load.
    if (targetType === 'serve' && result.serveSubtype) {
      this.selectedServeType.set(result.serveSubtype);
    }

    // Re-select so populateProfileForm creates controls with the merged values from the start.
    await this.selectProfile(targetType, activeProfileName);

    if (targetType === 'serve' && result.serveSubtype) {
      await this.onServeTypeChange(result.serveSubtype);
    }
    if (targetType === 'mount' && result.mountSubtype) {
      const group = this.remoteConfigForm.get(`${targetType}Config`) as FormGroup;
      group?.get('options.mountType')?.setValue(result.mountSubtype);
    }

    for (const cls of result.classified) {
      if (cls.status !== 'mapped' || !cls.fieldName) continue;
      const flagType = (cls.flagType || targetType) as SharedProfileType;
      this.highlightField(cls.fieldName, flagType, activeProfileName);
    }

    if (mode === 'new' && LINKED_PROFILE_TYPES.has(targetType)) {
      for (const linkedType of LINKED_TYPES) {
        this.dirtyProfileTypes.add(linkedType as SharedProfileType);
      }
    }
    this.dirtyProfileTypes.add(targetType);

    this.showCliImport.set(false);
    this.showObscureTool.set(false);
  }

  private ensureProfileEntry(type: SharedProfileType, name: string, seedFromFirst = false): void {
    if (this.profiles()[type]?.[name]) return;
    const seedEntry =
      seedFromFirst && Object.values(this.profiles()[type] ?? {})[0]
        ? structuredClone(Object.values(this.profiles()[type] ?? {})[0])
        : {};
    this.profiles.update(p => ({
      ...p,
      [type]: { ...p[type], [name]: seedEntry as Record<string, unknown> },
    }));
  }

  private mergeImportIntoConfig(
    type: SharedProfileType,
    existing: Record<string, unknown>,
    result: ImportResult,
    importSourcePath: boolean,
    importDestPath: boolean
  ): Record<string, unknown> {
    // Linked types store options as a flat map.
    if (type === 'vfs' || type === 'filter' || type === 'backend') {
      return this.mergeFlagsFlat(existing, result, type);
    }

    // runtimeRemote scopes options under { [remoteName]: opts }.
    if (type === 'runtimeRemote') {
      const rName = this.currentRemoteName();
      const opts =
        (existing[rName] as Record<string, unknown>) ?? (existing as Record<string, unknown>);
      return { ...existing, [rName]: this.mergeFlagsFlat(opts, result, type) };
    }

    // Operation types store options under { app, rclone }.
    const existingApp = (existing['app'] as Record<string, unknown>) ?? {};
    const rclone: Record<string, unknown> = {
      ...((existing['rclone'] as Record<string, unknown>) ?? {}),
    };

    const mapping = OPERATION_PATH_MAPPINGS[type];
    if (mapping) {
      if (result.sourcePath && importSourcePath) {
        rclone[mapping.sourceKey] = mapping.isSourceArray ? [result.sourcePath] : result.sourcePath;
      }
      if (mapping.destKey && result.destPath && importDestPath) {
        rclone[mapping.destKey] = result.destPath;
      }
      if (type === 'mount' && result.mountSubtype) rclone['mountType'] = result.mountSubtype;
      if (type === 'serve' && result.serveSubtype) rclone['type'] = result.serveSubtype;
    }

    for (const cls of result.classified) {
      if (cls.status !== 'mapped' || !cls.fieldName) continue;
      const flagType = (cls.flagType || type) as SharedProfileType;
      if (flagType !== type && LINKED_TYPES.has(flagType)) continue; // linked flags handled by mergeLinkedImportFlags
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
      if (flagType === targetType || processed.has(flagType)) continue;
      if (!LINKED_TYPES.has(flagType)) continue;

      processed.add(flagType);

      const existing = (this.profiles()[flagType]?.[profileName] as Record<string, unknown>) ?? {};
      this.profiles.update(p => ({
        ...p,
        [flagType]: {
          ...p[flagType],
          [profileName]: this.mergeFlagsFlat(existing, result, flagType),
        },
      }));

      // Wire up the linked-profile selector so the imported values become visible.
      if (mode === 'new' || mode === 'patch' || mode === 'override') {
        const group = this.remoteConfigForm.get(`${targetType}Config`) as FormGroup;
        group?.get(`${flagType}Profile`)?.setValue(profileName);
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
        // Populate the first profile of each operation type plus runtimeRemote.
        // Linked profile types (vfs/filter/backend) are populated via selectLinkedProfile
        // when each operation profile is selected.
        const typesToClone: SharedProfileType[] = [...FLAG_TYPES, 'runtimeRemote'];
        await Promise.all(
          typesToClone.map(async t => {
            const configs = this.existingConfig?.[
              REMOTE_CONFIG_KEYS[t as keyof typeof REMOTE_CONFIG_KEYS]
            ] as Record<string, unknown> | undefined;
            const firstProfile =
              configs && typeof configs === 'object' ? Object.values(configs)[0] : undefined;
            if (firstProfile && typeof firstProfile === 'object') {
              await this.populateProfileForm(t, firstProfile as Record<string, unknown>);
            }
          })
        );
      }
    } else if (this.editTarget()) {
      if (this.dialogData().remoteType)
        this.remoteForm.get('type')?.setValue(this.dialogData().remoteType);
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
        this.remoteForm.get('type')?.setValue(this.dialogData().remoteType || runtimeType || '');
      }
      if (profile) await this.populateProfileForm(type, profile);
    }
    if (this.cloneTarget()) this.generateNewCloneName();
  }

  private async populateRemoteForm(config: Record<string, unknown>): Promise<void> {
    this.isPopulatingForm.set(true);
    try {
      this.remoteForm.patchValue({ name: config['name'], type: config['type'] });
      await this.onRemoteTypeChange();
      for (const [k, v] of Object.entries(config)) {
        if (k !== 'name' && k !== 'type' && !this.remoteForm.contains(k))
          this.remoteForm.addControl(k, new FormControl(v));
      }
      this.remoteForm.patchValue(config);
    } finally {
      this.isPopulatingForm.set(false);
    }
  }

  async populateProfileForm(
    type: SharedProfileType,
    config: Record<string, unknown>
  ): Promise<void> {
    this.isPopulatingForm.set(true);
    try {
      const group = this.remoteConfigForm.get(`${type}Config`) as FormGroup;
      if (!group) return;

      if (type === 'runtimeRemote') {
        await this.populateRuntimeRemoteProfile(group, config);
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
    } finally {
      this.isPopulatingForm.set(false);
    }
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
      group.get(f.Name)?.setValue(opts[f.FieldName] ?? opts[f.Name] ?? f.Value ?? f.Default);
    }
  }

  private patchProfileFields(group: FormGroup, vals: Record<string, unknown>): void {
    const patch: Record<string, unknown> = {};
    for (const key of PROFILE_FORM_FIELDS) patch[key] = vals[key];
    group.patchValue(patch);
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
    const isSafMount =
      type === 'mount' &&
      ((vals['options'] as Record<string, unknown> | undefined)?.['mountType'] === 'saf' ||
        String(destVal?.path ?? '').startsWith('saf://'));

    if ((type === 'mount' || type === 'bisync') && !destVal?.path && !isSafMount) {
      const opType = type as 'mount' | 'bisync';
      void this.pathInspectionService.resolveDefaultPath(rName, opType).then(defaultPath => {
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

    // Ensure the subtype control (serve 'type' / mount 'mountType') exists.
    const subtypeKey = type === 'serve' ? 'type' : 'mountType';
    if ((type === 'serve' || type === 'mount') && !optsGroup.contains(subtypeKey)) {
      optsGroup.addControl(subtypeKey, new FormControl(type === 'serve' ? 'http' : 'mount'));
    }

    const fields = this.getFieldsForStep(type);
    const fieldKeys = new Set(
      fields
        .filter(f => !['type', 'mountType'].includes(f.FieldName || f.Name))
        .map(f => f.Name || f.FieldName)
    );

    for (const k of Object.keys(optsGroup.controls)) {
      if (k !== 'type' && k !== 'mountType' && !fieldKeys.has(k)) {
        optsGroup.removeControl(k);
      }
    }

    for (const f of fields) {
      if (['type', 'mountType'].includes(f.FieldName || f.Name)) continue;
      const key = f.Name || f.FieldName;
      if (!optsGroup.contains(key)) {
        optsGroup.addControl(key, new FormControl(f.Value ?? f.Default));
      }
    }

    const incomingOptions = (vals['options'] as Record<string, unknown>) || {};
    for (const [k, v] of Object.entries(incomingOptions)) {
      if (k === 'fs') continue;
      const matchedField = fields.find(f => f.FieldName === k || f.Name === k);
      const cKey = matchedField ? matchedField.Name || matchedField.FieldName : k;
      const control = optsGroup.get(cKey);
      if (control) {
        control.setValue(v);
      } else {
        optsGroup.addControl(cKey, new FormControl(v));
      }
    }
  }

  generateNewCloneName(): void {
    const base = `${this.remoteForm.get('name')?.value || 'remote'}-clone`;
    const name = findUniqueName(base, this.existingRemotes());
    this.remoteForm.get('name')?.setValue(name);
  }
}
