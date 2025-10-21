import {
  Component,
  ElementRef,
  HostListener,
  inject,
  OnDestroy,
  OnInit,
  ViewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  FormBuilder,
  FormGroup,
  ValidatorFn,
  Validators,
  FormsModule,
  FormControl,
} from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatChipsModule } from '@angular/material/chips';
import { MatIconModule } from '@angular/material/icon';
import { debounceTime, distinctUntilChanged, Subscription } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { RemoteConfigStepComponent } from '../../../../shared/remote-config/components/remote-config-step/remote-config-step.component';
import { FlagConfigStepComponent } from '../../../../shared/remote-config/components/flag-config-step/flag-config-step.component';
import {
  EditTarget,
  FieldType,
  FlagField,
  FlagType,
  REMOTE_NAME_REGEX,
  RemoteType,
} from '../../../../shared/remote-config/remote-config-types';
import { RcConfigQuestionResponse } from '@app/services';
import { InteractiveConfigStepComponent } from '../../../../shared/remote-config/components/interactive-config-step/interactive-config-step.component';

// Services
import { AnimationsService } from '../../../../shared/services/animations.service';
import { AuthStateService } from '../../../../shared/services/auth-state.service';
import { ValidatorRegistryService } from '../../../../shared/services/validator-registry.service';
import { FlagConfigService } from '@app/services';
import { PathSelectionService } from '@app/services';
import { RemoteManagementService } from '@app/services';
import { JobManagementService } from '@app/services';
import { MountManagementService } from '@app/services';
import { AppSettingsService } from '@app/services';
import { FileSystemService } from '@app/services';
import { UiStateService } from '@app/services';
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
  RemoteField,
} from '@app/types';
import { MatTooltipModule } from '@angular/material/tooltip';

@Component({
  selector: 'app-remote-config-modal',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatProgressSpinnerModule,
    MatInputModule,
    MatChipsModule,
    MatTooltipModule,
    MatIconModule,
    MatButtonModule,
    MatFormFieldModule,
    MatSelectModule,
    MatSlideToggleModule,
    RemoteConfigStepComponent,
    FlagConfigStepComponent,
    InteractiveConfigStepComponent,
  ],
  templateUrl: './remote-config-modal.component.html',
  styleUrls: ['./remote-config-modal.component.scss', '../../../../styles/_shared-modal.scss'],
  animations: [
    AnimationsService.getAnimations([
      'slideAnimation',
      'fadeInOutWithMove',
      'fadeInOut',
      'labelSlideIn',
    ]),
  ],
})
export class RemoteConfigModalComponent implements OnInit, OnDestroy {
  @ViewChild('jsonArea') jsonArea!: ElementRef<HTMLTextAreaElement>;
  fb = inject(FormBuilder);
  dialogRef = inject(MatDialogRef<RemoteConfigModalComponent>);
  flagConfigService = inject(FlagConfigService);
  pathSelectionService = inject(PathSelectionService);
  authStateService = inject(AuthStateService);
  remoteManagementService = inject(RemoteManagementService);
  jobManagementService = inject(JobManagementService);
  mountManagementService = inject(MountManagementService);
  appSettingsService = inject(AppSettingsService);
  fileSystemService = inject(FileSystemService);
  uiStateService = inject(UiStateService);
  validatorRegistry = inject(ValidatorRegistryService);
  data = inject(MAT_DIALOG_DATA) as {
    editTarget?: EditTarget;
    cloneTarget?: boolean;
    existingConfig?: Record<string, unknown>;
    name?: string;
    restrictMode: boolean;
  };

  public readonly TOTAL_STEPS = 9;

  currentStep = 1;
  editTarget: EditTarget = null;
  showAdvancedOptions = false;
  useInteractiveMode = false; // Add this property to track interactive mode state
  restrictMode!: boolean;
  cloneTarget!: boolean;

  remoteForm: FormGroup;
  remoteConfigForm: FormGroup;

  remoteTypes: RemoteType[] = [];
  dynamicRemoteFields: RcConfigOption[] = [];
  existingRemotes: string[] = [];
  mountTypes: string[] = [];

  dynamicFlagFields: Record<FlagType, FlagField[]> = {
    mount: [],
    copy: [],
    sync: [],
    filter: [],
    vfs: [],
    bisync: [],
    move: [],
    backend: [],
  };

  selectedOptions: Record<FlagType, Record<string, any>> = {
    mount: {},
    copy: {},
    sync: {},
    filter: {},
    vfs: {},
    bisync: {},
    move: {},
    backend: {},
  };

  // Simplified state management
  isRemoteConfigLoading = false;
  isAuthInProgress = false;
  isAuthCancelled = false;
  isProcessing = false;

  // Non-interactive RC flow state
  rcQuestion: RcConfigQuestionResponse | null = null;
  rcAnswer: string | boolean | number | null = null;
  isInteractiveActive = false;
  private pendingFinalConfig: {
    mountConfig: MountConfig;
    copyConfig: CopyConfig;
    syncConfig: SyncConfig;
    bisyncConfig: BisyncConfig;
    moveConfig: MoveConfig;
    filterConfig: FilterConfig;
    backendConfig: BackendConfig;
    vfsConfig: VfsConfig;
  } | null = null;
  private pendingRemoteData: { name: string; type: string; [k: string]: unknown } | null = null;

  private subscriptions: Subscription[] = [];

  constructor() {
    this.editTarget = this.data?.editTarget || null;
    this.cloneTarget = this.data?.cloneTarget || false;
    console.log(this.editTarget, this.cloneTarget);
    this.restrictMode = this.data?.restrictMode;
    this.remoteForm = this.createRemoteForm();
    this.remoteConfigForm = this.createRemoteConfigForm();
  }

  async ngOnInit(): Promise<void> {
    await this.initializeComponent();
    this.setupFormListeners();
    this.mountTypes = await this.mountManagementService.getMountTypes();
    console.log('Mount types loaded:', this.mountTypes);
    this.setupAuthStateListeners();
    if (this.editTarget === 'mount') {
      await this.pathSelectionService.fetchEntriesForField(
        'mountConfig.source',
        this.data?.name ?? '',
        typeof this.data?.existingConfig?.['source'] === 'string'
          ? this.data.existingConfig['source']
          : ''
      );
    } else if (this.editTarget === 'copy') {
      await this.pathSelectionService.fetchEntriesForField(
        'copyConfig.source',
        this.data?.name ?? '',
        typeof this.data?.existingConfig?.['source'] === 'string'
          ? this.data.existingConfig['source']
          : ''
      );
    } else if (this.editTarget === 'sync') {
      await this.pathSelectionService.fetchEntriesForField(
        'syncConfig.source',
        this.data?.name ?? '',
        typeof this.data?.existingConfig?.['source'] === 'string'
          ? this.data.existingConfig['source']
          : ''
      );
    } else if (this.editTarget === 'bisync') {
      await this.pathSelectionService.fetchEntriesForField(
        'bisyncConfig.source',
        this.data?.name ?? '',
        typeof this.data?.existingConfig?.['source'] === 'string'
          ? this.data.existingConfig['source']
          : ''
      );
    } else if (this.editTarget === 'move') {
      await this.pathSelectionService.fetchEntriesForField(
        'moveConfig.source',
        this.data?.name ?? '',
        typeof this.data?.existingConfig?.['source'] === 'string'
          ? this.data.existingConfig['source']
          : ''
      );
    }
    const subs = [
      this.remoteConfigForm
        .get('mountConfig.source')
        ?.valueChanges.pipe(debounceTime(300), distinctUntilChanged())
        .subscribe(value =>
          this.pathSelectionService.onInputChanged('mountConfig.source', value ?? '')
        ),
      this.remoteConfigForm
        .get('copyConfig.source')
        ?.valueChanges.pipe(debounceTime(300), distinctUntilChanged())
        .subscribe(value =>
          this.pathSelectionService.onInputChanged('copyConfig.source', value ?? '')
        ),
      this.remoteConfigForm
        .get('syncConfig.source')
        ?.valueChanges.pipe(debounceTime(300), distinctUntilChanged())
        .subscribe(value =>
          this.pathSelectionService.onInputChanged('syncConfig.source', value ?? '')
        ),
      this.remoteConfigForm
        .get('copyConfig.dest')
        ?.valueChanges.pipe(debounceTime(300), distinctUntilChanged())
        .subscribe(value =>
          this.pathSelectionService.onInputChanged('copyConfig.dest', value ?? '')
        ),
      this.remoteConfigForm
        .get('syncConfig.dest')
        ?.valueChanges.pipe(debounceTime(300), distinctUntilChanged())
        .subscribe(value =>
          this.pathSelectionService.onInputChanged('syncConfig.dest', value ?? '')
        ),
      this.remoteConfigForm
        .get('bisyncConfig.dest')
        ?.valueChanges.pipe(debounceTime(300), distinctUntilChanged())
        .subscribe(value =>
          this.pathSelectionService.onInputChanged('bisyncConfig.dest', value ?? '')
        ),
      this.remoteConfigForm
        .get('moveConfig.dest')
        ?.valueChanges.pipe(debounceTime(300), distinctUntilChanged())
        .subscribe(value =>
          this.pathSelectionService.onInputChanged('moveConfig.dest', value ?? '')
        ),
    ].filter((sub): sub is Subscription => !!sub);
    this.subscriptions.push(...subs);
  }

  stepLabels: string[] = [
    'Remote Config',
    'Mount',
    'Copy',
    'Sync',
    'Bisync',
    'Move',
    'Filter',
    'VFS',
    'Backend',
  ];

  // =============================================
  // ADD THESE METHODS
  // =============================================

  /**
   * Get current step label for display
   */
  getCurrentStepLabel(): string {
    if (this.currentStep === 1) {
      return 'Remote Configuration';
    }

    const stepIndex = this.currentStep - 2;
    if (stepIndex >= 0 && stepIndex < this.flagConfigService.FLAG_TYPES.length) {
      return (
        this.flagConfigService.FLAG_TYPES[stepIndex].charAt(0).toUpperCase() +
        this.flagConfigService.FLAG_TYPES[stepIndex].slice(1) +
        ' Configuration'
      );
    }

    return '';
  }

  /**
   * Navigate to a specific step (used when clicking step indicators in edit mode)
   */
  goToStep(step: number): void {
    if (step >= 1 && step <= this.TOTAL_STEPS) {
      this.currentStep = step;
    }
  }

  /**
   * Get step information for accessibility
   */
  getStepProgress(): { current: number; total: number; percentage: number } {
    return {
      current: this.currentStep,
      total: this.TOTAL_STEPS,
      percentage: Math.round((this.currentStep / this.TOTAL_STEPS) * 100),
    };
  }

  /**
   * Get visual state for current step
   */
  getStepState(stepNumber: number): 'completed' | 'current' | 'future' {
    if (stepNumber < this.currentStep) {
      return 'completed';
    } else if (stepNumber === this.currentStep) {
      return 'current';
    } else {
      return 'future';
    }
  }

  getStepIcon(stepIndex: number): string {
    const iconMap: Record<number, string> = {
      0: 'hard-drive', // Remote Config
      1: 'mount', // Mount
      2: 'copy', // Copy
      3: 'sync', // Sync
      4: 'right-left', // Bisync (bidirectional sync)
      5: 'move', // Move
      6: 'filter', // Filter
      7: 'vfs', // VFS (Virtual File System)
      8: 'server', // Backend
    };

    return iconMap[stepIndex] || 'circle';
  }

  getStepProgressAriaLabel(): string {
    return `Step ${this.currentStep} of ${this.TOTAL_STEPS}: ${this.stepLabels[this.currentStep - 1]}`;
  }

  /**
   * Handle keyboard navigation for step indicators
   */
  handleStepKeydown(event: KeyboardEvent, stepNumber: number): void {
    if (!this.editTarget) return;

    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        if (stepNumber < this.TOTAL_STEPS) {
          this.goToStep(stepNumber + 1);
        }
        break;
      case 'ArrowLeft':
        event.preventDefault();
        if (stepNumber > 1) {
          this.goToStep(stepNumber - 1);
        }
        break;
      case 'Home':
        event.preventDefault();
        this.goToStep(1);
        break;
      case 'End':
        event.preventDefault();
        this.goToStep(this.TOTAL_STEPS);
        break;
    }
  }

  ngOnDestroy(): void {
    this.cleanupSubscriptions();
    this.authStateService.cancelAuth();
  }

  private async initializeComponent(): Promise<void> {
    await this.loadExistingRemotes();
    if (this.data?.existingConfig) {
      this.populateForm(this.data.existingConfig);
    }
    this.loadRemoteTypes();
    this.dynamicFlagFields = await this.flagConfigService.loadAllFlagFields();

    // Make move and bisync use the same flags as copy
    this.dynamicFlagFields.move = this.dynamicFlagFields.copy;
    this.dynamicFlagFields.bisync = this.dynamicFlagFields.copy;
  }

  // Remote Config Service
  private async loadRemoteTypes(): Promise<void> {
    this.remoteTypes = await this.getRemoteTypes();
  }

  async onRemoteTypeChange(): Promise<void> {
    this.isRemoteConfigLoading = true;
    try {
      const remoteType = this.remoteForm.get('type')?.value;

      this.useInteractiveMode = ['iclouddrive', 'onedrive'].includes(remoteType?.toLowerCase());
      const response = await this.remoteManagementService.getRemoteConfigFields(remoteType);

      // 1. Clear out old dynamic fields from the form
      Object.keys(this.remoteForm.controls).forEach(key => {
        if (key !== 'name' && key !== 'type') {
          this.remoteForm.removeControl(key);
        }
      });

      this.dynamicRemoteFields = this.mapRemoteFields(response);

      this.dynamicRemoteFields.forEach(field => {
        this.remoteForm.addControl(field.Name, new FormControl(field.Value));
      });
    } catch (error) {
      console.error('Error loading remote config fields:', error);
    } finally {
      this.isRemoteConfigLoading = false;
    }
  }

  onInteractiveModeToggled(useInteractiveMode: boolean): void {
    this.useInteractiveMode = useInteractiveMode;
  }

  async getRemoteTypes(): Promise<RemoteType[]> {
    try {
      const providers = await this.remoteManagementService.getRemoteTypes();
      return providers.map(provider => ({
        value: provider.name,
        label: provider.description,
      }));
    } catch (error) {
      console.error('Error fetching remote types:', error);
      throw error;
    }
  }

  mapRemoteFields(remoteOptions: any[]): RemoteField[] {
    return remoteOptions.map(field => ({
      Name: field.Name,
      FieldName: field.Name, // Use Name as the display field name
      Help: field.Help,
      Default: { Value: field.Default, Valid: true },
      Value: field.Value,
      Hide: field.Hide,
      Required: field.Required,
      IsPassword: field.IsPassword,
      NoPrefix: field.NoPrefix,
      Advanced: field.Advanced,
      Exclusive: field.Exclusive,
      Sensitive: field.Sensitive,
      DefaultStr: field.DefaultStr,
      ValueStr: field.ValueStr,
      Type: field.Type === 'CommaSepList' ? 'stringArray' : field.Type,
      Examples: field.Examples || [],
    }));
  }

  private setupAuthStateListeners(): void {
    this.subscriptions.push(
      this.authStateService.isAuthInProgress$.subscribe(isInProgress => {
        this.isAuthInProgress = isInProgress;
        this.setFormState(isInProgress);
      })
    );
    this.subscriptions.push(
      this.authStateService.isAuthCancelled$.subscribe(isCancelled => {
        this.isAuthCancelled = isCancelled;
      })
    );
  }

  private setupFormListeners(): void {
    // Mount path required if autoStart is enabled
    this.remoteConfigForm.get('mountConfig.autoStart')?.valueChanges.subscribe(enabled => {
      const destCtrl = this.remoteConfigForm.get('mountConfig.dest');
      if (enabled) {
        destCtrl?.setValidators([
          Validators.required,
          this.validatorRegistry.getValidator('crossPlatformPath')!,
        ]);
      } else {
        destCtrl?.setValidators([this.validatorRegistry.getValidator('crossPlatformPath')!]);
      }
      destCtrl?.updateValueAndValidity();
    });

    // Copy source/dest required if autoStart is enabled
    this.remoteConfigForm.get('copyConfig.autoStart')?.valueChanges.subscribe(enabled => {
      const destCtrl = this.remoteConfigForm.get('copyConfig.dest');
      if (enabled) {
        destCtrl?.setValidators([Validators.required]);
      } else {
        destCtrl?.clearValidators();
      }
      destCtrl?.updateValueAndValidity();
    });

    // Sync source/dest required if autoStart is enabled
    this.remoteConfigForm.get('syncConfig.autoStart')?.valueChanges.subscribe(enabled => {
      const destCtrl = this.remoteConfigForm.get('syncConfig.dest');
      if (enabled) {
        destCtrl?.setValidators([Validators.required]);
      } else {
        destCtrl?.clearValidators();
      }
      destCtrl?.updateValueAndValidity();
    });

    // Bisync source/dest required if autoStart is enabled
    this.remoteConfigForm.get('bisyncConfig.autoStart')?.valueChanges.subscribe(enabled => {
      const destCtrl = this.remoteConfigForm.get('bisyncConfig.dest');
      if (enabled) {
        destCtrl?.setValidators([Validators.required]);
      } else {
        destCtrl?.clearValidators();
      }
      destCtrl?.updateValueAndValidity();
    });

    // Move source/dest required if autoStart is enabled
    this.remoteConfigForm.get('moveConfig.autoStart')?.valueChanges.subscribe(enabled => {
      const destCtrl = this.remoteConfigForm.get('moveConfig.dest');
      if (enabled) {
        destCtrl?.setValidators([Validators.required]);
      } else {
        destCtrl?.clearValidators();
      }
      destCtrl?.updateValueAndValidity();
    });
  }

  async onSourceOptionSelectedField(entryName: string, formPath: string): Promise<void> {
    const control = this.remoteConfigForm.get(formPath);
    await this.pathSelectionService.onPathSelected(formPath, entryName, control);
  }

  async onDestOptionSelectedField(entryName: string, formPath: string): Promise<void> {
    const control = this.remoteConfigForm.get(formPath);
    await this.pathSelectionService.onPathSelected(formPath, entryName, control);
  }

  async onRemoteSelected(remoteWithColon: string, formPath: string): Promise<void> {
    const control = this.remoteConfigForm.get(formPath);
    await this.pathSelectionService.onRemoteSelected(formPath, remoteWithColon, control);
  }

  async onRemoteSelectedField(remoteWithColon: string, formPath: string): Promise<void> {
    const control = this.remoteConfigForm.get(formPath);
    await this.pathSelectionService.onRemoteSelected(formPath, remoteWithColon, control);
  }

  resetRemoteSelectionField(formPath: string): void {
    this.pathSelectionService.resetPathSelection(formPath);
    this.remoteConfigForm.get(formPath)?.setValue('');
  }

  private cleanupSubscriptions(): void {
    this.subscriptions.forEach(sub => sub.unsubscribe());
    this.subscriptions = [];
  }

  private createRemoteForm(): FormGroup {
    const isEditMode = this.editTarget === 'remote' && !!this.data?.existingConfig;
    const form = this.fb.group({
      name: [
        { value: '', disabled: isEditMode },
        [Validators.required, this.validateRemoteNameFactory()],
      ],
      type: [{ value: '', disabled: isEditMode }, [Validators.required]],
      // Removed interactiveMode as it's now a component property, not form data
    });
    return form;
  }

  private createRemoteConfigForm(): FormGroup {
    return this.fb.group({
      mountConfig: this.fb.group({
        autoStart: [],
        // dest: ['', [this.validatorRegistry.getValidator('crossPlatformPath')!]],
        dest: [],
        source: [],
        type: [],
        options: ['{}', [this.validatorRegistry.getValidator('json')!]],
      }),
      copyConfig: this.fb.group({
        autoStart: [],
        source: [],
        dest: [],
        createEmptySrcDirs: [],
        options: ['{}', [this.validatorRegistry.getValidator('json')!]],
      }),
      syncConfig: this.fb.group({
        autoStart: [],
        source: [],
        dest: [],
        createEmptySrcDirs: [],
        options: ['{}', [this.validatorRegistry.getValidator('json')!]],
      }),
      bisyncConfig: this.fb.group({
        autoStart: [],
        source: [],
        dest: [],
        dryRun: [],
        resync: [],
        checkAccess: [],
        checkFilename: [],
        maxDelete: [],
        force: [],
        checkSync: [],
        createEmptySrcDirs: [],
        removeEmptyDirs: [],
        filtersFile: [],
        ignoreListingChecksum: [],
        resilient: [],
        workdir: [],
        backupdir1: [],
        backupdir2: [],
        noCleanup: [],
        options: ['{}', [this.validatorRegistry.getValidator('json')!]],
      }),
      moveConfig: this.fb.group({
        autoStart: [],
        source: [],
        dest: [],
        createEmptySrcDirs: [],
        deleteEmptySrcDirs: [],
        options: ['{}', [this.validatorRegistry.getValidator('json')!]],
      }),
      filterConfig: this.fb.group({
        options: ['{}', [this.validatorRegistry.getValidator('json')!]],
      }),
      vfsConfig: this.fb.group({
        options: ['{}', [this.validatorRegistry.getValidator('json')!]],
      }),
      backendConfig: this.fb.group({
        options: ['{}', [this.validatorRegistry.getValidator('json')!]],
      }),
    });
  }

  //#region Remote Configuration Methods
  private async loadExistingRemotes(): Promise<void> {
    try {
      this.existingRemotes = await this.remoteManagementService.getRemotes();
    } catch (error) {
      console.error('Error loading existing remotes:', error);
    }
  }
  //#endregion

  //#region Flag Configuration Methods
  toggleOption(flagType: FlagType, field: FlagField): void {
    this.selectedOptions[flagType] = this.flagConfigService.toggleOption(
      this.selectedOptions[flagType],
      this.dynamicFlagFields[flagType],
      field.name
    );
    this.updateJsonDisplay(flagType);
  }

  private updateJsonDisplay(flagType: FlagType): void {
    const configGroup = this.remoteConfigForm.get(`${flagType}Config`) as FormGroup;
    const optionsControl = configGroup?.get('options');
    if (!optionsControl) return;

    const jsonStr = JSON.stringify(this.selectedOptions[flagType], null, 2);
    optionsControl.setValue(jsonStr);
  }

  validateJson(flagType: FlagType): void {
    const configGroup = this.remoteConfigForm.get(`${flagType}Config`) as FormGroup;
    const optionsControl = configGroup?.get('options');
    if (!optionsControl) return;

    const validation = this.flagConfigService.validateFlagOptions(
      optionsControl.value || '{}',
      this.dynamicFlagFields[flagType]
    );

    if (validation.valid && validation.cleanedOptions) {
      this.selectedOptions[flagType] = validation.cleanedOptions;
      optionsControl.setErrors(null);
    } else {
      optionsControl.setErrors({ invalidJson: true });
    }
  }

  resetJson(flagType: FlagType): void {
    const configGroup = this.remoteConfigForm.get(`${flagType}Config`) as FormGroup;
    if (!configGroup) return;

    const optionsControl = configGroup.get('options');
    if (!optionsControl) return;

    optionsControl.setValue('{}');
    this.selectedOptions[flagType] = {};
  }
  //#endregion

  //#region Form Population Methods
  populateForm(config: any): void {
    if (!this.editTarget && !this.cloneTarget) return;
    if (this.editTarget === 'remote') {
      this.populateRemoteForm(config);
    } else if (this.cloneTarget) {
      this.populateRemoteForm(config.remoteSpecs);
      this.populateFlagBasedForm('mount', config.mountConfig || {});
      this.populateFlagBasedForm('copy', config.copyConfig || {});
      this.populateFlagBasedForm('sync', config.syncConfig || {});
      this.populateFlagBasedForm('bisync', config.bisyncConfig || {});
      this.populateFlagBasedForm('move', config.moveConfig || {});
      this.populateFlagForm('filter', config.filterConfig || {});
      this.populateFlagForm('vfs', config.vfsConfig || {});
      this.populateFlagForm('backend', config.backendConfig || {});
    } else {
      switch (this.editTarget) {
        case 'mount':
        case 'copy':
        case 'sync':
        case 'bisync':
        case 'move':
          this.populateFlagBasedForm(this.editTarget, config);
          break;
        case 'filter':
        case 'vfs':
        case 'backend':
          this.populateFlagForm(this.editTarget, config);
          break;
      }
    }
  }

  private async populateRemoteForm(config: any): Promise<void> {
    this.remoteForm.patchValue({
      name: config.name,
      type: config.type,
    });
    await this.onRemoteTypeChange();
    this.dynamicRemoteFields.forEach(field => {
      if (config[field.Name] !== undefined) {
        // Convert string boolean values to actual booleans for boolean fields
        let value = config[field.Name];
        if (field.Type === 'bool') {
          value = this.convertToBoolean(value);
        }
        this.remoteForm.get(field.Name)?.setValue(value);
      } else if (field.Value !== null) {
        // Also convert default values for boolean fields
        let value = field.Value;
        if (field.Type === 'bool') {
          value = this.convertToBoolean(value);
        }
        this.remoteForm.get(field.Name)?.setValue(value);
      }
    });
  }

  private populateFlagBasedForm(flagType: FlagType, config: any): void {
    let source = config.source || '';
    if (!source || source.trim() === '') {
      source = `${this.getRemoteName()}:/`;
    }

    const baseConfig = {
      autoStart: config.autoStart ?? false,
      source: source,
      dest: config.dest || '',
      options: JSON.stringify(config.options || {}, null, 2),
    };

    // Add specific fields based on flagType
    let specificConfig = {};

    switch (flagType) {
      case 'mount':
        specificConfig = {
          type: config.type || '',
        };
        break;
      case 'copy':
      case 'sync':
        specificConfig = {
          createEmptySrcDirs: config.createEmptySrcDirs,
        };
        break;
      case 'move':
        specificConfig = {
          createEmptySrcDirs: config.createEmptySrcDirs,
          deleteEmptySrcDirs: config.deleteEmptySrcDirs,
        };
        break;
      case 'bisync':
        specificConfig = {
          dryRun: config.dryRun,
          resync: config.resync,
          checkAccess: config.checkAccess,
          checkFilename: config.checkFilename,
          maxDelete: config.maxDelete,
          force: config.force,
          checkSync: config.checkSync,
          createEmptySrcDirs: config.createEmptySrcDirs,
          removeEmptyDirs: config.removeEmptyDirs,
          filtersFile: config.filtersFile,
          ignoreListingChecksum: config.ignoreListingChecksum,
          resilient: config.resilient,
          workdir: config.workdir,
          backupdir1: config.backupdir1,
          backupdir2: config.backupdir2,
          noCleanup: config.noCleanup,
        };
        break;
    }

    this.remoteConfigForm.patchValue({
      [`${flagType}Config`]: {
        ...baseConfig,
        ...specificConfig,
      },
    });
    this.syncSelectedOptionsFromJson(flagType);
  }

  private populateFlagForm(flagType: FlagType, config: any): void {
    const configGroup = this.remoteConfigForm.get(`${flagType}Config`) as FormGroup;
    if (!configGroup) return;
    const optionsControl = configGroup.get('options');
    if (!optionsControl) return;
    optionsControl.setValue(JSON.stringify(config, null, 2));
    this.syncSelectedOptionsFromJson(flagType);
  }

  private syncSelectedOptionsFromJson(flagType: FlagType): void {
    const configGroup = this.remoteConfigForm.get(`${flagType}Config`) as FormGroup;
    if (!configGroup) return;
    const optionsControl = configGroup.get('options');
    if (!optionsControl) return;
    try {
      const parsed = this.safeJsonParse(optionsControl.value || '{}');
      this.selectedOptions[flagType] = { ...parsed };
    } catch {
      this.selectedOptions[flagType] = {};
    }
    this.updateJsonDisplay(flagType);
  }
  //#endregion

  //#region Form Submission Methods
  async onSubmit(): Promise<void> {
    if (this.isAuthInProgress) return;

    try {
      const result = this.editTarget ? await this.handleEditMode() : await this.handleCreateMode();

      if (result.success && !this.isAuthCancelled) {
        this.close();
      }
    } catch (error) {
      console.error('Error during submission:', error);
    } finally {
      this.authStateService.resetAuthState();
    }
  }

  private setFormState(disabled: boolean): void {
    if (disabled) {
      this.remoteConfigForm.disable();
      this.remoteForm.disable();

      // Additionally disable all 'options' form controls specifically
      this.flagConfigService.FLAG_TYPES.forEach(() => {
        const optionsControl = this.remoteConfigForm.get(`options`);
        if (optionsControl) {
          optionsControl.disable();
        }
      });
    } else {
      // Only enable controls that should be editable
      if (this.editTarget === 'remote') {
        // In remote edit mode, keep 'name' and 'type' disabled
        Object.keys(this.remoteForm.controls).forEach(key => {
          if (['name', 'type'].includes(key)) {
            this.remoteForm.get(key)?.disable();
          } else {
            this.remoteForm.get(key)?.enable();
          }
        });
      } else {
        // In other modes, enable all controls
        this.remoteForm.enable();
      }
      this.remoteConfigForm.enable();

      // Re-enable 'options' form controls when not disabled
      this.flagConfigService.FLAG_TYPES.forEach(() => {
        const optionsControl = this.remoteConfigForm.get(`options`);
        if (optionsControl) {
          optionsControl.enable();
        }
      });
    }
  }

  private async handleEditMode(): Promise<{ success: boolean }> {
    const updatedConfig: any = {};
    const remoteName = this.getRemoteName();

    await this.authStateService.startAuth(remoteName, true);

    // Check if this is a remote edit with interactive mode
    if (this.editTarget === 'remote' && this.useInteractiveMode) {
      return await this.handleInteractiveRemoteEdit(updatedConfig);
    }

    await this.updateConfigBasedOnEditTarget(updatedConfig);
    await this.appSettingsService.saveRemoteSettings(remoteName, updatedConfig);

    return { success: true };
  }

  private async handleInteractiveRemoteEdit(updatedConfig: any): Promise<{ success: boolean }> {
    const remoteData = this.cleanFormData(this.remoteForm.getRawValue(), true, this.remoteForm);

    // Store the updated config for later use
    updatedConfig.name = remoteData.name;
    updatedConfig.type = remoteData.type;

    // Store config for finalization
    this.pendingFinalConfig = {
      ...updatedConfig,
      mountConfig: {},
      copyConfig: {},
      syncConfig: {},
      bisyncConfig: {},
      moveConfig: {},
      filterConfig: {},
      vfsConfig: {},
      backendConfig: {},
    };
    this.pendingRemoteData = remoteData;

    // Start interactive configuration for the remote
    const { name, type, ...paramRest } = remoteData;
    const startResp = await this.remoteManagementService.startRemoteConfigInteractive(
      name,
      type,
      paramRest,
      { nonInteractive: true }
    );

    if (!startResp || startResp.State === '') {
      return { success: true };
    }

    // Interactive steps needed
    this.isInteractiveActive = true;
    this.rcQuestion = startResp;
    this.rcAnswer = this.getDefaultAnswerFromQuestion(startResp);
    return { success: false };
  }

  private getRemoteName(): string {
    return this.data.name || this.remoteForm.get('name')?.value;
  }

  private async updateConfigBasedOnEditTarget(updatedConfig: any): Promise<void> {
    if (!this.editTarget) return;

    const updateHandlers = {
      remote: this.handleRemoteUpdate.bind(this),
      mount: this.handleMountUpdate.bind(this),
      bisync: this.handleBisyncUpdate.bind(this),
      move: this.handleMoveUpdate.bind(this),
      copy: this.handleCopyUpdate.bind(this),
      sync: this.handleSyncUpdate.bind(this),
      filter: this.handleFlagUpdate.bind(this),
      backend: this.handleFlagUpdate.bind(this),
      vfs: this.handleFlagUpdate.bind(this),
    } as const;

    if (this.editTarget && updateHandlers[this.editTarget]) {
      await updateHandlers[this.editTarget](updatedConfig);
    }
  }

  private async handleCreateMode(): Promise<{ success: boolean }> {
    const remoteData = this.cleanFormData(this.remoteForm.getRawValue());
    const configData = this.cleanFormData(this.remoteConfigForm.getRawValue());

    const finalConfig = {
      mountConfig: {
        autoStart: configData.mountConfig.autoStart,
        dest: configData.mountConfig.dest,
        source: configData.mountConfig.source || `${remoteData.name}:/`,
        type: configData.mountConfig.type,
        options: {
          ...this.safeJsonParse(configData.mountConfig.options),
        },
      },
      copyConfig: {
        autoStart: configData.copyConfig.autoStart,
        source: configData.copyConfig.source || `${remoteData.name}:/`,
        dest: configData.copyConfig.dest,
        createEmptySrcDirs: configData.copyConfig.createEmptySrcDirs,
        options: {
          ...this.safeJsonParse(configData.copyConfig.options),
        },
      },
      syncConfig: {
        autoStart: configData.syncConfig.autoStart,
        source: configData.syncConfig.source || `${remoteData.name}:/`,
        dest: configData.syncConfig.dest,
        createEmptySrcDirs: configData.syncConfig.createEmptySrcDirs,
        options: {
          ...this.safeJsonParse(configData.syncConfig.options),
        },
      },
      bisyncConfig: {
        autoStart: configData.bisyncConfig.autoStart,
        source: configData.bisyncConfig.source || `${remoteData.name}:/`,
        dest: configData.bisyncConfig.dest,
        dryRun: configData.bisyncConfig.dryRun,
        resync: configData.bisyncConfig.resync,
        checkAccess: configData.bisyncConfig.checkAccess,
        checkFilename: configData.bisyncConfig.checkFilename,
        maxDelete: configData.bisyncConfig.maxDelete,
        force: configData.bisyncConfig.force,
        checkSync: configData.bisyncConfig.checkSync,
        createEmptySrcDirs: configData.bisyncConfig.createEmptySrcDirs,
        removeEmptyDirs: configData.bisyncConfig.removeEmptyDirs,
        filtersFile: configData.bisyncConfig.filtersFile,
        ignoreListingChecksum: configData.bisyncConfig.ignoreListingChecksum,
        resilient: configData.bisyncConfig.resilient,
        workdir: configData.bisyncConfig.workdir,
        backupdir1: configData.bisyncConfig.backupdir1,
        backupdir2: configData.bisyncConfig.backupdir2,
        noCleanup: configData.bisyncConfig.noCleanup,
        options: {
          ...this.safeJsonParse(configData.bisyncConfig.options),
        },
      },
      moveConfig: {
        autoStart: configData.moveConfig.autoStart,
        source: configData.moveConfig.source || `${remoteData.name}:/`,
        dest: configData.moveConfig.dest,
        createEmptySrcDirs: configData.moveConfig.createEmptySrcDirs,
        deleteEmptySrcDirs: configData.moveConfig.deleteEmptySrcDirs,
        options: {
          ...this.safeJsonParse(configData.moveConfig.options),
        },
      },
      filterConfig: this.safeJsonParse(configData.filterConfig.options),
      vfsConfig: this.safeJsonParse(configData.vfsConfig.options),
      backendConfig: this.safeJsonParse(configData.backendConfig.options),
    };

    const interactive = this.useInteractiveMode; // Read from component property instead of form
    await this.authStateService.startAuth(remoteData.name, false);
    if (!interactive) {
      // Simple path: create the remote directly using provided fields
      const toCreate = { ...remoteData } as Record<string, unknown>;
      await this.remoteManagementService.createRemote(remoteData.name, toCreate);
      // Save settings and kick off any auto-actions
      this.pendingFinalConfig = finalConfig;
      this.pendingRemoteData = remoteData;
      await this.finalizeRemoteCreation();
      return { success: true };
    }

    // Interactive path: start non-interactive RC flow via rclone and guide user through Q/A
    this.pendingFinalConfig = finalConfig;
    this.pendingRemoteData = remoteData;

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
    this.isInteractiveActive = true;
    this.rcQuestion = startResp;
    this.rcAnswer = this.getDefaultAnswerFromQuestion(startResp);
    return { success: false };
  }

  private async handleRemoteUpdate(updatedConfig: any): Promise<void> {
    const remoteData = this.cleanFormData(this.remoteForm.getRawValue(), true, this.remoteForm);
    updatedConfig.name = remoteData.name;
    updatedConfig.type = remoteData.type;
    await this.remoteManagementService.updateRemote(remoteData.name, remoteData);
  }

  private async handleMountUpdate(updatedConfig: any): Promise<void> {
    const mountData = this.cleanFormData(
      this.remoteConfigForm.getRawValue().mountConfig,
      true,
      this.remoteConfigForm.get('mountConfig') as FormGroup
    );
    // If source is empty, set to remoteName:/
    if (!mountData.source || mountData.source.trim() === '') {
      const remoteName = this.getRemoteName();
      mountData.source = `${remoteName}:/`;
    }
    updatedConfig.mountConfig = {
      autoStart: mountData.autoStart,
      dest: mountData.dest,
      source: mountData.source,
      type: mountData.type,
      options: {
        ...this.safeJsonParse(mountData.options),
      },
    };
  }

  private async handleBisyncUpdate(updatedConfig: any): Promise<void> {
    const bisyncData = this.cleanFormData(
      this.remoteConfigForm.getRawValue().bisyncConfig,
      true,
      this.remoteConfigForm.get('bisyncConfig') as FormGroup
    );
    // If source is empty, set to remoteName:/
    if (!bisyncData.source || bisyncData.source.trim() === '') {
      const remoteName = this.getRemoteName();
      bisyncData.source = `${remoteName}:/`;
    }
    updatedConfig.bisyncConfig = {
      autoStart: bisyncData.autoStart,
      source: bisyncData.source,
      dest: bisyncData.dest,
      dryRun: bisyncData.dryRun,
      resync: bisyncData.resync,
      checkAccess: bisyncData.checkAccess,
      checkFilename: bisyncData.checkFilename,
      maxDelete: bisyncData.maxDelete,
      force: bisyncData.force,
      checkSync: bisyncData.checkSync,
      createEmptySrcDirs: bisyncData.createEmptySrcDirs,
      removeEmptyDirs: bisyncData.removeEmptyDirs,
      filtersFile: bisyncData.filtersFile,
      ignoreListingChecksum: bisyncData.ignoreListingChecksum,
      resilient: bisyncData.resilient,
      workdir: bisyncData.workdir,
      backupdir1: bisyncData.backupdir1,
      backupdir2: bisyncData.backupdir2,
      noCleanup: bisyncData.noCleanup,
      options: {
        ...this.safeJsonParse(bisyncData.options),
      },
    };
  }

  private async handleMoveUpdate(updatedConfig: any): Promise<void> {
    const moveData = this.cleanFormData(
      this.remoteConfigForm.getRawValue().moveConfig,
      true,
      this.remoteConfigForm.get('moveConfig') as FormGroup
    );
    // If source is empty, set to remoteName:/
    if (!moveData.source || moveData.source.trim() === '') {
      const remoteName = this.getRemoteName();
      moveData.source = `${remoteName}:/`;
    }
    updatedConfig.moveConfig = {
      autoStart: moveData.autoStart,
      source: moveData.source,
      dest: moveData.dest,
      createEmptySrcDirs: moveData.createEmptySrcDirs,
      deleteEmptySrcDirs: moveData.deleteEmptySrcDirs,
      options: {
        ...this.safeJsonParse(moveData.options),
      },
    };
  }

  private async handleCopyUpdate(updatedConfig: any): Promise<void> {
    const copyData = this.cleanFormData(
      this.remoteConfigForm.getRawValue().copyConfig,
      true,
      this.remoteConfigForm.get('copyConfig') as FormGroup
    );
    // If source is empty, set to remoteName:/
    if (!copyData.source || copyData.source.trim() === '') {
      const remoteName = this.getRemoteName();
      copyData.source = `${remoteName}:/`;
    }
    updatedConfig.copyConfig = {
      autoStart: copyData.autoStart,
      source: copyData.source,
      dest: copyData.dest,
      createEmptySrcDirs: copyData.createEmptySrcDirs,
      options: {
        ...this.safeJsonParse(copyData.options),
      },
    };
  }

  private async handleSyncUpdate(updatedConfig: any): Promise<void> {
    const syncData = this.cleanFormData(
      this.remoteConfigForm.getRawValue().syncConfig,
      true,
      this.remoteConfigForm.get('syncConfig') as FormGroup
    );
    // If source is empty, set to remoteName:/
    if (!syncData.source || syncData.source.trim() === '') {
      const remoteName = this.getRemoteName();
      syncData.source = `${remoteName}:/`;
    }
    updatedConfig.syncConfig = {
      autoStart: syncData.autoStart,
      source: syncData.source,
      dest: syncData.dest,
      createEmptySrcDirs: syncData.createEmptySrcDirs,
      options: {
        ...this.safeJsonParse(syncData.options),
      },
    };
  }

  private async handleFlagUpdate(updatedConfig: any): Promise<void> {
    if (
      !this.editTarget ||
      !this.flagConfigService.FLAG_TYPES.includes(this.editTarget as FlagType)
    ) {
      return;
    }

    const mountData = this.cleanFormData(
      this.remoteConfigForm.getRawValue(),
      true,
      this.remoteConfigForm
    );
    const jsonValue = mountData[`${this.editTarget}Config`].options || '{}';

    // Handle each flag type specifically
    switch (this.editTarget) {
      default:
        // For filter, vfs and backend, just use the JSON config
        updatedConfig[`${this.editTarget}Config`] = this.safeJsonParse(jsonValue);
        break;
    }
  }
  //#endregion

  //#region Utility Methods
  private validateRemoteNameFactory(): ValidatorFn {
    return this.validatorRegistry.createRemoteNameValidator(
      this.existingRemotes,
      REMOTE_NAME_REGEX
    );
  }

  /**
   * Clean form data by removing null/empty values and optionally default values.
   * In create mode: Filters out default values to avoid sending them to rcd (which doesn't know defaults)
   * In edit mode: Only filters out default values if the field hasn't been modified by the user
   */
  private cleanFormData(formData: any, isEditMode = false, formControl?: FormGroup): any {
    return Object.entries(formData)
      .filter(([key, value]) => {
        if (value === null || value === 0 || value === '0') {
          return false;
        }

        // In edit mode, include values that have been explicitly modified by the user
        if (isEditMode && formControl) {
          const control = formControl.get(key);
          if (control && control.dirty) {
            // Field has been modified by user, include it even if it matches default
            return true;
          }
        }

        // Skip if value matches default (for create mode or unmodified fields in edit mode)
        return !this.isDefaultValue(key, value);
      })
      .reduce((acc, [key, value]) => ({ ...acc, [key]: value }), {});
  }

  private isDefaultValue(fieldName: string, value: any): boolean {
    const field = this.dynamicRemoteFields.find(f => f.Name === fieldName);
    if (!field) return false;

    // Get the proper default value
    const defaultValue =
      field.Default !== undefined
        ? this.flagConfigService.coerceValueToType(field.Default, field.Type as FieldType)
        : this.flagConfigService.coerceValueToType(field.Value, field.Type as FieldType);

    // If value or defaultValue is an object or stringified object, compare as strings
    if (
      (typeof value === 'string' && value.startsWith('{') && value.endsWith('}')) ||
      typeof defaultValue === 'object'
    ) {
      try {
        // Parse both to objects for deep comparison
        const parsedValue = typeof value === 'string' ? JSON.parse(value) : value;
        const parsedDefault =
          typeof defaultValue === 'string' ? JSON.parse(defaultValue) : defaultValue;
        return JSON.stringify(parsedValue) === JSON.stringify(parsedDefault);
      } catch {
        // Fallback to string comparison if parsing fails
        return String(value) === String(defaultValue);
      }
    }

    // Special handling for arrays
    if (Array.isArray(value) && Array.isArray(defaultValue)) {
      return JSON.stringify(value.sort()) === JSON.stringify(defaultValue.sort());
    }

    // Fallback to simple comparison
    return JSON.stringify(value) === JSON.stringify(defaultValue);
  }

  private safeJsonParse(data: any): any {
    try {
      return data ? (typeof data === 'string' ? JSON.parse(data) : data) : {};
    } catch (error) {
      console.error('Failed to parse JSON:', data, error);
      return {};
    }
  }
  //#endregion

  //#region UI Helper Methods
  selectLocalFolder(whichFormPath: string, requireEmpty: boolean): void {
    this.fileSystemService.selectFolder(requireEmpty).then(selectedPath => {
      this.remoteConfigForm.get(whichFormPath)?.setValue(selectedPath);
    });
  }

  private scrollToTop(): void {
    const modalContent = document.querySelector('.modal-content');
    if (modalContent) {
      modalContent.scrollTop = 0;
    }
  }

  nextStep(): void {
    if (this.currentStep >= this.TOTAL_STEPS) {
      return;
    }

    // Validate current step before advancing
    if (this.currentStep === 1 && !this.remoteForm.valid) {
      // Show validation error
      this.remoteForm.markAllAsTouched();
      return;
    }

    if (this.currentStep > 1 && !this.remoteConfigForm.valid) {
      // Show validation error
      this.remoteConfigForm.markAllAsTouched();
      return;
    }

    this.currentStep++;
    this.scrollToTop();
  }

  prevStep(): void {
    if (this.currentStep > 1) {
      this.currentStep--;
      this.scrollToTop();
    }
  }

  async cancelAuth(): Promise<void> {
    await this.authStateService.cancelAuth();
    // Reset interactive mode state when cancelling
    this.isInteractiveActive = false;
    this.rcQuestion = null;
    this.rcAnswer = null;
  }

  @HostListener('document:keydown.escape', ['$event'])
  close(): void {
    this.dialogRef.close(false);
  }
  //#endregion

  // Add getters for Save button logic
  get isSaveDisabled(): boolean {
    if (this.isAuthInProgress) return true;
    if (!this.editTarget) {
      // Creation mode: both forms must be valid
      return !this.remoteConfigForm.valid || !this.remoteForm.valid;
    }
    // Edit mode: check which form is relevant
    if (this.editTarget === 'remote') {
      return !this.remoteForm.valid;
    }
    if (['mount', 'copy', 'sync', 'move', 'bisync'].includes(this.editTarget)) {
      return !this.remoteConfigForm.valid;
    }
    // For filter/vfs/backend, only config form is relevant
    return !this.remoteConfigForm.valid;
  }

  get saveButtonLabel(): string {
    if (this.isAuthInProgress && !this.isAuthCancelled) {
      return this.editTarget ? 'Saving...' : 'Saving';
    }
    return 'Save';
  }

  get showSaveButton(): boolean {
    if (this.editTarget) {
      return true;
    }
    // Only show in creation mode after step 1
    return this.currentStep > 1 && !this.editTarget;
  }

  // Helpers for non-interactive flow
  private getDefaultAnswerFromQuestion(q: RcConfigQuestionResponse): string | boolean | number {
    const opt = q.Option;
    if (!opt) return '';
    if (opt.Type === 'bool') {
      // Prefer ValueStr/DefaultStr if provided
      if (typeof opt.Value === 'boolean') return opt.Value;
      if (opt.ValueStr !== undefined) return opt.ValueStr.toLowerCase() === 'true';
      if (opt.DefaultStr !== undefined) return opt.DefaultStr.toLowerCase() === 'true';
      if (typeof opt.Default === 'boolean') return opt.Default;
      return true;
    }
    if (opt.ValueStr !== undefined) return opt.ValueStr as unknown as string;
    if (opt.DefaultStr !== undefined) return opt.DefaultStr as unknown as string;
    if (opt.Default !== undefined) return String(opt.Default);
    if (opt.Examples && opt.Examples.length > 0) return opt.Examples[0].Value;
    return '';
  }

  async submitRcAnswer(): Promise<void> {
    if (!this.isInteractiveActive || !this.rcQuestion || !this.pendingRemoteData) return;
    try {
      const name = this.pendingRemoteData.name;
      const stateToken = this.rcQuestion.State;
      // Ensure we always send strings for bools per rclone examples
      let result: unknown = this.rcAnswer;
      if (this.rcQuestion?.Option?.Type === 'bool') {
        if (typeof result === 'boolean') result = result ? 'true' : 'false';
        else if (typeof result === 'string')
          result = result.toLowerCase() === 'true' ? 'true' : 'false';
        else result = 'true';
      }

      const { ...paramRest } = this.pendingRemoteData;
      const resp = await this.remoteManagementService.continueRemoteConfigNonInteractive(
        name,
        stateToken,
        result as unknown,
        paramRest,
        { nonInteractive: true }
      );

      if (!resp || resp.State === '') {
        // Finished
        this.isInteractiveActive = false;
        this.rcQuestion = null;
        await this.finalizeRemoteCreation();
      } else {
        this.rcQuestion = resp;
        this.rcAnswer = this.getDefaultAnswerFromQuestion(resp);
      }
    } catch (e) {
      console.error('Failed to continue config:', e);
    }
  }
  // Inline interactive step (no dialog)

  async onInteractiveContinue(answer: string | number | boolean | null): Promise<void> {
    this.isProcessing = true;
    try {
      this.rcAnswer = answer;
      await this.submitRcAnswer();
    } finally {
      this.isProcessing = false;
    }
  }

  private async finalizeRemoteCreation(): Promise<void> {
    if (!this.pendingRemoteData || !this.pendingFinalConfig) return;
    const remoteData = this.pendingRemoteData;
    const finalConfig = this.pendingFinalConfig;

    // Check if this is edit mode for remote
    if (this.editTarget === 'remote' && !this.useInteractiveMode) {
      // Update the remote instead of creating it
      await this.remoteManagementService.updateRemote(remoteData.name, remoteData);
    }

    // Save settings and run any requested actions
    await this.appSettingsService.saveRemoteSettings(remoteData.name, finalConfig);
    await this.remoteManagementService.getRemotes();
    this.authStateService.resetAuthState();

    if (finalConfig.mountConfig.autoStart && finalConfig.mountConfig.dest) {
      const mountPath = finalConfig.mountConfig.dest;
      const remoteName = remoteData.name;
      const source = finalConfig.mountConfig?.source;
      const mountType = finalConfig.mountConfig.type;
      const mountOptions = finalConfig.mountConfig.options;
      const vfs = finalConfig.vfsConfig;
      const filter = finalConfig.filterConfig;
      const backend = finalConfig.backendConfig;
      await this.mountManagementService.mountRemote(
        remoteName,
        source,
        mountPath,
        mountType,
        mountOptions,
        vfs,
        filter,
        backend
      );
    }

    if (finalConfig.copyConfig.autoStart && finalConfig.copyConfig.dest) {
      const copySource = finalConfig.copyConfig.source;
      const copyDest = finalConfig.copyConfig.dest;
      const createEmptySrcDirs = finalConfig.copyConfig.createEmptySrcDirs;
      const copyOptions = finalConfig.copyConfig.options;
      const filter = finalConfig.filterConfig;
      const backend = finalConfig.backendConfig;
      await this.jobManagementService.startCopy(
        remoteData.name,
        copySource,
        copyDest,
        createEmptySrcDirs,
        copyOptions,
        filter,
        backend
      );
    }
    if (finalConfig.syncConfig.autoStart && finalConfig.syncConfig.dest) {
      const syncSource = finalConfig.syncConfig.source;
      const syncDest = finalConfig.syncConfig.dest;
      const createEmptySrcDirs = finalConfig.syncConfig.createEmptySrcDirs;
      const syncOptions = finalConfig.syncConfig.options;
      const filter = finalConfig.filterConfig;
      const backend = finalConfig.backendConfig;
      await this.jobManagementService.startSync(
        remoteData.name,
        syncSource,
        syncDest,
        createEmptySrcDirs,
        syncOptions,
        filter,
        backend
      );
    }
    if (finalConfig.bisyncConfig.autoStart && finalConfig.bisyncConfig.dest) {
      const bisyncSource = finalConfig.bisyncConfig.source;
      const bisyncDest = finalConfig.bisyncConfig.dest;
      const bisyncOptions = finalConfig.bisyncConfig.options;
      const filter = finalConfig.filterConfig;
      const backend = finalConfig.backendConfig;
      await this.jobManagementService.startBisync(
        remoteData.name,
        bisyncSource,
        bisyncDest,
        bisyncOptions,
        filter,
        backend
      );
    }
    if (finalConfig.moveConfig.autoStart && finalConfig.moveConfig.dest) {
      const moveSource = finalConfig.moveConfig.source;
      const moveDest = finalConfig.moveConfig.dest;
      const deleteEmptySrcDirs = finalConfig.moveConfig.deleteEmptySrcDirs;
      const createEmptySrcDirs = finalConfig.moveConfig.createEmptySrcDirs;
      const moveOptions = finalConfig.moveConfig.options;
      const filter = finalConfig.filterConfig;
      const backend = finalConfig.backendConfig;
      await this.jobManagementService.startMove(
        remoteData.name,
        moveSource,
        moveDest,
        createEmptySrcDirs,
        deleteEmptySrcDirs,
        moveOptions,
        filter,
        backend
      );
    }
    this.close();
  }

  /**
   * Converts various representations of boolean values to actual boolean type.
   * This is needed because form values may come as strings "true"/"false" from the backend.
   */
  private convertToBoolean(value: unknown): boolean {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      return value.toLowerCase() === 'true';
    }
    // For any other type, convert to boolean (handles numbers, etc.)
    return Boolean(value);
  }
}
