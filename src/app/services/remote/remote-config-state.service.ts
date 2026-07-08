import { Injectable, Signal, computed, signal, inject, DestroyRef, effect } from '@angular/core';
import { FormGroup, Validators, FormControl, FormArray, FormBuilder } from '@angular/forms';
import { startWith } from 'rxjs';
import {
  EditTarget,
  SharedProfileType,
  RemoteType,
  FLAG_TYPES,
  REMOTE_NAME_REGEX,
  DEFAULT_PROFILE_NAME,
  CommandOption,
  PREDEFINED_OPTIONS,
  RcConfigOption,
  InteractiveFlowState,
  REMOTE_CONFIG_KEYS,
  LINKED_PROFILE_TYPES,
  RemoteSettings,
  FlagType,
  SYNC_TYPES,
  SENSITIVE_KEYS,
  PROFILE_ICONS,
} from '@app/types';

import { AuthStateService } from '../security/auth-state.service';
import { ValidatorRegistryService } from '../ui/validation/validator-registry.service';
import { RemoteManagementService } from './remote-management.service';
import { MountManagementService } from '../operations/mount-management.service';
import { ServeManagementService } from '../operations/serve-management.service';
import { FlagConfigService } from './flag-config.service';
import { CliFlagMapperService, ImportResult } from './cli-flag-mapper.service';
import { RemoteFacadeService } from '../facade/remote-facade.service';
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
import { toSignal } from '@angular/core/rxjs-interop';
import { RemotePresetsService } from './remote-presets';
import { getRcloneCfg } from 'src/app/shared/utils/profile-config.util';

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
  check: OPERATION_FIELDS,
  archivecreate: OPERATION_FIELDS,
  cryptcheck: OPERATION_FIELDS,
  delete: ['autoStart', 'cronEnabled', 'cronExpression', 'watchEnabled', 'watchDelay', 'source'],
  copyurl: OPERATION_FIELDS,
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
  private readonly remoteFacade = inject(RemoteFacadeService);
  private readonly presetsService = inject(RemotePresetsService);
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
  readonly showCliImport = signal(false);
  readonly showObscureTool = signal(false);
  readonly isSearchVisible = signal(false);
  readonly searchQuery = signal('');
  readonly showAdvancedOptions = signal(false);
  readonly commandOptions = signal<CommandOption[]>(
    ((): CommandOption[] => {
      const obscure = PREDEFINED_OPTIONS.find(o => o.key === 'obscure');
      return obscure ? [{ ...obscure }] : [];
    })()
  );

  readonly isAuthInProgress = this.authStateService.isAuthInProgress;
  readonly isAuthCancelled = this.authStateService.isAuthCancelled;
  readonly oauthUrl = this.authStateService.oauthUrl;
  readonly shouldShowRemoteOAuthFallback = this.authStateService.shouldShowRemoteOAuthFallback;
  readonly interactiveFlowState = signal<InteractiveFlowState>(createInitialInteractiveFlowState());

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
    Object.fromEntries(FLAG_TYPES.map(t => [t, []])) as any
  );

  readonly allFlagFields = computed(() => ({
    ...this.dynamicFlagFields(),
    runtimeRemote: this.dynamicRuntimeRemoteFields(),
  }));
  readonly lookupTable = computed(() =>
    this.cliFlagMapper.buildLookupTable(this.allFlagFields(), this.remoteTypeSignal() || undefined)
  );

  readonly PROFILE_TYPES: SharedProfileType[] = [...FLAG_TYPES, 'runtimeRemote'];
  readonly JOB_TYPES = new Set<SharedProfileType>(SYNC_TYPES);

  readonly profileState = signal(
    this.profileRecord(() => ({ mode: 'view' as 'view' | 'edit' | 'add', tempName: '' }))
  );
  readonly profiles = signal(this.profileRecord(() => ({}) as Record<string, any>));
  readonly selectedProfileName = signal(this.profileRecord(() => DEFAULT_PROFILE_NAME));
  readonly highlightedFields = signal<
    { controlKey: string; flagType: SharedProfileType; profileName: string }[]
  >([]);

  readonly profileOptions = computed(() => {
    const runtimeNames = Object.keys(this.profiles()['runtimeRemote'] ?? {});
    return {
      vfs: Object.keys(this.profiles()['vfs'] ?? {}),
      filter: Object.keys(this.profiles()['filter'] ?? {}),
      backend: Object.keys(this.profiles()['backend'] ?? {}),
      runtimeRemote: runtimeNames.length > 0 ? runtimeNames : [DEFAULT_PROFILE_NAME],
    };
  });

  readonly profileLists = computed(
    () =>
      Object.fromEntries(
        this.PROFILE_TYPES.map(t => [
          t,
          Object.entries(this.profiles()[t] ?? {}).map(([name, data]) => ({ name, ...data })),
        ])
      ) as any
  );
  readonly profileNamesMap = computed(
    () =>
      Object.fromEntries(
        this.PROFILE_TYPES.map(t => [t, Object.keys(this.profiles()[t] ?? {})])
      ) as any
  );
  readonly highlightedFieldsForActiveProfiles = computed(() => {
    const active = new Set<string>();
    const selected = this.selectedProfileName();
    for (const h of this.highlightedFields()) {
      if (selected[h.flagType] === h.profileName) active.add(h.controlKey);
    }
    return active;
  });

  private profileRecord<T>(factory: () => T): Record<SharedProfileType, T> {
    return Object.fromEntries(this.PROFILE_TYPES.map(t => [t, factory()])) as any;
  }

  readonly changedRemoteFields = new Set<string>();
  readonly optionToFlagTypeMap: Record<string, FlagType> = {};
  readonly optionToFieldNameMap: Record<string, string> = {};
  readonly isPopulatingForm = signal(false);
  readonly dirtyProfileTypes = new Set<SharedProfileType>();
  dialogData!: DialogData;

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

  readonly stepLabels = computed(() => this.stepConfigs().map(s => s.label));
  readonly editTargetStepKey = computed(() =>
    this.editTarget()
      ? `modals.remoteConfig.steps.${this.editTarget() === 'remote' ? 'remoteConfig' : this.editTarget()}`
      : null
  );
  readonly activeProfileType = computed<SharedProfileType | null>(() => {
    const t = this.editTarget();
    return !t || t === 'remote' ? null : (t as SharedProfileType);
  });

  readonly activeSensitiveFields = computed(() => {
    const stepType = this.activeStepType();
    if (!stepType) return [];

    let fields: RcConfigOption[];
    if (stepType === 'remote') {
      fields = this.dynamicRemoteFields();
    } else if (stepType === 'runtimeRemote') {
      fields = this.dynamicRuntimeRemoteFields();
    } else if (stepType === 'serve') {
      fields = this.dynamicServeFields();
    } else {
      fields = (this.dynamicFlagFields() as any)[stepType] || [];
    }

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
        const key = getControlKey(field, stepType);
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
  readonly isBackDisabled = computed(() => this.isAuthInProgress?.() ?? false);
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
    () => (this.isAuthInProgress?.() ?? false) || this.isRemoteConfigLoading()
  );
  readonly applicableSteps = computed(() => {
    const t = this.editTarget();
    if (!t || t === 'remote') return this.stepConfigs().map((_, i) => i + 1);
    const idx = this.stepConfigs().findIndex(s => s.type === t);
    return idx !== -1 ? [idx + 1] : [1];
  });

  readonly oauthHelperUrl = computed(() =>
    (this.isAuthInProgress?.() ?? false) && !(this.isAuthCancelled?.() ?? false)
      ? (this.oauthUrl?.() ?? null)
      : null
  );
  readonly isNextDisabled = computed(() => {
    if (this.isAuthInProgress?.()) return true;
    if (this.currentStep() === 1) return this.remoteFormStatus?.() === 'INVALID';
    const type = this.stepConfigs()[this.currentStep() - 1]?.type;
    return type && type !== 'remote' ? this.isStepInvalid(type) : false;
  });

  readonly isSaveDisabled = computed(() => {
    if (this.isAuthInProgress?.()) return true;
    const t = this.editTarget();
    if (!t)
      return (
        this.remoteFormStatus?.() === 'INVALID' || this.remoteConfigFormStatus?.() === 'INVALID'
      );
    return t === 'remote' ? this.remoteFormStatus?.() === 'INVALID' : this.isStepInvalid(t);
  });

  readonly isInteractiveContinueDisabled = computed(() => {
    const s = this.interactiveFlowState();
    return (
      s.isProcessing ||
      (s.question?.Option?.Type !== 'password' &&
        (s.answer == null || String(s.answer).trim() === '')) ||
      (this.isAuthCancelled?.() ?? false)
    );
  });

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
      vfsProfile: [DEFAULT_PROFILE_NAME],
      filterProfile: [DEFAULT_PROFILE_NAME],
      backendProfile: [DEFAULT_PROFILE_NAME],
      runtimeRemoteProfile: [DEFAULT_PROFILE_NAME],
      options: this.fb.group({}),
    });
  }

  private createConfigGroup(flagType: string, fields: readonly string[]): FormGroup {
    const group: Record<string, any> = {};
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
      group['vfsProfile'] = [DEFAULT_PROFILE_NAME];
      group['filterProfile'] = [DEFAULT_PROFILE_NAME];
      group['backendProfile'] = [DEFAULT_PROFILE_NAME];
      group['runtimeRemoteProfile'] = [DEFAULT_PROFILE_NAME];
    }
    group['options'] = this.fb.group({});
    return this.fb.group(group);
  }

  addDynamicFieldsToForm(): void {
    const fields = this.dynamicFlagFields();
    for (const type of FLAG_TYPES) {
      const optGroup = this.remoteConfigForm.get(`${type}Config.options`) as FormGroup;
      if (!optGroup || !fields[type]) continue;
      for (const f of fields[type]) {
        const key = getControlKey(f, type);
        this.optionToFlagTypeMap[key] = type;
        this.optionToFieldNameMap[key] = f.FieldName;
        optGroup.addControl(
          key,
          new FormControl(f.Value ?? f.Default, f.Required ? [Validators.required] : [])
        );
      }
    }
  }

  replaceDynamicFormControls(): void {
    for (const k of Object.keys(this.remoteForm.controls)) {
      if (k !== 'name' && k !== 'type') this.remoteForm.removeControl(k);
    }
    for (const f of this.dynamicRemoteFields()) {
      this.remoteForm.addControl(
        f.Name,
        new FormControl(f.Value ?? f.Default, f.Required ? [Validators.required] : [])
      );
    }
  }

  replaceRuntimeRemoteFormControls(): void {
    const g = this.runtimeRemoteConfigGroup;
    if (!g) return;
    for (const k of Object.keys(g.controls)) {
      if (k !== 'type') g.removeControl(k);
    }
    for (const f of this.dynamicRuntimeRemoteFields()) {
      g.addControl(f.Name, new FormControl(f.Value ?? f.Default));
    }
  }

  rebuildServeOptionsGroup(): void {
    const g = this.remoteConfigForm.get('serveConfig.options') as FormGroup;
    if (!g) return;
    for (const k of Object.keys(g.controls)) {
      if (k !== 'type') g.removeControl(k);
    }
    if (!g.contains('type')) g.addControl('type', new FormControl('http'));
    for (const f of this.dynamicServeFields()) {
      if (f.FieldName === 'type' || f.Name === 'type') continue;
      g.addControl(
        getControlKey(f, 'serve'),
        new FormControl(f.Value ?? f.Default, f.Required ? [Validators.required] : [])
      );
    }
  }

  private cleanData(
    formData: Record<string, any>,
    fields: RcConfigOption[],
    type?: string
  ): Record<string, any> {
    const map = new Map(fields.map(f => [getControlKey(f, type), f]));
    return Object.entries(formData).reduce((acc, [k, v]) => {
      const f = map.get(k);
      if (f) {
        if (!this.valueMapper.isDefaultValue(v, f))
          acc[
            type === 'serve' || type === 'cryptcheck' || type === 'archivecreate'
              ? f.Name || f.FieldName
              : f.FieldName
          ] = v;
      } else if (v !== undefined && v !== null && v !== '') acc[k] = v;
      return acc;
    }, {} as any);
  }

  getRuntimeRemoteOptions(remoteName: string, config: any): Record<string, any> {
    return config[remoteName] &&
      typeof config[remoteName] === 'object' &&
      !Array.isArray(config[remoteName])
      ? config[remoteName]
      : config;
  }

  buildProfileConfig(
    type: SharedProfileType,
    remoteName: string,
    configData: Record<string, any>
  ): Record<string, any> {
    if (type === 'runtimeRemote') {
      const opts = this.dynamicRuntimeRemoteFields().reduce((acc, f) => {
        if (
          Object.prototype.hasOwnProperty.call(configData, f.Name) &&
          !this.valueMapper.isDefaultValue(configData[f.Name], f)
        )
          acc[f.FieldName || f.Name] = configData[f.Name];
        return acc;
      }, {} as any);
      return { [remoteName]: opts };
    }
    if (['vfs', 'filter', 'backend'].includes(type))
      return this.cleanData(
        configData['options'] || {},
        this.dynamicFlagFields()[type as FlagType] || [],
        type
      );
    return mapFormToConfigProfile(type, configData, {
      remoteName,
      pathService: this.pathService,
      runtimeRemoteProfileNames: this.profileOptions().runtimeRemote,
      cleanData: (opts, fields) => this.cleanData(opts, fields, type),
      dynamicFields:
        type === 'serve'
          ? this.dynamicServeFields()
          : this.dynamicFlagFields()[type as FlagType] || [],
      flatOptionNames: new Set((staticFlagDefinitions[type] || []).map(f => f.FieldName || f.Name)),
    });
  }

  cleanFormData(formData: Record<string, any>): PendingRemoteData {
    const map = new Map(this.dynamicRemoteFields().map(f => [f.Name, f]));
    const res: PendingRemoteData = { name: formData['name'], type: formData['type'] };
    for (const [k, v] of Object.entries(formData)) {
      if (k === 'name' || k === 'type') continue;
      const f = map.get(k);
      if (f) {
        if (!this.valueMapper.isDefaultValue(v, f) || this.changedRemoteFields.has(k))
          res[f.FieldName || k] = v;
      } else if (v !== null && v !== undefined && v !== '') res[k] = v;
    }
    return res;
  }

  constructor() {
    effect(() => this.setFormState(this.isAuthInProgress()));
  }

  async init(dialogData: DialogData): Promise<void> {
    this.dialogData = dialogData;
    if (dialogData?.cloneFrom || dialogData?.name) {
      await this.remoteFacade.loadRemotes();
    }

    if (dialogData?.cloneFrom) {
      this.existingConfig = await this.remoteFacade.cloneRemote(dialogData.cloneFrom);
    } else if (dialogData?.name) {
      this.existingConfig = {
        config: this.remoteFacade.activeRemotes().find(r => r.name === dialogData.name)?.config,
        ...this.remoteFacade.getRemoteSettings(dialogData.name),
      };
    }

    this.editTarget.set(dialogData?.editTarget || null);
    this.cloneTarget.set(!!dialogData?.cloneFrom);
    this.refreshRemoteNameValidator();

    await Promise.all([
      this.loadExistingRemotes(),
      this.loadRemoteTypes(),
      this.loadMountTypes(),
      this.loadServeTypes(),
    ]);
    await this.loadAllFlagFields();
    await this.loadServeFields();

    this.initProfiles(this.dialogData, this.dialogData?.autoAddProfile, this.editTarget() as any);
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
    try {
      this.existingRemotes.set(await this.remoteManagementService.getRemotes());
      this.refreshRemoteNameValidator();
    } catch (e) {
      console.error(e);
    }
  }
  private async loadRemoteTypes(): Promise<void> {
    try {
      this.remoteTypes.set(
        (await this.remoteManagementService.getRemoteTypes()).map(p => ({
          value: p.name,
          label: p.description,
        }))
      );
    } catch (e) {
      console.error(e);
    }
  }
  private async loadMountTypes(): Promise<void> {
    try {
      this.mountTypes.set(await this.mountManagementService.getMountTypes());
    } catch (e) {
      console.error(e);
    }
  }
  private async loadServeTypes(): Promise<void> {
    try {
      this.availableServeTypes.set(await this.serveManagementService.getServeTypes());
      if (this.availableServeTypes().length)
        this.selectedServeType.set(this.availableServeTypes()[0]);
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
    try {
      const fields = await this.flagConfigService.loadServeFlagFields(t);
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
      this.isLoadingServeFields.set(false);
    }
  }

  private async loadRuntimeRemoteFields(type: string): Promise<void> {
    if (!type) return;
    this.isLoadingRuntimeRemoteFields.set(true);
    try {
      this.dynamicRuntimeRemoteFields.set(
        await this.remoteManagementService.getRemoteConfigFields(type)
      );
      this.replaceRuntimeRemoteFormControls();
    } catch (e) {
      console.error(e);
    } finally {
      this.isLoadingRuntimeRemoteFields.set(false);
    }
  }

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
      if (!(this.editTarget() && this.editTarget() !== 'remote')) this.remoteForm.enable(opts);
      else this.remoteForm.disable(opts);
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

    // 1. Patch VFS default profile
    if (preset.vfs) {
      this.profiles.update(p => ({
        ...p,
        vfs: {
          ...p.vfs,
          [DEFAULT_PROFILE_NAME]: { ...p.vfs[DEFAULT_PROFILE_NAME], ...preset.vfs },
        },
      }));
    }

    // 2. Patch mount default profile's options
    if (preset.mount && Object.keys(preset.mount).length) {
      const currentMount = this.profiles().mount[DEFAULT_PROFILE_NAME] || {};
      const rclone = currentMount.rclone || {};
      this.profiles.update(p => ({
        ...p,
        mount: {
          ...p.mount,
          [DEFAULT_PROFILE_NAME]: {
            ...currentMount,
            rclone: { ...rclone, mountOpt: { ...rclone.mountOpt, ...preset.mount } },
          },
        },
      }));
    }

    // 3. Patch backend default profile
    if (preset.backend) {
      this.profiles.update(p => ({
        ...p,
        backend: {
          ...p.backend,
          [DEFAULT_PROFILE_NAME]: { ...p.backend[DEFAULT_PROFILE_NAME], ...preset.backend },
        },
      }));
    }

    // 4. Patch remote-specific config options
    if (preset.remote) {
      this.remoteForm.patchValue(preset.remote, { emitEvent: false });
      for (const key of Object.keys(preset.remote)) {
        this.onRemoteFieldChanged(key, true);
      }
    }
  }

  initProfiles(
    dialogData: DialogData,
    autoAddProfile?: boolean,
    editTarget?: SharedProfileType
  ): void {
    const newProfiles = { ...this.profiles() },
      newSelected = { ...this.selectedProfileName() };
    for (const type of this.PROFILE_TYPES) {
      const val =
        this.existingConfig?.[REMOTE_CONFIG_KEYS[type as keyof typeof REMOTE_CONFIG_KEYS]];
      newProfiles[type] =
        val && Object.keys(val).length ? ({ ...val } as any) : { [DEFAULT_PROFILE_NAME]: {} };
      newSelected[type] =
        dialogData?.targetProfile &&
        Object.keys(newProfiles[type]).includes(dialogData.targetProfile)
          ? dialogData.targetProfile
          : Object.keys(newProfiles[type])[0] || DEFAULT_PROFILE_NAME;
    }
    this.profiles.set(newProfiles);
    this.selectedProfileName.set(newSelected);

    if (this.isNewRemoteCreation() && dialogData?.remoteType) {
      this.applyPresets(dialogData.remoteType);
    }

    if (autoAddProfile && editTarget && this.PROFILE_TYPES.includes(editTarget))
      this.startAddProfile(editTarget);
  }

  private getProfileActionState(
    type: string,
    profileName: string,
    action: 'rename' | 'delete'
  ): { disabled: boolean; reason: string } {
    const t = type as SharedProfileType;
    if (!profileName || profileName.toLowerCase() === DEFAULT_PROFILE_NAME)
      return {
        disabled: true,
        reason: this.translate.instant(
          'modals.remoteConfig.profile.disabledReason.defaultProtected'
        ),
      };
    if (action === 'delete' && (this.profileLists()[t] || []).length <= 1)
      return {
        disabled: true,
        reason: this.translate.instant('modals.remoteConfig.profile.disabledReason.lastProfile'),
      };
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

  isRenameProfileDisabled(type: string, name: string): boolean {
    return this.getProfileActionState(type, name, 'rename').disabled;
  }
  isDeleteProfileDisabled(type: string, name: string): boolean {
    return this.getProfileActionState(type, name, 'delete').disabled;
  }
  getRenameProfileDisabledReason(type: string, name: string): string {
    return this.getProfileActionState(type, name, 'rename').reason;
  }
  getDeleteProfileDisabledReason(type: string, name: string): string {
    return this.getProfileActionState(type, name, 'delete').reason;
  }

  getProfileUsage(
    type: SharedProfileType,
    name: string
  ): { inUse: boolean; count: number; opType: string } {
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
    let c = 1;
    while (existing.includes(`profile-${c}`)) c++;
    this.setProfileMode(t, 'add', `profile-${c}`);
  }

  startEditProfile(type: string): void {
    const t = type as SharedProfileType,
      n = this.selectedProfileName()[t];
    if (n && n.toLowerCase() !== DEFAULT_PROFILE_NAME) this.setProfileMode(t, 'edit', n);
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
    if (name.toLowerCase() === DEFAULT_PROFILE_NAME) return;

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
      if (remaining.length) void this.selectProfile(t, remaining[0]);
      else {
        this.profiles.update(p => ({ ...p, [t]: { [DEFAULT_PROFILE_NAME]: {} } }));
        void this.selectProfile(t, DEFAULT_PROFILE_NAME);
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
    if (!this.profiles()[t]?.[name]) return;
    const curr = this.selectedProfileName()[t];
    if (curr && this.profiles()[t]?.[curr]) this.saveCurrentProfile(t);
    this.selectedProfileName.update(p => ({ ...p, [t]: name }));
    await this.populateProfileForm(t, this.profiles()[t][name]);
  }

  async selectLinkedProfile(type: SharedProfileType, name: string): Promise<void> {
    const n = this.profileNamesMap()[type]?.includes(name)
      ? name
      : this.profileNamesMap()[type]?.[0] || DEFAULT_PROFILE_NAME;
    this.selectedProfileName.update(p => ({ ...p, [type]: n }));
    const c = this.profiles()[type]?.[n];
    if (c) await this.populateProfileForm(type, c);
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
    await this.loadRemoteFields(t);
    await this.syncRuntimeRemoteType();

    if (this.isNewRemoteCreation() && t) {
      this.applyPresets(t);
      for (const flagType of this.PROFILE_TYPES) {
        const activeProfile = this.selectedProfileName()[flagType] || DEFAULT_PROFILE_NAME;
        const profileData = this.profiles()[flagType]?.[activeProfile];
        if (profileData) {
          await this.populateProfileForm(flagType, profileData);
        }
      }
    }
  }

  private async loadRemoteFields(type: string): Promise<void> {
    this.isRemoteConfigLoading.set(true);
    this.dynamicRemoteFields.set([]);
    try {
      this.dynamicRemoteFields.set(await this.remoteManagementService.getRemoteConfigFields(type));
      this.replaceDynamicFormControls();
    } catch (e) {
      console.error(e);
    } finally {
      this.isRemoteConfigLoading.set(false);
    }
  }

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
          const activeProfile = this.selectedProfileName()[flagType] || DEFAULT_PROFILE_NAME;
          const profileData = this.profiles()[flagType]?.[activeProfile];
          if (profileData) {
            void this.populateProfileForm(flagType, profileData);
          }
        }
      }
    }
  }
  toggleCliImportVisibility(): void {
    if (this.currentStep() !== 1 || this.editTarget()) {
      this.showCliImport.update(v => !v);
      if (this.showCliImport()) {
        this.showObscureTool.set(false);
      }
    }
  }

  toggleObscureToolVisibility(): void {
    this.showObscureTool.update(v => !v);
    if (this.showObscureTool()) {
      this.showCliImport.set(false);
    }
  }

  applyObscuredValue(controlKey: string, value: string): void {
    const stepType = this.activeStepType();
    if (!stepType) return;

    let group: FormGroup | null;
    if (stepType === 'remote') {
      group = this.remoteForm;
    } else if (stepType === 'runtimeRemote') {
      group = this.runtimeRemoteConfigGroup;
    } else if (stepType === 'serve') {
      group = this.remoteConfigForm.get('serveConfig.options') as FormGroup;
    } else {
      group = this.remoteConfigForm.get(`${stepType}Config.options`) as FormGroup;
    }

    if (group) {
      const control = group.get(controlKey);
      if (control) {
        control.setValue(value);
        control.markAsDirty();
        control.markAsTouched();
      }
    }
  }

  async applyImportResult(event: {
    result: ImportResult;
    profileName: string;
    mode: 'new' | 'override' | 'patch';
    importSourcePath: boolean;
    importDestPath: boolean;
  }): Promise<void> {
    const { result, profileName, mode, importSourcePath, importDestPath } = event;
    const targetType = (result.verb || this.editTarget() || 'sync') as SharedProfileType;

    if (mode === 'new') {
      this.setProfileMode(targetType, 'view');
      this.profiles.update(p => ({ ...p, [targetType]: { ...p[targetType], [profileName]: {} } }));
      await this.selectProfile(targetType, profileName);
    } else if (mode === 'override') {
      await this.selectProfile(targetType, profileName);
    }

    const activeProfileName =
      mode === 'patch'
        ? this.selectedProfileName()[targetType] || DEFAULT_PROFILE_NAME
        : profileName;
    if (this.editTarget() && this.editTarget() !== targetType) this.editTarget.set(targetType);
    const idx = this.stepConfigs().findIndex(s => s.type === targetType);
    if (idx !== -1) this.currentStep.set(idx + 1);

    const group = this.remoteConfigForm.get(`${targetType}Config`) as FormGroup;
    if (!group) return;
    if (targetType === 'serve' && result.serveSubtype)
      await this.onServeTypeChange(result.serveSubtype);
    if (targetType === 'mount' && result.mountSubtype)
      group.get('options.mountType')?.setValue(result.mountSubtype);

    if (result.sourcePath && importSourcePath) {
      const srcCtrl = group.get('source'),
        parsed = this.pathService.parseFsString(
          result.sourcePath,
          'currentRemote',
          this.currentRemoteName(),
          this.existingRemotes()
        );
      if (targetType === 'mount' || targetType === 'serve') {
        parsed.type = 'currentRemote';
        parsed.remote = '';
      }
      if (srcCtrl instanceof FormArray) {
        srcCtrl.clear();
        srcCtrl.push(this.createSourcePathGroup(parsed));
      } else srcCtrl?.patchValue(parsed);
    }
    if (result.destPath && importDestPath) {
      const destParsed = this.pathService.parseFsString(
        result.destPath,
        'local',
        this.currentRemoteName(),
        this.existingRemotes()
      );
      if (targetType === 'mount') {
        destParsed.type = 'local';
        destParsed.remote = '';
      }
      group.get('dest')?.patchValue(destParsed);
    }

    const processedLinked = new Set<SharedProfileType>();
    for (const cls of result.classified) {
      if (cls.status !== 'mapped' || !cls.fieldName) continue;
      const targetFlagType = (cls.flagType || targetType) as SharedProfileType;
      if (targetFlagType === targetType || processedLinked.has(targetFlagType)) continue;

      processedLinked.add(targetFlagType);
      const pCtrl = group.get(`${targetFlagType}Profile`);
      if (!pCtrl) continue;
      const currProfileVal = pCtrl.value || DEFAULT_PROFILE_NAME;

      if (mode !== 'patch' && currProfileVal === DEFAULT_PROFILE_NAME) {
        if (!this.profiles()[targetFlagType]?.[profileName]) {
          this.profiles.update(p => ({
            ...p,
            [targetFlagType]: {
              ...p[targetFlagType],
              [profileName]: structuredClone(
                this.profiles()[targetFlagType]?.[DEFAULT_PROFILE_NAME] || {}
              ),
            },
          }));
        }
        pCtrl.setValue(profileName);
        await this.selectLinkedProfile(targetFlagType, profileName);
      } else {
        await this.selectLinkedProfile(targetFlagType, currProfileVal);
      }
    }

    const processedKeys = new Set<string>();
    for (const cls of result.classified) {
      if (cls.status !== 'mapped' || !cls.fieldName) continue;

      const fLower = cls.fieldName.toLowerCase(),
        targetFlagType = (cls.flagType || targetType) as SharedProfileType;
      const tGroup = this.remoteConfigForm.get(`${targetFlagType}Config`) as FormGroup,
        isRuntime = targetFlagType === 'runtimeRemote';
      const tOptGroup = isRuntime ? tGroup : (tGroup?.get('options') as FormGroup);
      if (!tOptGroup) continue;

      const fields = isRuntime
        ? this.dynamicRuntimeRemoteFields()
        : targetFlagType === 'serve'
          ? this.dynamicServeFields()
          : this.dynamicFlagFields()[targetFlagType as FlagType] || [];
      const match = fields.find(
        f => f.Name?.toLowerCase() === fLower || f.FieldName?.toLowerCase() === fLower
      );
      if (!match) continue;

      const uKey = isRuntime ? match.Name : getControlKey(match, targetFlagType);
      const ctrl = tOptGroup.get(uKey);
      if (!ctrl) continue;

      if (RemoteConfigStateService.ARRAY_TYPES.has(match.Type)) {
        let arr: any[] = [];
        if (processedKeys.has(uKey)) {
          const cVal = ctrl.value;
          arr = Array.isArray(cVal)
            ? [...cVal]
            : typeof cVal === 'string' && cVal
              ? cVal
                  .split(match.Type === 'SpaceSepList' ? /\s+/ : ',')
                  .map(v => v.trim())
                  .filter(Boolean)
              : [];
        }
        const coerced = cls.coercedValue;
        if (Array.isArray(coerced))
          coerced.forEach(v => {
            if (!arr.includes(v)) arr.push(v);
          });
        else if (coerced != null && coerced !== '') {
          if (!arr.includes(coerced)) arr.push(coerced);
        }
        ctrl.setValue(arr);
      } else {
        ctrl.setValue(cls.coercedValue);
      }

      ctrl.markAsDirty();
      ctrl.markAsTouched();
      processedKeys.add(uKey);
      this.highlightField(
        uKey,
        targetFlagType,
        RemoteConfigStateService.LINKED_TYPES.has(targetFlagType)
          ? group.get(`${targetFlagType}Profile`)?.value || DEFAULT_PROFILE_NAME
          : activeProfileName
      );
    }

    processedLinked.forEach(t => this.dirtyProfileTypes.add(t));
    this.dirtyProfileTypes.add(targetType);
    this.showCliImport.set(false);
    this.showObscureTool.set(false);
    this.dirtyProfileTypes.forEach(t => this.saveCurrentProfile(t));
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
            REMOTE_CONFIG_KEYS[t as keyof typeof REMOTE_CONFIG_KEYS] as any
          ] as any;
          if (configs && Object.keys(configs).length)
            promises.push(this.populateProfileForm(t, Object.values(configs)[0] as any));
        }
        const rConfigs = this.existingConfig?.[REMOTE_CONFIG_KEYS.runtimeRemote] as any;
        if (rConfigs && Object.keys(rConfigs).length)
          promises.push(
            this.populateProfileForm('runtimeRemote', Object.values(rConfigs)[0] as any)
          );
        await Promise.all(promises);
      }
    } else if (this.editTarget()) {
      if (this.dialogData?.remoteType)
        this.remoteForm.get('type')?.setValue(this.dialogData.remoteType);
      await this.syncRuntimeRemoteType();
      const type = this.editTarget() as SharedProfileType,
        profile = this.profiles()[type]?.[this.selectedProfileName()[type]];
      if (type === 'runtimeRemote')
        this.remoteForm
          .get('type')
          ?.setValue(
            this.dialogData?.remoteType ||
              Object.values(this.profiles()['runtimeRemote']).find(p => p?.['type'])?.['type'] ||
              ''
          );
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
    const group = this.remoteConfigForm.get(`${type}Config`);
    if (!group) {
      this.isPopulatingForm.set(false);
      return;
    }
    const rName = this.currentRemoteName();

    if (type === 'runtimeRemote') {
      const opts = this.getRuntimeRemoteOptions(rName, config),
        rType = String(
          this.remoteForm.get('type')?.value || opts['type'] || config['type'] || ''
        ).trim();
      group.get('type')?.setValue(rType, { emitEvent: false });
      await this.loadRuntimeRemoteFields(rType);
      for (const f of this.dynamicRuntimeRemoteFields())
        group.get(f.Name)?.setValue(opts[f.FieldName] ?? opts[f.Name] ?? f.Value ?? f.Default, {
          emitEvent: false,
        });
      this.isPopulatingForm.set(false);
      return;
    }

    if (type === 'serve') {
      this.selectedServeType.set(
        String(getRcloneCfg(config)?.['type'] || config['type'] || 'http')
      );
      await this.loadServeFields();
    }
    const vals = mapConfigToFormProfile(type, config, {
      remoteName: rName,
      existingRemotes: this.existingRemotes(),
      pathService: this.pathService,
    });

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

    const srcCtrl = group.get('source');
    if (srcCtrl instanceof FormArray) {
      srcCtrl.clear();
      const arr = (vals['source'] || []) as any[];
      if (!arr.length) srcCtrl.push(this.createSourcePathGroup());
      else arr.forEach(s => srcCtrl.push(this.createSourcePathGroup(s)));
    } else if (srcCtrl instanceof FormGroup) srcCtrl.patchValue(vals['source']);

    const dstCtrl = group.get('dest');
    if (dstCtrl instanceof FormGroup) dstCtrl.patchValue(vals['dest']);

    const optsGroup = group.get('options') as FormGroup;
    if (optsGroup) {
      const tCtrl = optsGroup.get(type === 'serve' ? 'type' : 'mountType');
      for (const k of Object.keys(optsGroup.controls)) {
        if (k !== 'type' && k !== 'mountType') optsGroup.removeControl(k);
      }
      if (!tCtrl && (type === 'serve' || type === 'mount'))
        optsGroup.addControl(
          type === 'serve' ? 'type' : 'mountType',
          new FormControl(type === 'serve' ? 'http' : 'mount')
        );

      const fields =
        type === 'serve'
          ? this.dynamicServeFields()
          : this.dynamicFlagFields()[type as FlagType] || [];
      for (const f of fields) {
        if (['type', 'mountType'].includes(f.FieldName || f.Name)) continue;
        optsGroup.addControl(getControlKey(f, type), new FormControl(f.Value ?? f.Default));
      }
      for (const [k, v] of Object.entries(vals['options'] || {})) {
        if (k === 'fs') continue;
        const matchedField = fields.find(f => f.FieldName === k || f.Name === k);
        const cKey = matchedField
          ? getControlKey(matchedField, type)
          : getControlKey({ FieldName: k, Name: k } as any, type);
        const control = optsGroup.get(cKey);
        if (control) {
          control.setValue(v, { emitEvent: false });
        } else {
          optsGroup.addControl(cKey, new FormControl(v), { emitEvent: false });
        }
      }
    }

    if (LINKED_PROFILE_TYPES.has(type)) {
      await this.selectLinkedProfile('vfs', vals['vfsProfile']);
      await this.selectLinkedProfile('filter', vals['filterProfile']);
      await this.selectLinkedProfile('backend', vals['backendProfile']);
      await this.selectLinkedProfile('runtimeRemote', vals['runtimeRemoteProfile']);
    }
    this.isPopulatingForm.set(false);
  }

  generateNewCloneName(): void {
    const base = `${this.remoteForm.get('name')?.value || 'remote'}-clone`;
    let name = base,
      c = 1;
    while (this.existingRemotes().includes(name)) name = `${base}-${c++}`;
    this.remoteForm.get('name')?.setValue(name);
  }
}
