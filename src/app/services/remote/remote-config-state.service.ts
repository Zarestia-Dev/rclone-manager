import {
  Injectable,
  Signal,
  computed,
  signal,
  inject,
  DestroyRef,
  effect,
  Injector,
  runInInjectionContext,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { FormGroup, Validators, FormControl, FormArray, AbstractControl } from '@angular/forms';
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
} from '@app/types';

import { AuthStateService } from '../security/auth-state.service';
import { ValidatorRegistryService } from '../ui/validation/validator-registry.service';
import { RemoteManagementService } from './remote-management.service';
import { MountManagementService } from '../operations/mount-management.service';
import { ServeManagementService } from '../operations/serve-management.service';
import { FlagConfigService } from './flag-config.service';
import { ImportResult } from './cli-flag-mapper.service';
import { createInitialInteractiveFlowState } from './utils/remote-config.utils';
import {
  RemoteConfigFormBuilderService,
  PendingRemoteData,
} from './remote-config-form-builder.service';
import {
  RemoteConfigProfileManagerService,
  StepConfig,
} from './remote-config-profile-manager.service';
import { RemoteConfigCliImporterService } from './remote-config-cli-importer.service';
import { IconService } from '../ui/icon.service';

export interface DialogData {
  editTarget?: EditTarget;
  cloneTarget?: boolean;
  existingConfig?: RemoteConfigSections;
  name?: string;
  remoteType: string;
  targetProfile?: string;
  autoAddProfile?: boolean;
}

@Injectable()
export class RemoteConfigStateService {
  // ── Sub-services ──
  private readonly formBuilder = inject(RemoteConfigFormBuilderService);
  private readonly profileManager = inject(RemoteConfigProfileManagerService);
  private readonly cliImporter = inject(RemoteConfigCliImporterService);

  // ── Services ──
  private readonly authStateService = inject(AuthStateService);
  private readonly remoteManagementService = inject(RemoteManagementService);
  private readonly mountManagementService = inject(MountManagementService);
  private readonly serveManagementService = inject(ServeManagementService);
  private readonly flagConfigService = inject(FlagConfigService);
  private readonly validatorRegistry = inject(ValidatorRegistryService);
  private readonly iconService = inject(IconService);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);

  // ── Form references ──
  remoteForm!: FormGroup;
  remoteConfigForm!: FormGroup;
  runtimeRemoteConfigGroup!: FormGroup;

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

  // ── Form status signals (initialized in init()) ──
  remoteFormStatus: Signal<string> = signal('INVALID').asReadonly();
  remoteConfigFormStatus: Signal<string> = signal('INVALID').asReadonly();
  remoteTypeSignal: Signal<string> = signal('').asReadonly();
  remoteNameSignal: Signal<string> = signal('').asReadonly();

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

  // ── Delegates to Profile Manager ──
  readonly profileState = this.profileManager.profileState;
  readonly profiles = this.profileManager.profiles;
  readonly selectedProfileName = this.profileManager.selectedProfileName;
  readonly highlightedFields = this.profileManager.highlightedFields;
  readonly profileOptions = this.profileManager.profileOptions;
  readonly profileLists = this.profileManager.profileLists;
  readonly profileNamesMap = this.profileManager.profileNamesMap;
  readonly highlightedFieldsForActiveProfiles =
    this.profileManager.highlightedFieldsForActiveProfiles;

  // ── Helpers ──
  readonly changedRemoteFields = new Set<string>();
  readonly optionToFlagTypeMap: Record<string, FlagType> = {};
  readonly optionToFieldNameMap: Record<string, string> = {};
  readonly isPopulatingForm = signal(false);
  readonly dirtyProfileTypes = new Set<SharedProfileType>();
  dialogData!: DialogData;

  // ── Computed states ──
  readonly currentRemoteName = computed(() => this.dialogData?.name ?? this.remoteNameSignal());

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
        return this._isStepInvalid?.(stepType) ?? false;
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

    return this._isStepInvalid?.(target) ?? false;
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

  // ── Step validation callback ──
  private _isStepInvalid?: (stepType: string) => boolean;

  setStepInvalidFn(fn: (stepType: string) => boolean): void {
    this._isStepInvalid = fn;
  }

  // ── Initializer ──
  async init(dialogData: DialogData): Promise<void> {
    this.dialogData = dialogData;
    this.editTarget.set(dialogData?.editTarget ?? null);
    this.cloneTarget.set(dialogData?.cloneTarget ?? false);

    this.remoteForm = this.formBuilder.createRemoteForm(
      this.existingRemotes(),
      this.editTarget() === 'remote',
      this.cloneTarget()
    );
    this.remoteConfigForm = this.formBuilder.createRemoteConfigForm(this.dynamicFlagFields());
    this.runtimeRemoteConfigGroup = this.remoteConfigForm.get('runtimeRemoteConfig') as FormGroup;

    runInInjectionContext(this.injector, () => {
      this.remoteFormStatus = toSignal(
        this.remoteForm.statusChanges.pipe(startWith(this.remoteForm.status)),
        { initialValue: this.remoteForm.status }
      );
      this.remoteConfigFormStatus = toSignal(
        this.remoteConfigForm.statusChanges.pipe(startWith(this.remoteConfigForm.status)),
        { initialValue: this.remoteConfigForm.status }
      );
      const typeControl = this.remoteForm.get('type');
      const nameControl = this.remoteForm.get('name');
      if (typeControl && nameControl) {
        this.remoteTypeSignal = toSignal(
          typeControl.valueChanges.pipe(startWith(typeControl.value as string)),
          { initialValue: typeControl.value as string }
        );
        this.remoteNameSignal = toSignal(
          nameControl.valueChanges.pipe(startWith(nameControl.value as string)),
          { initialValue: nameControl.value as string }
        );
      }
    });

    await Promise.all([
      this.loadExistingRemotes(),
      this.loadRemoteTypes(),
      this.loadAllFlagFields(),
      this.loadMountTypes(),
      this.loadServeTypes(),
    ]);
    await this.loadServeFields();

    this.profileManager.initProfiles(
      this.dialogData,
      this.dialogData?.autoAddProfile,
      this.editTarget() as SharedProfileType
    );
    this.initCurrentStep();
    await this.populateFormIfEditingOrCloning();
    this.setupAutoStartValidators();
    this.setupAuthStateListeners();
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

  private static readonly AUTO_START_OP_TYPES = new Set(['sync', 'copy', 'move', 'bisync']);

  private setupAutoStartValidators(): void {
    if (this.editTarget() === 'remote' || !this.editTarget() || this.cloneTarget()) {
      for (const type of FLAG_TYPES) {
        if (type !== 'mount' && !RemoteConfigStateService.AUTO_START_OP_TYPES.has(type)) continue;

        const opGroup = this.remoteConfigForm.get(`${type}Config`);
        if (!opGroup) continue;

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
          const sourceControl = opGroup.get('source');
          const destControl = opGroup.get('dest');
          const autoStartCtrl = opGroup.get('autoStart');
          const cronEnabledCtrl = opGroup.get('cronEnabled');
          const cronExpressionCtrl = opGroup.get('cronExpression');
          const watchEnabledCtrl = opGroup.get('watchEnabled');
          const watchDelayCtrl = opGroup.get('watchDelay');

          cronExpressionCtrl?.setValidators(this.validatorRegistry.requiredIfCronEnabled());
          watchDelayCtrl?.setValidators(this.validatorRegistry.requiredIfWatchEnabled());

          autoStartCtrl?.valueChanges.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
            if (sourceControl instanceof FormArray) {
              sourceControl.controls.forEach((c: AbstractControl) =>
                c.get('path')?.updateValueAndValidity()
              );
            } else if (sourceControl instanceof FormGroup) {
              sourceControl.get('path')?.updateValueAndValidity();
            }
            if (destControl instanceof FormGroup) {
              destControl.get('path')?.updateValueAndValidity();
            }
          });
          cronEnabledCtrl?.valueChanges.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
            cronExpressionCtrl?.updateValueAndValidity();
          });
          watchEnabledCtrl?.valueChanges.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
            watchDelayCtrl?.updateValueAndValidity();
          });
        }
      }
    }
  }

  private setupAuthStateListeners(): void {
    effect(
      () => {
        const isInProgress = this.isAuthInProgress();
        this.setFormState(isInProgress);
      },
      { injector: this.injector }
    );
  }

  private setFormState(disabled: boolean): void {
    const opts = { emitEvent: false } as const;
    if (disabled) {
      this.remoteForm.disable(opts);
      this.remoteConfigForm.disable(opts);
    } else {
      this.remoteForm.enable(opts);
      this.remoteConfigForm.enable(opts);
      if (this.editTarget() && this.editTarget() !== 'remote') {
        this.remoteForm.disable(opts);
      }
    }
  }

  private addDynamicFieldsToForm(): void {
    this.formBuilder.addDynamicFieldsToForm(
      this.remoteConfigForm,
      this.dynamicFlagFields(),
      this.getUniqueControlKey,
      this.optionToFlagTypeMap,
      this.optionToFieldNameMap
    );
  }

  private replaceRuntimeRemoteFormControls(): void {
    this.formBuilder.replaceRuntimeRemoteFormControls(
      this.remoteConfigForm,
      this.dynamicRuntimeRemoteFields()
    );
  }

  private rebuildServeOptionsGroup(): void {
    this.formBuilder.rebuildServeOptionsGroup(this.remoteConfigForm, this.dynamicServeFields());
  }

  readonly getUniqueControlKey = (flagType: FlagType, field: RcConfigOption): string =>
    flagType === 'serve'
      ? field.FieldName || field.Name
      : `${flagType}---${field.FieldName || field.Name}`;

  private initCurrentStep(): void {
    const editTargetValue = this.editTarget();
    if (!editTargetValue) {
      this.currentStep.set(1);
      return;
    }
    const index = this.stepConfigs().findIndex(s => s.type === editTargetValue);
    this.currentStep.set(index !== -1 ? index + 1 : 1);
  }

  // ── Profile CRUD ──
  isRenameProfileDisabled(type: string, profileName: string): boolean {
    return this.profileManager.isRenameProfileDisabled(type, profileName, this.currentRemoteName());
  }

  isDeleteProfileDisabled(type: string, profileName: string): boolean {
    return this.profileManager.isDeleteProfileDisabled(type, profileName, this.currentRemoteName());
  }

  getRenameProfileDisabledReason(type: string, profileName: string): string {
    return this.profileManager.getRenameProfileDisabledReason(
      type,
      profileName,
      this.currentRemoteName()
    );
  }

  getDeleteProfileDisabledReason(type: string, profileName: string): string {
    return this.profileManager.getDeleteProfileDisabledReason(
      type,
      profileName,
      this.currentRemoteName()
    );
  }

  startAddProfile(type: string): void {
    this.profileManager.startAddProfile(type);
  }

  startEditProfile(type: string): void {
    this.profileManager.startEditProfile(type);
  }

  cancelProfileEdit(type: string): void {
    this.profileManager.cancelProfileEdit(type);
  }

  saveProfile(type: string): void {
    const t = type as SharedProfileType;
    this.dirtyProfileTypes.add(t);
    this.profileManager.saveProfile(t, this.currentRemoteName(), (pt, name) =>
      this.selectProfile(pt, name)
    );
  }

  deleteProfile(type: string, name: string): void {
    const t = type as SharedProfileType;
    this.dirtyProfileTypes.add(t);
    this.profileManager.deleteProfile(t, name, this.currentRemoteName(), (pt, n) =>
      this.selectProfile(pt, n)
    );
  }

  setProfileTempName(type: string, name: string): void {
    this.profileManager.setProfileTempName(type, name);
  }

  setProfileMode(type: SharedProfileType, mode: 'view' | 'edit' | 'add', tempName = ''): void {
    this.profileManager.setProfileMode(type, mode, tempName);
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

    await this.formBuilder.populateProfileForm(
      t,
      this.profiles()[t][name] as Record<string, unknown>,
      this.remoteConfigForm,
      this.remoteForm,
      this.currentRemoteName(),
      this.existingRemotes,
      this.selectedServeType,
      this.dynamicRuntimeRemoteFields,
      this.dynamicFlagFields,
      this.isPopulatingForm,
      () => this.loadServeFields(),
      (type: string) => this.loadRuntimeRemoteFields(type),
      (type: SharedProfileType, name: string) => this.selectLinkedProfile(type, name),
      this.getUniqueControlKey
    );
  }

  async selectLinkedProfile(type: SharedProfileType, name: string): Promise<void> {
    const list = this.profileNamesMap()[type] || [];
    const actualName = list.includes(name) ? name : list[0] || DEFAULT_PROFILE_NAME;
    this.selectedProfileName.update(prev => ({ ...prev, [type]: actualName }));

    const config = this.profiles()[type]?.[actualName] as Record<string, unknown>;
    if (config) {
      await this.formBuilder.populateProfileForm(
        type,
        config,
        this.remoteConfigForm,
        this.remoteForm,
        this.currentRemoteName(),
        this.existingRemotes,
        this.selectedServeType,
        this.dynamicRuntimeRemoteFields,
        this.dynamicFlagFields,
        this.isPopulatingForm,
        () => this.loadServeFields(),
        (type: string) => this.loadRuntimeRemoteFields(type),
        (type: SharedProfileType, name: string) => this.selectLinkedProfile(type, name),
        this.getUniqueControlKey
      );
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
    this.profileManager.updateProfileConfig(t, currentName, cleaned);
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
    this.selectedServeType.set(type);
    this.remoteConfigForm.get('serveConfig.type')?.setValue(type, { emitEvent: false });
    await this.loadServeFields();
  }

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
    this.formBuilder.replaceDynamicFormControls(this.remoteForm, this.dynamicRemoteFields());
  }

  onRemoteFieldChanged(fieldName: string, isChanged: boolean): void {
    if (this.isPopulatingForm()) return;
    if (isChanged || this.editTarget() === 'remote') {
      this.changedRemoteFields.add(fieldName);
    } else {
      this.changedRemoteFields.delete(fieldName);
    }
  }

  // ── Configuration Builders ──
  buildProfileConfig(
    type: SharedProfileType,
    remoteName: string,
    configData: Record<string, unknown>
  ): Record<string, unknown> {
    return this.formBuilder.buildProfileConfig(
      type,
      remoteName,
      configData,
      this.profileOptions().runtimeRemote,
      this.dynamicFlagFields(),
      this.dynamicRuntimeRemoteFields(),
      this.dynamicServeFields(),
      this.getUniqueControlKey
    );
  }

  cleanFormData(formData: Record<string, unknown>): PendingRemoteData {
    return this.formBuilder.cleanFormData(
      formData,
      this.dynamicRemoteFields(),
      this.changedRemoteFields
    );
  }

  toggleCliImportVisibility(): void {
    if (this.currentStep() === 1 && !this.editTarget()) return;
    this.showCliImport.update(v => !v);
  }

  highlightField(key: string, flagType: SharedProfileType, profileName: string): void {
    this.profileManager.highlightField(key, flagType, profileName);
  }

  async applyImportResult(event: {
    result: ImportResult;
    profileName: string;
    isNew: boolean;
  }): Promise<void> {
    const { result, profileName, isNew } = event;
    const t = (result.verb || this.editTarget() || 'sync') as SharedProfileType;

    if (isNew) {
      this.profileManager.profiles.update(p => ({
        ...p,
        [t]: { ...p[t], [profileName]: {} },
      }));
    }

    await this.selectProfile(t, profileName);

    await this.cliImporter.applyImportResult(event, {
      remoteConfigForm: this.remoteConfigForm,
      currentRemoteName: this.currentRemoteName(),
      existingRemotes: this.existingRemotes(),
      stepConfigs: this.stepConfigs(),
      dynamicRuntimeRemoteFields: this.dynamicRuntimeRemoteFields(),
      dynamicFlagFields: this.dynamicFlagFields(),
      editTarget: this.editTarget,
      currentStep: this.currentStep,
      showCliImport: this.showCliImport,
      dirtyProfileTypes: this.dirtyProfileTypes,
      profileManager: this.profileManager,
      setProfileMode: (type, mode) => this.setProfileMode(type, mode),
      onServeTypeChange: type => this.onServeTypeChange(type),
      getUniqueControlKey: this.getUniqueControlKey,
      selectLinkedProfileFn: (type, name) => this.selectLinkedProfile(type, name),
    });

    this.dirtyProfileTypes.forEach(flagType => {
      this.saveCurrentProfile(flagType);
    });
  }

  private async populateFormIfEditingOrCloning(): Promise<void> {
    await this.formBuilder.populateFormIfEditingOrCloning(
      this.dialogData,
      this.editTarget,
      this.cloneTarget,
      this.remoteForm,
      this.remoteConfigForm,
      this.existingRemotes,
      this.selectedProfileName,
      this.profiles,
      this.selectedServeType,
      this.dynamicRuntimeRemoteFields,
      this.dynamicFlagFields,
      this.isPopulatingForm,
      () => this.syncRuntimeRemoteType(),
      () => this.loadServeFields(),
      type => this.loadRuntimeRemoteFields(type),
      (type, name) => this.selectLinkedProfile(type, name),
      this.getUniqueControlKey,
      () => this.onRemoteTypeChange()
    );
  }
}
