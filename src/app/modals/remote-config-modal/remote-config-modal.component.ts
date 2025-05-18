import {
  Component,
  ElementRef,
  HostListener,
  Inject,
  OnInit,
  ViewChild,
} from "@angular/core";
import { CommonModule } from "@angular/common";
import {
  animate,
  group,
  query,
  style,
  transition,
  trigger,
} from "@angular/animations";
import {
  AbstractControl,
  FormBuilder,
  FormControl,
  FormGroup,
  ValidationErrors,
  Validators,
} from "@angular/forms";
import { MAT_DIALOG_DATA, MatDialogRef } from "@angular/material/dialog";
import { MatInputModule } from "@angular/material/input";
import { RcloneService } from "../../services/rclone.service";
import { MatProgressSpinnerModule } from "@angular/material/progress-spinner";
import { MatChipsModule } from "@angular/material/chips";
import { SettingsService } from "../../services/settings.service";
import { MatIconModule } from "@angular/material/icon";
import { debounceTime, distinctUntilChanged, Subscription } from "rxjs";
import { StateService } from "../../services/state.service";
import { MatButtonModule } from "@angular/material/button";
import {
  EditTarget,
  FieldType,
  FlagField,
  FlagType,
  LoadingState,
  REMOTE_NAME_REGEX,
  RemoteField,
  RemoteType,
} from "../../shared/remote-config-types";
import { RemoteConfigStepComponent } from "../../shared/remote-config/components/remote-config-step/remote-config-step.component";
import { FlagConfigStepComponent } from "../../shared/remote-config/components/flag-config-step/flag-config-step.component";
import { RemoteConfigService } from "../../shared/remote-config/services/remote-config.service";
import { FlagConfigService } from "../../shared/remote-config/services/flag-config.service";
import { PathSelectionService } from "../../shared/remote-config/services/path-selection.service";

@Component({
  selector: "app-remote-config-modal",
  imports: [
    CommonModule,
    MatProgressSpinnerModule,
    MatInputModule,
    MatChipsModule,
    MatIconModule,
    MatButtonModule,
    RemoteConfigStepComponent,
    FlagConfigStepComponent,
  ],
  templateUrl: "./remote-config-modal.component.html",
  styleUrl: "./remote-config-modal.component.scss",
  animations: [
    trigger("slideAnimation", [
      transition("* => *", [
        query(":leave", [style({ position: "absolute", width: "100%" })], {
          optional: true,
        }),
        group([
          query(
            ":enter",
            [
              style({ transform: "translateX(-100%)", opacity: 0 }),
              animate(
                "300ms cubic-bezier(0.25, 0.46, 0.45, 0.94)",
                style({ transform: "translateX(0)", opacity: 1 })
              ),
            ],
            { optional: true }
          ),
          query(
            ":leave",
            [
              animate(
                "300ms cubic-bezier(0.25, 0.46, 0.45, 0.94)",
                style({ transform: "translateX(-100%)", opacity: 0 })
              ),
            ],
            { optional: true }
          ),
        ]),
      ]),
    ]),
    trigger("fadeInOut", [
      transition(":enter", [
        style({ opacity: 0, transform: "translateY(10px)" }), // Start slightly below
        animate(
          "300ms ease-out",
          style({ opacity: 1, transform: "translateY(0)" })
        ),
      ]),
      transition(":leave", [
        animate(
          "200ms ease-in",
          style({ opacity: 0, transform: "translateY(-10px)" })
        ),
      ]),
    ]),
  ],
})
export class RemoteConfigModalComponent implements OnInit {
  @ViewChild("jsonArea") jsonArea!: ElementRef<HTMLTextAreaElement>;
  public readonly TOTAL_STEPS = 6;

  currentStep = 1;
  editTarget: EditTarget = null;
  private subscriptions: Subscription[] = [];
  private authSubscriptions: Subscription[] = [];
  showAdvancedOptions = false;

  remoteForm: FormGroup;
  remoteConfigForm: FormGroup;

  remoteTypes: RemoteType[] = [];
  // mountTypes: MountType[] = [
  //   { value: "Native", label: "Native (Direct Mounting)" },
  //   { value: "Systemd", label: "Systemd Service Mounting" },
  // ];
  dynamicRemoteFields: RemoteField[] = [];
  existingRemotes: string[] = [];

  dynamicFlagFields: Record<FlagType, FlagField[]> = {
    mount: [],
    copy: [],
    sync: [],
    filter: [],
    vfs: [],
  };

  selectedOptions: Record<FlagType, Record<string, any>> = {
    mount: {},
    copy: {},
    sync: {},
    filter: {},
    vfs: {},
  };

  isLoading: LoadingState = {
    remoteConfig: false,
    mountConfig: false,
    saving: false,
    authDisabled: false,
    cancelled: false,
  };

  constructor(
    private fb: FormBuilder,
    private rcloneService: RcloneService,
    private settingsService: SettingsService,
    public dialogRef: MatDialogRef<RemoteConfigModalComponent>,
    private stateService: StateService,
    private remoteConfigService: RemoteConfigService,
    public flagConfigService: FlagConfigService,
    public pathSelectionService: PathSelectionService,
    @Inject(MAT_DIALOG_DATA)
    public data: {
      editTarget?: EditTarget;
      existingConfig?: any;
      name?: string;
    }
  ) {
    this.editTarget = data?.editTarget || null;
    this.remoteForm = this.createRemoteForm();
    this.remoteConfigForm = this.createRemoteConfigForm();
  }

  async ngOnInit(): Promise<void> {
    await this.initializeComponent();
    this.setupFormListeners();
    this.setupAuthStateListeners();
    if (this.editTarget === "mount") {
      await this.pathSelectionService.fetchEntriesForField(
        "mountConfig.source",
        this.data?.name ?? "",
        this.data?.existingConfig?.source ?? ""
      );
    } else if (this.editTarget === "copy") {
      await this.pathSelectionService.fetchEntriesForField(
        "copyConfig.source",
        this.data?.name ?? "",
        this.data?.existingConfig?.source ?? ""
      );
    } else if (this.editTarget === "sync") {
      await this.pathSelectionService.fetchEntriesForField(
        "syncConfig.source",
        this.data?.name ?? "",
        this.data?.existingConfig?.source ?? ""
      );
    }
    const subs = [
      this.remoteConfigForm
        .get("mountConfig.source")
        ?.valueChanges.pipe(debounceTime(300), distinctUntilChanged())
        .subscribe((value) =>
          this.pathSelectionService.onInputChanged(
            "mountConfig.source",
            value ?? ""
          )
        ),
      this.remoteConfigForm
        .get("copyConfig.source")
        ?.valueChanges.pipe(debounceTime(300), distinctUntilChanged())
        .subscribe((value) =>
          this.pathSelectionService.onInputChanged(
            "copyConfig.source",
            value ?? ""
          )
        ),
      this.remoteConfigForm
        .get("syncConfig.source")
        ?.valueChanges.pipe(debounceTime(300), distinctUntilChanged())
        .subscribe((value) =>
          this.pathSelectionService.onInputChanged(
            "syncConfig.source",
            value ?? ""
          )
        ),
      this.remoteConfigForm
        .get("copyConfig.dest")
        ?.valueChanges.pipe(debounceTime(300), distinctUntilChanged())
        .subscribe((value) =>
          this.pathSelectionService.onInputChanged(
            "copyConfig.dest",
            value ?? ""
          )
        ),
      this.remoteConfigForm
        .get("syncConfig.dest")
        ?.valueChanges.pipe(debounceTime(300), distinctUntilChanged())
        .subscribe((value) =>
          this.pathSelectionService.onInputChanged(
            "syncConfig.dest",
            value ?? ""
          )
        ),
    ].filter((sub): sub is Subscription => !!sub);
    this.subscriptions.push(...subs);
  }

  async ngOnDestroy(): Promise<void> {
    this.cleanupSubscriptions();
    await this.stateService.cancelAuth();
  }

  private async initializeComponent(): Promise<void> {
    await this.loadExistingRemotes();
    if (this.data?.existingConfig) {
      console.log("Existing Config:", this.data.existingConfig);
      this.populateForm(this.data.existingConfig);
    }
    this.loadRemoteTypes();
    this.dynamicFlagFields = await this.flagConfigService.loadAllFlagFields();
  }

  // Remote Config Service
  private async loadRemoteTypes(): Promise<void> {
    this.remoteTypes = await this.remoteConfigService.getRemoteTypes();
  }

  async onRemoteTypeChange(): Promise<void> {
    this.isLoading.remoteConfig = true;
    try {
      const remoteName = this.remoteForm.get("name")?.value;
      const remoteType = this.remoteForm.get("type")?.value;
      const response = await this.rcloneService.getRemoteConfigFields(
        remoteType
      );

      this.remoteForm = this.createRemoteForm();
      this.remoteForm.patchValue({ name: remoteName, type: remoteType });

      this.dynamicRemoteFields =
        this.remoteConfigService.mapRemoteFields(response);
      this.addDynamicRemoteFieldsToForm();
    } catch (error) {
      console.error("Error loading remote config fields:", error);
    } finally {
      this.isLoading.remoteConfig = false;
    }
  }

  private addDynamicRemoteFieldsToForm(): void {
    this.dynamicRemoteFields.forEach((field) => {
      const config = this.remoteConfigService.createFormControlConfig(field);
      this.remoteForm.addControl(
        field.Name,
        new FormControl(config.value, config.validators)
      );
    });
  }

  private setupAuthStateListeners(): void {
    this.authSubscriptions.push(
      this.stateService.isAuthInProgress$.subscribe((isInProgress) => {
        this.isLoading.saving = isInProgress;
        this.isLoading.authDisabled = isInProgress;
        this.setFormState(isInProgress);
      })
    );
    this.authSubscriptions.push(
      this.stateService.isAuthCancelled$.subscribe((isCancelled) => {
        this.isLoading.cancelled = isCancelled;
        console.log("Auth cancelled:", isCancelled);
      })
    );
  }

  private setupFormListeners(): void {
    // Mount path required if autoMount is enabled
    this.remoteConfigForm
      .get("mountConfig.autoMount")
      ?.valueChanges.subscribe((enabled) => {
        const destCtrl = this.remoteConfigForm.get("mountConfig.dest");
        if (enabled) {
          destCtrl?.setValidators([Validators.required]);
        } else {
          destCtrl?.clearValidators();
        }
        destCtrl?.updateValueAndValidity();
      });

    // Copy source/dest required if autoCopy is enabled
    this.remoteConfigForm
      .get("copyConfig.autoCopy")
      ?.valueChanges.subscribe((enabled) => {
        const destCtrl = this.remoteConfigForm.get("copyConfig.dest");
        if (enabled) {
          destCtrl?.setValidators([Validators.required]);
        } else {
          destCtrl?.clearValidators();
        }
        destCtrl?.updateValueAndValidity();
      });

    // Sync source/dest required if autoSync is enabled
    this.remoteConfigForm
      .get("syncConfig.autoSync")
      ?.valueChanges.subscribe((enabled) => {
        const destCtrl = this.remoteConfigForm.get("syncConfig.dest");
        if (enabled) {
          destCtrl?.setValidators([Validators.required]);
        } else {
          destCtrl?.clearValidators();
        }
        destCtrl?.updateValueAndValidity();
      });
  }

  async onSourceOptionSelectedField(
    entryName: string,
    formPath: string
  ): Promise<void> {
    const control = this.remoteConfigForm.get(formPath);
    await this.pathSelectionService.onPathSelected(
      formPath,
      entryName,
      control
    );
  }

  async onDestOptionSelectedField(
    entryName: string,
    formPath: string
  ): Promise<void> {
    const control = this.remoteConfigForm.get(formPath);
    await this.pathSelectionService.onPathSelected(
      formPath,
      entryName,
      control,
      true
    );
  }

  async onRemoteSelected(
    remoteWithColon: string,
    formPath: string
  ): Promise<void> {
    const control = this.remoteConfigForm.get(formPath);
    await this.pathSelectionService.onRemoteSelected(
      formPath,
      remoteWithColon,
      control
    );
  }

  async onRemoteSelectedField(
    remoteWithColon: string,
    formPath: string
  ): Promise<void> {
    const control = this.remoteConfigForm.get(formPath);
    await this.pathSelectionService.onRemoteSelected(
      formPath,
      remoteWithColon,
      control
    );
  }

  resetRemoteSelectionField(formPath: string): void {
    this.pathSelectionService.resetPathSelection(formPath);
    this.remoteConfigForm.get(formPath)?.setValue("");
  }

  private cleanupSubscriptions(): void {
    this.subscriptions.forEach((sub) => sub.unsubscribe());
    this.authSubscriptions.forEach((sub) => sub.unsubscribe());
    this.subscriptions = [];
    this.authSubscriptions = [];
  }

  private createRemoteForm(): FormGroup {
    const isEditMode =
      this.editTarget === "remote" && !!this.data?.existingConfig;
    const form = this.fb.group({
      name: [
        { value: "", disabled: isEditMode },
        [Validators.required, this.validateRemoteNameFactory()],
      ],
      type: [{ value: "", disabled: isEditMode }, [Validators.required]],
    });
    return form;
  }

  private createRemoteConfigForm(): FormGroup {
    return this.fb.group({
      mountConfig: this.fb.group({
        autoMount: [false],
        dest: [""],
        source: [""],
        options: ["{}", [this.jsonValidator]],
      }),
      copyConfig: this.fb.group({
        autoCopy: [false],
        source: [""],
        dest: [""],
        options: ["{}", [this.jsonValidator]],
      }),
      syncConfig: this.fb.group({
        autoSync: [false],
        source: [""],
        dest: [""],
        options: ["{}", [this.jsonValidator]],
      }),
      filterConfig: this.fb.group({
        options: ["{}", [this.jsonValidator]],
      }),
      vfsConfig: this.fb.group({
        options: ["{}", [this.jsonValidator]],
      }),
    });
  }

  // Custom JSON validator
  private jsonValidator(control: AbstractControl): ValidationErrors | null {
    try {
      JSON.parse(control.value);
      return null;
    } catch (e) {
      return { invalidJson: true };
    }
  }

  //#region Remote Configuration Methods
  private async loadExistingRemotes(): Promise<void> {
    try {
      this.existingRemotes = await this.rcloneService.getRemotes();
    } catch (error) {
      console.error("Error loading existing remotes:", error);
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
    const configGroup = this.remoteConfigForm.get(
      `${flagType}Config`
    ) as FormGroup;
    const optionsControl = configGroup?.get("options");
    if (!optionsControl) return;

    const jsonStr = JSON.stringify(this.selectedOptions[flagType], null, 2);
    optionsControl.setValue(jsonStr);
  }

  validateJson(flagType: FlagType): void {
    const configGroup = this.remoteConfigForm.get(
      `${flagType}Config`
    ) as FormGroup;
    const optionsControl = configGroup?.get("options");
    if (!optionsControl) return;

    const validation = this.flagConfigService.validateFlagOptions(
      optionsControl.value || "{}",
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
    const configGroup = this.remoteConfigForm.get(
      `${flagType}Config`
    ) as FormGroup;
    if (!configGroup) return;

    const optionsControl = configGroup.get("options");
    if (!optionsControl) return;

    optionsControl.setValue("{}");
    this.selectedOptions[flagType] = {};
  }
  //#endregion

  //#region Form Population Methods
  populateForm(config: any): void {
    if (!this.editTarget) return;
    console.log(this.editTarget);
    console.log(config);

    if (this.editTarget === "remote") {
      this.populateRemoteForm(config);
    } else {
      // Handle all flag types (mount, copy, sync, filter, vfs)
      switch (this.editTarget) {
        case "mount":
        case "copy":
        case "sync":
          this.populateFlagBasedForm(this.editTarget, config);
          break;
        case "filter":
        case "vfs":
          this.populateFlagForm(this.editTarget, config);
          break;
      }
    }
  }

  private async populateRemoteForm(config: any): Promise<void> {
    // Set basic fields first
    this.remoteForm.patchValue({
      name: config.name,
      type: config.type,
    });

    // Load remote type configuration
    await this.onRemoteTypeChange();

    // After fields are loaded, populate their values
    this.dynamicRemoteFields.forEach((field) => {
      if (config[field.Name] !== undefined) {
        this.remoteForm.get(field.Name)?.setValue(config[field.Name]);
      } else if (field.Value !== null) {
        this.remoteForm.get(field.Name)?.setValue(field.Value);
      }
    });
  }

  private populateFlagBasedForm(flagType: FlagType, config: any): void {
    this.remoteConfigForm.patchValue({
      [`${flagType}Config`]: {
        autoSync: config.autoSync ?? false,
        source: config.source || "",
        dest: config.dest || "",
        options: JSON.stringify(config.options || {}, null, 2),
      },
    });
    this.syncSelectedOptionsFromJson(flagType);
  }

  private populateFlagForm(flagType: FlagType, config: any): void {
    const configGroup = this.remoteConfigForm.get(
      `${flagType}Config`
    ) as FormGroup;
    if (!configGroup) return;

    const optionsControl = configGroup.get("options");
    if (!optionsControl) return;

    optionsControl.setValue(JSON.stringify(config, null, 2));
    this.syncSelectedOptionsFromJson(flagType);
  }

  private syncSelectedOptionsFromJson(flagType: FlagType): void {
    const configGroup = this.remoteConfigForm.get(
      `${flagType}Config`
    ) as FormGroup;
    if (!configGroup) return;
    console.log("Config Groups:", configGroup);

    const optionsControl = configGroup.get("options");
    if (!optionsControl) return;
    console.log("Option Controls:", configGroup);

    try {
      const parsed = this.safeJsonParse(optionsControl.value || "{}");
      this.selectedOptions[flagType] = { ...parsed };
    } catch {
      this.selectedOptions[flagType] = {};
    }
    this.updateJsonDisplay(flagType);
  }
  //#endregion

  //#region Form Submission Methods
  async onSubmit(): Promise<void> {
    if (this.isLoading.saving || this.isLoading.authDisabled) return;

    // this.isLoading.saving = true;
    // this.isLoading.cancelled = false;
    // this.setFormState(false);

    try {
      const result = this.editTarget
        ? await this.handleEditMode()
        : await this.handleCreateMode();

      if (result.success && !this.isLoading.cancelled) {
        this.close();
      }
    } catch (error) {
      console.error("Error during submission:", error);
    } finally {
      this.stateService.resetAuthState();
    }
  }

  private setFormState(disabled: boolean): void {
    if (disabled) {
      this.remoteConfigForm.disable();
      this.remoteForm.disable();
    } else {
      this.remoteForm.enable();
      this.remoteConfigForm.enable();
    }
  }

  private async handleEditMode(): Promise<{ success: boolean }> {
    const updatedConfig: any = {};
    const remoteName = this.getRemoteName();

    await this.stateService.startAuth(remoteName, true);
    await this.updateConfigBasedOnEditTarget(updatedConfig);
    await this.settingsService.saveRemoteSettings(remoteName, updatedConfig);

    return { success: true };
  }

  private getRemoteName(): string {
    return this.data.name || this.remoteForm.get("name")?.value;
  }

  private async updateConfigBasedOnEditTarget(
    updatedConfig: any
  ): Promise<void> {
    if (!this.editTarget) return;

    const updateHandlers = {
      remote: this.handleRemoteUpdate.bind(this),
      mount: this.handleMountUpdate.bind(this),
      copy: this.handleCopyUpdate.bind(this),
      sync: this.handleSyncUpdate.bind(this),
      filter: this.handleFlagUpdate.bind(this),
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
        autoMount: configData.mountConfig.autoMount,
        dest: configData.mountConfig.dest,
        source: configData.mountConfig.source,
        options: {
          ...this.safeJsonParse(configData.mountConfig.options),
        },
      },
      copyConfig: {
        autoCopy: configData.copyConfig.autoCopy,
        source: configData.copyConfig.source,
        dest: configData.copyConfig.dest,
        options: {
          ...this.safeJsonParse(configData.copyConfig.options),
        },
      },
      syncConfig: {
        autoSync: configData.syncConfig.autoSync,
        source: configData.syncConfig.source,
        dest: configData.syncConfig.dest,
        options: {
          ...this.safeJsonParse(configData.syncConfig.options),
        },
      },
      filterConfig: this.safeJsonParse(configData.filterConfig.options),
      vfsConfig: this.safeJsonParse(configData.vfsConfig.options),
    };

    await this.stateService.startAuth(remoteData.name, false);
    await this.rcloneService.createRemote(remoteData.name, remoteData);
    await this.settingsService.saveRemoteSettings(remoteData.name, finalConfig);

    if (finalConfig.mountConfig.autoMount && finalConfig.mountConfig.dest) {
      const mountPath = finalConfig.mountConfig.dest;
      const remoteName = remoteData.name;
      const source = finalConfig.mountConfig?.source;
      await this.rcloneService.mountRemote(remoteName + ":" + source, mountPath);
    }

    return { success: true };
  }

  private async handleRemoteUpdate(updatedConfig: any): Promise<void> {
    const remoteData = this.cleanFormData(this.remoteForm.getRawValue());
    updatedConfig.name = remoteData.name;
    updatedConfig.type = remoteData.type;
    await this.rcloneService.updateRemote(remoteData.name, remoteData);
  }

  private async handleMountUpdate(updatedConfig: any): Promise<void> {
    const mountData = this.cleanFormData(
      this.remoteConfigForm.getRawValue().mountConfig
    );
    updatedConfig.mountConfig = {
      autoMount: mountData.autoMount,
      dest: mountData.dest,
      source: mountData.source,
      options: {
        ...this.safeJsonParse(mountData.options),
      },
    };
    console.log(updatedConfig);
  }

  private async handleCopyUpdate(updatedConfig: any): Promise<void> {
    const copyData = this.cleanFormData(
      this.remoteConfigForm.getRawValue().copyConfig
    );
    updatedConfig.copyConfig = {
      autoCopy: copyData.autoCopy,
      source: copyData.source,
      dest: copyData.dest,
      options: {
        ...this.safeJsonParse(copyData.options),
      },
    };
  }

  private async handleSyncUpdate(updatedConfig: any): Promise<void> {
    const syncData = this.cleanFormData(
      this.remoteConfigForm.getRawValue().syncConfig
    );

    updatedConfig.syncConfig = {
      autoSync: syncData.autoSync,
      source: syncData.source,
      dest: syncData.dest,
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

    const mountData = this.cleanFormData(this.remoteConfigForm.getRawValue());
    const jsonValue = mountData[`${this.editTarget}Config`].options || "{}";

    // Handle each flag type specifically
    switch (this.editTarget) {
      default:
        // For filter and vfs, just use the JSON config
        updatedConfig[`${this.editTarget}Config`] =
          this.safeJsonParse(jsonValue);
        break;
    }
  }
  //#endregion

  //#region Utility Methods
  private validateRemoteNameFactory() {
    return (control: AbstractControl): ValidationErrors | null => {
      const value = control.value?.trimEnd();
      if (!value) return null;

      // Check allowed characters
      if (!REMOTE_NAME_REGEX.test(value)) {
        return { invalidChars: true };
      }

      // Check start character
      if (value.startsWith("-") || value.startsWith(" ")) {
        return { invalidStart: true };
      }

      // Check end character
      if (control.value.endsWith(" ")) {
        return { invalidEnd: true };
      }

      return this.existingRemotes.includes(value) ? { nameTaken: true } : null;
    };
  }

  private cleanFormData(formData: any): any {
    return Object.entries(formData)
      .filter(([key, value]) => {
        if (value === null || value === 0 || value === "0") {
          return false;
        }
        // Skip if value matches default
        return !this.isDefaultValue(key, value);
      })
      .reduce((acc, [key, value]) => ({ ...acc, [key]: value }), {});
  }

  private isDefaultValue(fieldName: string, value: any): boolean {
    const field = this.dynamicRemoteFields.find((f) => f.Name === fieldName);
    if (!field) return false;

    // Get the proper default value
    let defaultValue =
      field.Default !== undefined
        ? this.flagConfigService.coerceValueToType(
            field.Default,
            field.Type as FieldType
          )
        : this.flagConfigService.coerceValueToType(
            field.Value,
            field.Type as FieldType
          );

    // If value or defaultValue is an object or stringified object, compare as strings
    if (
      (typeof value === "string" &&
        value.startsWith("{") &&
        value.endsWith("}")) ||
      typeof defaultValue === "object"
    ) {
      try {
        // Parse both to objects for deep comparison
        const parsedValue =
          typeof value === "string" ? JSON.parse(value) : value;
        const parsedDefault =
          typeof defaultValue === "string"
            ? JSON.parse(defaultValue)
            : defaultValue;
        return JSON.stringify(parsedValue) === JSON.stringify(parsedDefault);
      } catch {
        // Fallback to string comparison if parsing fails
        return String(value) === String(defaultValue);
      }
    }

    // Special handling for arrays
    if (Array.isArray(value) && Array.isArray(defaultValue)) {
      return (
        JSON.stringify(value.sort()) === JSON.stringify(defaultValue.sort())
      );
    }

    // Fallback to simple comparison
    return JSON.stringify(value) === JSON.stringify(defaultValue);
  }

  private safeJsonParse(data: any): any {
    try {
      return data ? (typeof data === "string" ? JSON.parse(data) : data) : {};
    } catch (error) {
      console.error("Failed to parse JSON:", data, error);
      return {};
    }
  }
  //#endregion

  //#region UI Helper Methods
  selectLocalFolder(whichFormPath: string): void {
    this.rcloneService.selectFolder(true).then((selectedPath) => {
      this.remoteConfigForm.get(whichFormPath)?.setValue(selectedPath);
    });
  }

  nextStep(): void {
    if (this.currentStep < this.TOTAL_STEPS && this.remoteForm.valid) {
      this.currentStep++;
    }
  }

  prevStep(): void {
    if (this.currentStep > 1) {
      this.currentStep--;
    }
  }

  async cancelAuth(): Promise<void> {
    await this.stateService.cancelAuth();
  }

  @HostListener("document:keydown.escape", ["$event"])
  close(): void {
    this.dialogRef.close(false);
  }
  //#endregion
}
