import { BackendService } from '../infrastructure/system/backend.service';
import { Injectable, Signal, computed, signal, inject, DestroyRef, effect } from '@angular/core';
import { FormGroup, Validators, FormControl, FormBuilder } from '@angular/forms';
import { startWith, map, distinctUntilChanged } from 'rxjs';
import {
  EditTarget,
  SharedProfileType,
  RemoteType,
  FLAG_TYPES,
  REMOTE_NAME_REGEX,
  CommandOption,
  RcConfigOption,
  LINKED_PROFILE_TYPES,
  RemoteSettings,
  FlagType,
  SYNC_TYPES,
  PROFILE_ICONS,
  PendingRemoteData,
  TemplateCategory,
  OPERATION_REGISTRY,
} from '@app/types';
import {
  createConfigFormGroup,
  reconcileDynamicControls,
  patchConfigOptions,
  patchConfigPaths,
} from './utils/config-form.utils';
import {
  getConfigCategories,
  isProviderReady,
  resolveProviderField,
} from './utils/config-metadata.utils';
import { ConfigResourceState } from './utils/config-resource-state';
import { ConfigEditorTools } from '../../shared/remote-config/config-editor-tools';
import { INITIAL_COMMAND_OPTIONS } from './utils/command-options.util';
import { findUniqueName } from './utils/unique-name.util';
import {
  buildProfileChanges,
  createProfileBaseline,
  DEFAULT_PROFILE_NAME,
  ProfileCollection,
  ProfileConfigMap,
} from './utils/profile-changes.utils';

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
  matchesConfigSearch,
} from './utils/remote-config.utils';
import { PathService } from '../infrastructure/platform/path.service';
import { PathInspectionService } from '../infrastructure/platform/path-inspection.service';
import { TranslateService } from '@ngx-translate/core';
import { NotificationService } from '../ui/notification.service';
import { JobManagementService } from '../operations/job-management.service';
import { IconService } from '../ui/icon.service';
import { RcloneValueMapperService } from './rclone-value-mapper.service';
import { toSignal } from '@angular/core/rxjs-interop';
import { RemotePresetsService } from './remote-presets';
import { getAppCfg, getRcloneCfg } from 'src/app/shared/utils/profile-config.util';
import { ImportResult } from './cli-flag-mapper.service';
import {
  LINKED_OPTION_TYPES,
  mergeImportedFlags,
  mergeImportedProfile,
} from './utils/profile-import.utils';

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

interface ProfileUsage {
  inUse: boolean;
  count: number;
  opType: string;
}

// ── Module-level constants (previously instance/static fields, recreated per dialog open) ───

const PROFILE_TYPES: readonly SharedProfileType[] = [...FLAG_TYPES, 'runtimeRemote'];
const JOB_TYPES: ReadonlySet<SharedProfileType> = new Set(SYNC_TYPES);

// Fields patched when populating a profile form (excluding `source`/`dest` which are
// handled separately because their shape varies per operation).
const PROFILE_FORM_FIELDS = [
  'autoStart',
  'showOnTray',
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
  private initialConfig?: RemoteSettings | null;
  private pendingRemoteConfig: Record<string, unknown> | null = null;
  private readonly backendService = inject(BackendService);
  private profileBackend = '';
  private profileBaseline: ProfileCollection = {};

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
  readonly initializationFailed = signal(false);
  private readonly metadata = new ConfigResourceState(this.destroyRef, error =>
    this.notificationService.showError(error)
  );
  readonly loadFailed = computed(() => this.initializationFailed() || this.metadata.failed());
  readonly isLoadingFlags = computed(() =>
    FLAG_TYPES.some(type => this.metadata.isLoading(`flags:${type}`))
  );
  private readonly profileFormOwners = new Map<SharedProfileType, string>();
  private readonly profileGenerations = new Map<SharedProfileType, number>();
  private populationCount = 0;
  readonly tools = new ConfigEditorTools();
  readonly showObscureTool = this.tools.obscureVisible;
  readonly showCliImport = this.tools.cliImportVisible;
  readonly isSearchVisible = this.tools.searchVisible;
  readonly searchQuery = this.tools.searchQuery;
  readonly showAdvancedOptions = signal(false);
  readonly commandOptions = signal<CommandOption[]>(INITIAL_COMMAND_OPTIONS);

  readonly isAuthInProgress = this.authStateService.isAuthInProgress;
  readonly isAuthCancelled = this.authStateService.isAuthCancelled;
  readonly oauthUrl = this.authStateService.oauthUrl;
  readonly interactiveFlowState = this.orchestrator.interactiveFlowState;

  readonly isRemoteConfigLoading = computed(() => this.metadata.isLoading('remote'));
  readonly isLoadingServeFields = computed(() => this.metadata.isLoading('serve'));
  readonly isLoadingRuntimeRemoteFields = computed(() => this.metadata.isLoading('runtimeRemote'));

  readonly remoteTypes = signal<RemoteType[]>([]);
  readonly existingRemotes = signal<string[]>([]);
  readonly mountTypes = this.flagConfigService.mountTypes;
  readonly availableServeTypes = this.flagConfigService.availableServeTypes;
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

  // Empty Default is a UI choice until the user edits or explicitly saves it.
  private readonly displayedProfiles = computed(() =>
    this.profileRecord(type => {
      const profiles = this.profiles()[type];
      return Object.keys(profiles).length ? profiles : { [DEFAULT_PROFILE_NAME]: {} };
    })
  );
  readonly profileNamesMap = computed(() =>
    this.profileRecord(type => Object.keys(this.displayedProfiles()[type]))
  );
  readonly profileOptions = computed(() => {
    const names = this.profileNamesMap();
    return {
      vfs: names.vfs,
      filter: names.filter,
      backend: names.backend,
      runtimeRemote: names.runtimeRemote,
    };
  });
  readonly profileLists = computed(() =>
    this.profileRecord(type =>
      Object.entries(this.displayedProfiles()[type]).map(([name, data]) => ({
        name,
        ...(data && typeof data === 'object' ? (data as Record<string, unknown>) : {}),
      }))
    )
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
  private readonly dialogData = signal<DialogData>({ remoteType: '' });

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
    return !!data.name && !data.cloneFrom;
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

  readonly providerField = computed(() => resolveProviderField(this.dynamicRemoteFields()));

  private readonly providerValue = toSignal(
    this.remoteForm.valueChanges.pipe(
      map(() => {
        const provider = this.providerField();
        return provider ? this.remoteForm.get(provider.Name)?.value : null;
      }),
      distinctUntilChanged()
    )
  );

  readonly hasAdvancedFields = computed(() => {
    const term = (this.searchQuery() ?? '').toLowerCase().trim();
    return this.dynamicRemoteFields().some(f => {
      if (!f.Advanced) return false;
      return matchesConfigSearch(f, term);
    });
  });

  readonly isProviderReady = computed(() =>
    isProviderReady(this.remoteTypeSignal(), this.providerField(), this.providerValue())
  );

  readonly remoteEditVisibleSections = computed(() => {
    const visible = new Set<string>();
    visible.add('section-general');
    if (this.providerField()) visible.add('section-auth');
    if (this.showAdvancedOptions() && this.hasAdvancedFields() && this.isProviderReady()) {
      visible.add('section-advanced');
    }
    return visible;
  });

  readonly activeFlagType = computed<FlagType | null>(() => {
    const current = this.currentStep();
    const configs = this.stepConfigs();
    if (current <= 1 || current >= configs.length) return null;
    const type = configs[current - 1]?.type;
    return (type as FlagType) || null;
  });

  getOperationConfigGroup(flagType: string): FormGroup {
    const group = this.remoteConfigForm.get(`${flagType}Config`);
    if (!(group instanceof FormGroup)) throw new Error(`Unsupported configuration: ${flagType}`);
    return group;
  }

  getLinkedProfileControl(flagType: string, profileKey: string): FormControl {
    const control = this.remoteConfigForm.get(`${flagType}Config.${profileKey}`);
    if (!(control instanceof FormControl))
      throw new Error(`Unknown linked profile: ${flagType}.${profileKey}`);
    return control;
  }

  getDynamicFlagFields(flagType: FlagType): RcConfigOption[] {
    if (flagType === 'serve') return this.dynamicServeFields();
    return this.dynamicFlagFields()[flagType] ?? [];
  }

  getProfileTemplateValues(type: FlagType): Record<string, unknown> {
    const name = this.selectedProfileName()[type];
    if (!name) return {};
    if (this.profileFormOwners.get(type) === name) {
      const options = this.remoteConfigForm.get(`${type}Config.options`) as FormGroup;
      return this.valueMapper.cleanData(options.getRawValue(), this.getDynamicFlagFields(type));
    }
    const profile = this.readProfileRecord(type, name);
    if (LINKED_OPTION_TYPES.has(type)) return structuredClone(profile);
    const values = mapConfigToFormProfile(type, profile, {
      remoteName: this.currentRemoteName(),
      existingRemotes: this.existingRemotes(),
      pathService: this.pathService,
    });
    return structuredClone(values['options'] as Record<string, unknown>);
  }

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
  readonly activeFieldsReady = computed(() => {
    const type = this.activeStepType();
    if (!type || type === 'remote') return true;
    if (type === 'runtimeRemote' || type === 'serve') return this.metadata.hasValue(type);
    return this.metadata.hasValue(`flags:${type}`);
  });
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
    () =>
      this.isInitializing() ||
      this.isAuthInProgress() ||
      this.metadata.loading() ||
      this.isPopulatingForm()
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
    if (this.isStepNavigationLocked() || this.loadFailed()) return true;
    if (this.currentStep() === 1) return this.remoteFormStatus() === 'INVALID';
    const type = this.stepConfigs()[this.currentStep() - 1]?.type;
    return type && type !== 'remote' ? this.isStepInvalid(type) : false;
  });

  readonly isSaveDisabled = computed(() => {
    if (
      this.isStepNavigationLocked() ||
      this.isLoadingServeFields() ||
      this.isLoadingRuntimeRemoteFields() ||
      this.loadFailed()
    )
      return true;
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
        ...FLAG_TYPES.map(type => [
          `${type}Config`,
          createConfigFormGroup(this.fb, type, this.destroyRef),
        ]),
        ['runtimeRemoteConfig', this.fb.group({ type: [''] })],
      ])
    );
  }

  addDynamicFieldsToForm(types: readonly FlagType[] = FLAG_TYPES): void {
    for (const type of types) {
      if (type === 'serve' || !this.dynamicFlagFields()[type]?.length) continue;
      reconcileDynamicControls(
        this.remoteConfigForm.get(`${type}Config.options`) as FormGroup,
        this.dynamicFlagFields()[type]
      );
    }
  }

  replaceDynamicFormControls(): void {
    reconcileDynamicControls(this.remoteForm, this.dynamicRemoteFields(), {
      preserveKeys: new Set(['name', 'type']),
      reset: true,
    });
  }

  replaceRuntimeRemoteFormControls(): void {
    reconcileDynamicControls(this.runtimeRemoteConfigGroup, this.dynamicRuntimeRemoteFields(), {
      preserveKeys: new Set(['type']),
      reset: true,
      required: false,
    });
  }

  rebuildServeOptionsGroup(): void {
    reconcileDynamicControls(
      this.remoteConfigForm.get('serveConfig.options') as FormGroup,
      this.dynamicServeFields(),
      { preserveKeys: new Set(['type']), prune: true }
    );
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
    return mapFormToConfigProfile(type, configData, {
      remoteName,
      pathService: this.pathService,
      cleanData: (opts, fields) => this.valueMapper.cleanData(opts, fields),
      dynamicFields: this.getFieldsForStep(type),
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
  }

  async init(dialogData: DialogData | undefined): Promise<void> {
    this.profileBackend = this.backendService.activeBackend();
    this.dialogData.set(dialogData ?? { remoteType: '' });
    this.editTarget.set(dialogData?.editTarget || null);
    this.cloneTarget.set(!!dialogData?.cloneFrom);

    this.initializationFailed.set(false);
    await Promise.all([
      this.remoteFacade.loadRemotes(),
      this.loadExistingRemotes(),
      this.loadRemoteTypes(),
    ]);

    if (dialogData?.cloneFrom) {
      this.initialConfig = await this.remoteFacade.cloneRemote(dialogData.cloneFrom);
      if (!this.initialConfig) {
        const errorMsg = this.translate.instant('modals.remoteConfig.errors.loadFailed');
        this.notificationService.showError(
          errorMsg !== 'modals.remoteConfig.errors.loadFailed'
            ? errorMsg
            : `Failed to load remote configuration for cloning: ${dialogData.cloneFrom}`
        );
        throw new Error(`Failed to clone remote: ${dialogData.cloneFrom}`);
      }
    } else if (dialogData?.name !== undefined && dialogData?.name !== null) {
      this.initialConfig = {
        config: this.remoteFacade.getRemote(dialogData.name)?.config,
        ...this.remoteFacade.getRemoteSettings(dialogData.name),
      };
    } else {
      this.initialConfig = null;
    }

    this.refreshRemoteNameValidator();
    this.initProfiles(this.dialogData(), this.dialogData()?.autoAddProfile, this.editTarget());
    this.initCurrentStep();
    await this.populateFormIfEditingOrCloning();
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

  private async safeLoad<T>(
    loader: () => Promise<T>,
    onSuccess: (value: T) => void
  ): Promise<void> {
    const value = await loader();
    if (!this.destroyRef.destroyed) onSuccess(value);
  }

  private async ensureFlagFields(type: Exclude<FlagType, 'serve'>): Promise<boolean> {
    const key = `flags:${type}`;
    if (this.metadata.hasValue(key)) return true;
    return this.metadata.load(
      key,
      () => this.flagConfigService.loadConfigFields([type]),
      fields => {
        this.dynamicFlagFields.update(current => ({ ...current, ...fields }));
        this.addDynamicFieldsToForm([type]);
      }
    );
  }

  async retryActiveFields(): Promise<void> {
    this.initializationFailed.set(false);
    await this.metadata.retryFailed();
    if (!this.metadata.failed()) await this.loadActiveProfile();
  }

  async loadActiveProfile(): Promise<void> {
    const type = this.activeStepType();
    if (!type || type === 'remote') return;
    const name = this.selectedProfileName()[type];
    if (name && (!this.activeFieldsReady() || this.profileFormOwners.get(type) !== name)) {
      await this.populateProfileForm(type, this.readProfileRecord(type, name));
    }
  }

  private async loadServeFields(): Promise<boolean> {
    const type = this.selectedServeType();
    return this.metadata.load(
      'serve',
      () => this.flagConfigService.loadServeFlagFields(type),
      fields => {
        this.dynamicServeFields.set(fields);
        this.rebuildServeOptionsGroup();
      }
    );
  }

  private async loadRuntimeRemoteFields(type: string): Promise<boolean> {
    if (!type) {
      this.metadata.clear('runtimeRemote');
      this.dynamicRuntimeRemoteFields.set([]);
      this.replaceRuntimeRemoteFormControls();
      return true;
    }
    return this.metadata.load(
      'runtimeRemote',
      () => this.remoteManagementService.getRemoteConfigFields(type),
      fields => {
        this.dynamicRuntimeRemoteFields.set(fields.map(field => ({ ...field, Required: false })));
        this.replaceRuntimeRemoteFormControls();
      }
    );
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
        if (this.isEditingExisting()) {
          this.remoteForm.get('type')?.disable(opts);
          this.remoteForm.get('name')?.disable(opts);
        } else if (this.cloneTarget()) {
          this.remoteForm.get('type')?.disable(opts);
          this.remoteForm.get('name')?.enable(opts);
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
    this.applyTemplate(preset, null);
  }

  applyTemplate(
    values: Partial<Record<TemplateCategory, Record<string, unknown>>>,
    context?: EditTarget
  ): void {
    const targetContext = context !== undefined ? context : null;
    const allowed = getConfigCategories(targetContext);
    const isAllowed = (cat: TemplateCategory): boolean => allowed.includes(cat);

    const patchProfile = (
      type: SharedProfileType,
      overrides: Record<string, unknown> | undefined
    ): void => {
      if (!overrides || !Object.keys(overrides).length) return;
      const selected = this.selectedProfileName()[type];
      if (!selected) return;
      // User templates preserve edits; automatic presets also run before forms are populated.
      this.saveCurrentProfile(type);
      const current = this.readProfileRecord(type, selected);

      if (type === 'vfs' || type === 'filter' || type === 'backend') {
        this.profiles.update(p => ({
          ...p,
          [type]: { ...p[type], [selected]: { ...current, ...overrides } },
        }));
      } else {
        const rclone = { ...((current['rclone'] as Record<string, unknown> | undefined) ?? {}) };
        Object.assign(rclone, overrides);
        this.profiles.update(p => ({
          ...p,
          [type]: {
            ...p[type],
            [selected]: {
              ...current,
              rclone,
            },
          },
        }));
      }
    };

    for (const type of FLAG_TYPES) {
      if (isAllowed(type)) patchProfile(type, values[type]);
    }

    if (values.remote && isAllowed('remote')) {
      this.remoteForm.patchValue(values.remote, { emitEvent: false });
      for (const key of Object.keys(values.remote)) this.onRemoteFieldChanged(key, true);
    }

    const active = context ?? this.activeStepType();
    for (const type of FLAG_TYPES) {
      if (!isAllowed(type) || !values[type]) continue;
      this.profileFormOwners.delete(type);
      if (type === active) {
        const name = this.selectedProfileName()[type];
        if (name) void this.populateProfileForm(type, this.readProfileRecord(type, name));
      }
    }
  }

  private readProfileRecord(type: SharedProfileType, name: string): Record<string, unknown> {
    const p = this.profiles()[type]?.[name];
    return p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
  }

  initProfiles(dialogData: DialogData, autoAddProfile?: boolean, editTarget?: EditTarget): void {
    this.profileFormOwners.clear();
    this.profileBaseline = createProfileBaseline(this.initialConfig);
    const newProfiles = { ...this.profiles() },
      newSelected = { ...this.selectedProfileName() };
    for (const type of this.PROFILE_TYPES) {
      newProfiles[type] = structuredClone(this.profileBaseline[type] ?? {});
      newSelected[type] =
        dialogData?.targetProfile &&
        Object.keys(newProfiles[type]).includes(dialogData.targetProfile)
          ? dialogData.targetProfile
          : (Object.keys(newProfiles[type])[0] ?? DEFAULT_PROFILE_NAME);
    }
    this.profiles.set(newProfiles);
    this.selectedProfileName.set(newSelected);
    for (const type of this.PROFILE_TYPES) {
      const name = newSelected[type];
      if (name && !Object.hasOwn(newProfiles[type], name)) this.profileFormOwners.set(type, name);
    }

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
      (action === 'delete' &&
        (isJob || t === 'mount' || t === 'serve' || LINKED_OPTION_TYPES.has(t)));

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
    if (LINKED_OPTION_TYPES.has(type)) {
      const key = `${type}Profile`;
      const count = [...LINKED_PROFILE_TYPES]
        .flatMap(operation => Object.values(this.profiles()[operation as SharedProfileType] ?? {}))
        .filter(data => {
          if (!data || typeof data !== 'object') return false;
          const profile = data as Record<string, unknown>;
          return ((getAppCfg(profile) ?? profile) as Record<string, unknown>)[key] === name;
        }).length;
      return { inUse: count > 0, count, opType: 'profile' };
    }
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
    if (this.selectedProfileName()[t] === sourceName) this.saveCurrentProfile(t);
    const source = this.displayedProfiles()[t]?.[sourceName];
    if (!source) return;
    const existing = this.profileNamesMap()[t];
    const newName = findUniqueName(sourceName || 'profile', existing);
    this.profiles.update(p => ({
      ...p,
      [t]: { ...p[t], [newName]: structuredClone(source) },
    }));
    void this.selectProfile(t, newName).then(() => {
      if (this.selectedProfileName()[t] === newName && this.profileFormOwners.get(t) === newName) {
        this.setProfileMode(t, 'edit', newName);
      }
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
      this.saveCurrentProfile(t);
      const data = this.displayedProfiles()[t][oldName];
      this.profiles.update(p => {
        const u = { ...p, [t]: { ...p[t], [newName]: data } };
        delete u[t][oldName];
        return u;
      });
      this.selectedProfileName.update(s => ({ ...s, [t]: newName }));
      this.profileFormOwners.set(t, newName);
      if (LINKED_OPTION_TYPES.has(t)) this.renameLinkedProfileReferences(t, oldName, newName);
      void this.cascadeProfileRename(t, oldName, newName);
    }
    this.setProfileMode(t, 'view');
  }

  private renameLinkedProfileReferences(
    type: SharedProfileType,
    oldName: string,
    newName: string
  ): void {
    const key = `${type}Profile`;
    this.profiles.update(profiles => {
      const updated = { ...profiles };
      for (const operation of LINKED_PROFILE_TYPES) {
        const op = operation as SharedProfileType;
        const configs = { ...profiles[op] };
        for (const [name, data] of Object.entries(configs)) {
          if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
          const profile = data as Record<string, unknown>;
          const app = getAppCfg(profile);
          const references: Record<string, unknown> = { ...(app ?? profile) };
          if (references[key] !== oldName) continue;
          configs[name] = app
            ? { ...profile, app: { ...app, [key]: newName } }
            : { ...profile, [key]: newName };
        }
        updated[op] = configs;
      }
      return updated;
    });
    for (const operation of LINKED_PROFILE_TYPES) {
      const control = this.remoteConfigForm.get(`${operation}Config.${key}`);
      if (control?.value === oldName) control.setValue(newName);
    }
  }

  deleteProfile(type: string, name: string): void {
    const t = type as SharedProfileType;

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
      this.remoteConfigForm.get(`${t}Config`)?.markAsPristine();
      const remaining = this.profileNamesMap()[t];
      this.selectedProfileName.update(p => ({ ...p, [t]: null }));
      void this.selectProfile(t, remaining[0]);
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
    if (this.selectedProfileName()[type] === name) this.profileFormOwners.delete(type);
    this.profiles.update(p => ({ ...p, [type]: { ...p[type], [name]: config } }));
  }

  async selectProfile(type: EditTarget, name: string): Promise<void> {
    if (!type) return;
    const t = type as SharedProfileType;
    const profile = this.displayedProfiles()[t]?.[name];
    if (!profile) return;
    const curr = this.selectedProfileName()[t];
    if (
      curr === name &&
      this.profileFormOwners.get(t) === name &&
      (t === 'runtimeRemote' || t === 'serve'
        ? this.metadata.isReady(t)
        : this.metadata.isReady(`flags:${t}`))
    )
      return;
    if (curr && curr !== name) this.saveCurrentProfile(t);
    this.profileFormOwners.delete(t);
    this.selectedProfileName.update(p => ({ ...p, [t]: name }));
    await this.populateProfileForm(t, profile as Record<string, unknown>);
  }

  private selectLinkedProfile(type: SharedProfileType, name: string): void {
    const selected = this.profileNamesMap()[type]?.includes(name)
      ? name
      : (this.profileNamesMap()[type]?.[0] ?? null);
    if (this.selectedProfileName()[type] === selected) return;
    this.saveCurrentProfile(type);
    this.profileFormOwners.delete(type);
    this.selectedProfileName.update(current => ({ ...current, [type]: selected }));
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
      await this.loadActiveProfile();
      if (this.loadFailed()) return false;
      this.saveCurrentProfile(activeType, true);
    } else {
      this.PROFILE_TYPES.filter(t => this.remoteConfigForm.get(`${t}Config`)?.dirty).forEach(t =>
        this.saveCurrentProfile(t)
      );
    }

    const { settings, expectedSettings, nextBaseline } = buildProfileChanges(
      this.profiles(),
      this.profileBaseline
    );

    try {
      // Watch roots must exist before the backend applies the saved configuration.
      await this.pathInspectionService.createRequiredDirectories(
        settings,
        this.profileBackend || this.backendService.activeBackend()
      );
      await this.appSettingsService.saveRemoteSettings(
        remote,
        settings,
        expectedSettings,
        this.profileBackend || this.backendService.activeBackend()
      );
      this.profileBaseline = nextBaseline;
      this.remoteConfigForm.markAsPristine();
      await this.remoteFacade.loadRemotes();
      const selName = (activeType && this.selectedProfileName()[activeType]) || 'Default';
      this.notificationService.showSuccess(
        this.translate.instant('modals.remoteConfig.profileSaved', { profile: selName, remote }) ||
          `Profile "${selName}" saved for remote "${remote}"`
      );
      return true;
    } catch (e) {
      console.error('Failed to save profile settings:', e);
      this.notificationService.showError(
        e || this.translate.instant('modals.remoteConfig.profileSaveFailed')
      );
      return false;
    }
  }

  saveCurrentProfile(type: EditTarget, explicitSave = false): void {
    if (!type) return;
    const t = type as SharedProfileType,
      n = this.selectedProfileName()[t],
      g = this.remoteConfigForm.get(`${t}Config`);
    if (!n || !g || this.profileFormOwners.get(t) !== n) return;
    if (!explicitSave && !g.dirty && !Object.hasOwn(this.profiles()[t], n)) return;
    this.updateProfileConfig(t, n, this.buildProfileConfig(t, this.currentRemoteName(), g.value));
    this.profileFormOwners.set(t, n);
  }

  private saveCurrentTargetProfile(target: NonNullable<EditTarget>): void {
    if (target !== 'remote') {
      this.saveCurrentProfile(target);
    }
  }

  navigateToShared(type: EditTarget): void {
    if (!type) return;
    const curr = this.editTarget();
    if (curr) {
      this.saveCurrentTargetProfile(curr);
      this.editStack.update(s => [...s, curr]);
    }
    this.editTarget.set(type);
    const idx = this.stepConfigs().findIndex(s => s.type === type);
    if (idx !== -1) this.currentStep.set(idx + 1);
    if (type !== 'remote') {
      const name = this.selectedProfileName()[type];
      if (name) void this.populateProfileForm(type, this.readProfileRecord(type, name));
    }
  }

  returnFromShared(): void {
    const stack = this.editStack();
    if (!stack.length) return;
    const target = stack[stack.length - 1];
    if (target === undefined) return;
    const curr = this.editTarget();
    if (curr) this.saveCurrentTargetProfile(curr);
    this.editStack.update(s => s.slice(0, -1));
    this.editTarget.set(target);
    const idx = this.stepConfigs().findIndex(s => s.type === target);
    if (idx !== -1) this.currentStep.set(idx + 1);
    void this.loadActiveProfile();
  }

  async onServeTypeChange(type: string): Promise<void> {
    if (this.selectedServeType() === type) return;
    this.selectedServeType.set(type || 'http');
    this.remoteConfigForm.get('serveConfig.options.type')?.setValue(type, { emitEvent: false });
    await this.loadServeFields();
  }

  async onRemoteTypeChange(): Promise<void> {
    const type = this.remoteForm.get('type')?.value as string;
    // Runtime overrides belong to the selected provider and are populated when opened.
    this.profileFormOwners.delete('runtimeRemote');
    this.metadata.clear('runtimeRemote');
    const loaded = await this.loadRemoteFields(type);
    if (!loaded || this.remoteForm.get('type')?.value !== type || this.destroyRef.destroyed) return;
    if (this.isNewRemoteCreation() && type) this.applyPresets(type);
  }

  private async loadRemoteFields(type: string): Promise<boolean> {
    if (!type) {
      this.metadata.clear('remote');
      this.dynamicRemoteFields.set([]);
      this.replaceDynamicFormControls();
      return true;
    }
    return this.metadata.load(
      'remote',
      () => this.remoteManagementService.getRemoteConfigFields(type),
      fields => {
        this.dynamicRemoteFields.set(fields);
        this.replaceDynamicFormControls();
        const saved = this.pendingRemoteConfig;
        if (saved?.['type'] === type) {
          for (const [key, value] of Object.entries(saved)) {
            if (!this.remoteForm.get(key))
              this.remoteForm.addControl(key, new FormControl(value), { emitEvent: false });
          }
          this.remoteForm.patchValue(saved);
          this.pendingRemoteConfig = null;
        }
      }
    );
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
      }
    }
  }
  toggleObscureToolVisibility(): void {
    this.tools.toggle('obscure');
  }

  toggleCliImportVisibility(): void {
    this.tools.toggle('cliImport');
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
    if (mode === 'patch') this.saveCurrentProfile(targetType);

    if (mode === 'new') {
      this.setProfileMode(targetType, 'view');
      this.ensureProfileEntry(targetType, activeProfileName);
      // Seed linked profile entries so import flags targeting vfs/filter/backend/runtimeRemote
      // have somewhere to land.
      if (LINKED_PROFILE_TYPES.has(targetType)) {
        for (const linkedType of LINKED_OPTION_TYPES) {
          this.ensureProfileEntry(linkedType as SharedProfileType, activeProfileName, true);
        }
      }
    }

    const existing =
      mode === 'new'
        ? {}
        : ((this.profiles()[targetType]?.[activeProfileName] as Record<string, unknown>) ?? {});

    const merged = mergeImportedProfile(
      targetType,
      existing,
      result,
      importSourcePath,
      importDestPath,
      this.currentRemoteName()
    );
    this.profileFormOwners.delete(targetType);
    this.profiles.update(p => ({
      ...p,
      [targetType]: { ...p[targetType], [activeProfileName]: merged },
    }));
    this.mergeLinkedImportFlags(result, targetType, activeProfileName);

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

    this.tools.close();
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

  private mergeLinkedImportFlags(
    result: ImportResult,
    targetType: SharedProfileType,
    profileName: string
  ): void {
    const processed = new Set<SharedProfileType>();

    for (const cls of result.classified) {
      if (cls.status !== 'mapped' || !cls.fieldName) continue;
      const flagType = (cls.flagType || targetType) as SharedProfileType;
      if (flagType === targetType || processed.has(flagType)) continue;
      if (!LINKED_OPTION_TYPES.has(flagType)) continue;

      processed.add(flagType);
      this.profileFormOwners.delete(flagType);

      const existing = (this.profiles()[flagType]?.[profileName] as Record<string, unknown>) ?? {};
      this.profiles.update(p => ({
        ...p,
        [flagType]: {
          ...p[flagType],
          [profileName]: mergeImportedFlags(existing, result, flagType),
        },
      }));

      if (LINKED_PROFILE_TYPES.has(targetType)) {
        const profile = this.readProfileRecord(targetType, profileName);
        this.updateProfileConfig(targetType, profileName, {
          ...profile,
          app: { ...getAppCfg(profile), [`${flagType}Profile`]: profileName },
        });
      }
    }
  }

  private async populateFormIfEditingOrCloning(): Promise<void> {
    if (!this.initialConfig) return;
    if (this.editTarget() === 'remote' || this.cloneTarget()) {
      const remoteSpecs = (this.initialConfig['config'] || this.initialConfig) as Record<
        string,
        unknown
      >;
      await this.populateRemoteForm(remoteSpecs);
    } else if (this.editTarget()) {
      if (this.dialogData().remoteType)
        this.remoteForm.get('type')?.setValue(this.dialogData().remoteType);
      const type = this.editTarget() as SharedProfileType,
        selectedName = this.selectedProfileName()[type],
        profile = selectedName
          ? (this.displayedProfiles()[type]?.[selectedName] as Record<string, unknown> | undefined)
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
    } else if (!this.editTarget() && !this.cloneTarget()) {
      const initialName = this.dialogData()?.name;
      if (initialName) this.remoteForm.get('name')?.setValue(initialName);
    }
    if (this.cloneTarget()) {
      const currentName = this.remoteForm.get('name')?.value || '';
      if (!currentName || this.existingRemotes().includes(currentName)) {
        this.generateNewCloneName();
      }
    }
  }

  private async populateRemoteForm(config: Record<string, unknown>): Promise<void> {
    this.pendingRemoteConfig = config;
    this.isPopulatingForm.set(true);
    try {
      this.remoteForm.patchValue({ name: config['name'], type: config['type'] });
      await this.onRemoteTypeChange();
    } finally {
      this.isPopulatingForm.set(false);
    }
  }

  async populateProfileForm(
    type: SharedProfileType,
    config: Record<string, unknown>
  ): Promise<void> {
    const generation = (this.profileGenerations.get(type) ?? 0) + 1;
    this.profileGenerations.set(type, generation);
    this.profileFormOwners.delete(type);
    const profileName = this.selectedProfileName()[type];
    this.populationCount++;
    this.isPopulatingForm.set(true);
    try {
      const group = this.remoteConfigForm.get(`${type}Config`) as FormGroup;
      if (!group) return;

      if (type === 'runtimeRemote') {
        if (await this.populateRuntimeRemoteProfile(group, config, generation)) {
          if (profileName) this.profileFormOwners.set(type, profileName);
          group.markAsPristine();
        }
        return;
      }

      if (type === 'serve') {
        this.selectedServeType.set(
          String(getRcloneCfg(config)?.['type'] || config['type'] || 'http')
        );
        if (!(await this.loadServeFields())) return;
      } else if (!(await this.ensureFlagFields(type))) return;
      if (this.profileGenerations.get(type) !== generation || this.destroyRef.destroyed) return;

      const rName = this.currentRemoteName();
      const vals = mapConfigToFormProfile(type, config, {
        remoteName: rName,
        existingRemotes: this.existingRemotes(),
        pathService: this.pathService,
      });

      this.patchProfileFields(group, vals);
      this.populateProfilePaths(group, vals);
      this.populateProfileOptions(group, type, vals);
      group.markAsPristine();
      if (profileName) this.profileFormOwners.set(type, profileName);

      if (LINKED_PROFILE_TYPES.has(type)) {
        const op = OPERATION_REGISTRY.find(o => o.key === type);
        if (op?.supportsVfs) {
          this.selectLinkedProfile('vfs', String(vals['vfsProfile'] ?? ''));
        }
        this.selectLinkedProfile('filter', String(vals['filterProfile'] ?? ''));
        this.selectLinkedProfile('backend', String(vals['backendProfile'] ?? ''));
        this.selectLinkedProfile('runtimeRemote', String(vals['runtimeRemoteProfile'] ?? ''));
      }
    } catch (error) {
      if (this.profileGenerations.get(type) === generation && !this.destroyRef.destroyed) {
        this.initializationFailed.set(true);
        this.notificationService.showError(error);
      }
    } finally {
      this.populationCount--;
      this.isPopulatingForm.set(this.populationCount > 0);
    }
  }

  private async populateRuntimeRemoteProfile(
    group: FormGroup,
    config: Record<string, unknown>,
    generation: number
  ): Promise<boolean> {
    const rName = this.currentRemoteName();
    const opts = this.getRuntimeRemoteOptions(rName, config);
    const rType = String(
      this.remoteForm.get('type')?.value || opts['type'] || config['type'] || ''
    ).trim();
    group.get('type')?.setValue(rType, { emitEvent: false });
    if (!(await this.loadRuntimeRemoteFields(rType))) return false;
    if (this.profileGenerations.get('runtimeRemote') !== generation || this.destroyRef.destroyed)
      return false;
    patchConfigOptions(
      group,
      Object.fromEntries(
        this.dynamicRuntimeRemoteFields().map(field => [
          field.Name || field.FieldName,
          opts[field.FieldName] ?? opts[field.Name] ?? field.Value ?? field.Default,
        ])
      )
    );
    return true;
  }

  private patchProfileFields(group: FormGroup, vals: Record<string, unknown>): void {
    const patch: Record<string, unknown> = {};
    for (const key of PROFILE_FORM_FIELDS) patch[key] = vals[key];
    group.patchValue(patch, { emitEvent: false });
  }

  private populateProfilePaths(group: FormGroup, vals: Record<string, unknown>): void {
    patchConfigPaths(group, vals);
  }

  private populateProfileOptions(
    group: FormGroup,
    type: SharedProfileType,
    vals: Record<string, unknown>
  ): void {
    const options = group.get('options') as FormGroup;
    const fields = this.getFieldsForStep(type);
    const incoming = (vals['options'] as Record<string, unknown>) ?? {};
    reconcileDynamicControls(options, fields, {
      preserveKeys: new Set(['type', 'mountType', ...Object.keys(incoming)]),
      prune: true,
    });
    const defaults = Object.fromEntries(
      fields.map(field => [field.Name || field.FieldName, field.Value ?? field.Default ?? null])
    );
    patchConfigOptions(options, { ...defaults, ...incoming }, fields);
  }

  generateNewCloneName(): void {
    const currentName = this.remoteForm.get('name')?.value || '';
    const cleanBase = currentName.replace(/-(?:clone|\d+)+$/, '');
    const name = findUniqueName(`${cleanBase || 'remote'}-clone`, this.existingRemotes());
    this.remoteForm.get('name')?.setValue(name);
  }
}
