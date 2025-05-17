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
  ReactiveFormsModule,
  ValidationErrors,
  Validators,
} from "@angular/forms";
import { MAT_DIALOG_DATA, MatDialogRef } from "@angular/material/dialog";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatSelectModule } from "@angular/material/select";
import { MatDividerModule } from "@angular/material/divider";
import { MatInputModule } from "@angular/material/input";
import { RcloneService } from "../../services/rclone.service";
import { MatProgressSpinnerModule } from "@angular/material/progress-spinner";
import { MatSlideToggleModule } from "@angular/material/slide-toggle";
import { MatChipsModule } from "@angular/material/chips";
import { MatTooltipModule } from "@angular/material/tooltip";
import { SettingsService } from "../../services/settings.service";
import { MatIconModule } from "@angular/material/icon";
import { debounceTime, distinctUntilChanged, Subscription } from "rxjs";
import { MatCardModule } from "@angular/material/card";
import { StateService } from "../../services/state.service";
import { MatButtonModule } from "@angular/material/button";
import {
  EditTarget,
  Entry,
  FieldType,
  FlagField,
  FlagType,
  LoadingState,
  REMOTE_NAME_REGEX,
  RemoteField,
  RemoteType,
  SENSITIVE_KEYS,
  LinebreaksPipe,
} from "../../shared/remote-config-types";
import { CdkTextareaAutosize } from "@angular/cdk/text-field";
import { MatAutocompleteModule } from "@angular/material/autocomplete";

@Component({
  selector: "app-remote-config-modal",
  imports: [
    ReactiveFormsModule,
    CommonModule,
    MatSelectModule,
    MatFormFieldModule,
    MatDividerModule,
    MatProgressSpinnerModule,
    MatInputModule,
    MatSlideToggleModule,
    MatChipsModule,
    MatTooltipModule,
    MatIconModule,
    MatCardModule,
    MatButtonModule,
    CdkTextareaAutosize,
    MatAutocompleteModule,
    LinebreaksPipe,
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

  public readonly FLAG_TYPES: FlagType[] = [
    "mount",
    "copy",
    "sync",
    "filter",
    "vfs",
  ];
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

  pathState: Record<
    string,
    { remoteName: string; currentPath: string; options: Entry[] }
  > = {};

  private destroyed = false;

  constructor(
    private fb: FormBuilder,
    private rcloneService: RcloneService,
    private settingsService: SettingsService,
    public dialogRef: MatDialogRef<RemoteConfigModalComponent>,
    private stateService: StateService,
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
      this.fetchEntriesForField(
        "mountConfig.source",
        this.data?.name ?? "",
        this.data?.existingConfig?.source ?? ""
      );
    } else if (this.editTarget === "copy") {
      this.fetchEntriesForField(
        "copyConfig.source",
        this.data?.name ?? "",
        this.data?.existingConfig?.source ?? ""
      );
    } else if (this.editTarget === "sync") {
      this.fetchEntriesForField(
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
          this.onInputChanged("mountConfig.source", value ?? "")
        ),
      this.remoteConfigForm
        .get("copyConfig.source")
        ?.valueChanges.pipe(debounceTime(300), distinctUntilChanged())
        .subscribe((value) =>
          this.onInputChanged("copyConfig.source", value ?? "")
        ),
      this.remoteConfigForm
        .get("syncConfig.source")
        ?.valueChanges.pipe(debounceTime(300), distinctUntilChanged())
        .subscribe((value) =>
          this.onInputChanged("syncConfig.source", value ?? "")
        ),
      this.remoteConfigForm
        .get("copyConfig.dest")
        ?.valueChanges.pipe(debounceTime(300), distinctUntilChanged())
        .subscribe((value) =>
          this.onInputChanged("copyConfig.dest", value ?? "")
        ),
      this.remoteConfigForm
        .get("syncConfig.dest")
        ?.valueChanges.pipe(debounceTime(300), distinctUntilChanged())
        .subscribe((value) =>
          this.onInputChanged("syncConfig.dest", value ?? "")
        ),
    ].filter((sub): sub is Subscription => !!sub);
    this.subscriptions.push(...subs);
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.subscriptions.forEach((sub) => sub?.unsubscribe());
  }

  private async onInputChanged(formPath: string, value: string): Promise<void> {
    if (this.destroyed) return;
    const cleanedPath = value?.trim() ?? "";
    if (cleanedPath === this.pathState[formPath]?.currentPath) return;

    const pathParts = cleanedPath.split("/").filter(Boolean);
    const parentPath = pathParts.join("/");

    this.pathState[formPath].currentPath = parentPath;
    await this.fetchEntriesForField(
      formPath,
      this.pathState[formPath]?.remoteName ?? "",
      parentPath
    );
  }


  private async initializeComponent(): Promise<void> {
    await this.loadExistingRemotes();
    if (this.data?.existingConfig) {
      console.log("Existing Config:", this.data.existingConfig);
      this.populateForm(this.data.existingConfig);
    }
    this.loadRemoteTypes();
    this.loadFlagFields();
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

  loading = false;

  async fetchEntriesForField(
    formPath: string,
    remoteName: string,
    path: string
  ): Promise<void> {
    this.loading = true;
    try {
      // Remove remote name from path if present
      let cleanPath = path;
      if (cleanPath.startsWith(`${remoteName}:/`)) {
        cleanPath = cleanPath.slice(`${remoteName}:/`.length);
      }
      // Remove leading slash if present
      if (cleanPath.startsWith("/")) {
        cleanPath = cleanPath.slice(1);
      }
      const options = await this.rcloneService.getRemotePaths(
        remoteName,
        cleanPath || "",
        {}
      );
      if (!this.pathState[formPath]) {
        this.pathState[formPath] = {
          remoteName,
          currentPath: cleanPath,
          options,
        };
      } else {
        this.pathState[formPath].remoteName = remoteName;
        this.pathState[formPath].currentPath = cleanPath;
        this.pathState[formPath].options = options;
      }
    } finally {
      this.loading = false;
    }
  }

  async onSourceOptionSelectedField(
    entryName: string,
    formPath: string
  ): Promise<void> {
    const state = this.pathState[formPath];
    if (!state) return;
    const selectedEntry = state.options.find((e) => e.Name === entryName);
    const control = this.remoteConfigForm.get(formPath);
    if (!selectedEntry || !control) return;

    const fullPath = state.currentPath
      ? `${state.currentPath}/${selectedEntry.Name}`
      : selectedEntry.Name;
    const remotePath = `${fullPath}`;

    if (selectedEntry.IsDir) {
      state.currentPath = fullPath;
      control.setValue(remotePath);
      await this.fetchEntriesForField(
        formPath,
        state.remoteName,
        state.currentPath
      );
    } else {
      control.setValue(remotePath);
    }
  }

  async onDestOptionSelectedField(
    entryName: string,
    formPath: string
  ): Promise<void> {
    const state = this.pathState[formPath];
    if (!state) return;
    const selectedEntry = state.options.find((e) => e.Name === entryName);
    const control = this.remoteConfigForm.get(formPath);
    if (!selectedEntry || !control) return;

    // Build the full path for display/saving
    const fullPath = state.currentPath
      ? `${state.currentPath}/${selectedEntry.Name}`
      : selectedEntry.Name;
    const remotePath = `${state.remoteName}:/${fullPath}`;

    if (selectedEntry.IsDir) {
      // For directories, update currentPath and fetch entries inside it
      state.currentPath = fullPath;
      control.setValue(remotePath);
      await this.fetchEntriesForField(
        formPath,
        state.remoteName,
        state.currentPath
      );
    } else {
      // For files, just set the full remote path
      control.setValue(remotePath);
    }
  }

  async onRemoteSelected(
    remoteWithColon: string,
    formPath: string
  ): Promise<void> {
    const [remote] = remoteWithColon.split(":");
    this.pathState[formPath].remoteName = remote;
    this.pathState[formPath].currentPath = "";
    const control = this.remoteConfigForm.get(formPath);
    if (control) {
      control.setValue(`${remote}:/`); // Set full remote path with :/
    }
    await this.fetchEntriesForField(
      formPath,
      remote,
      this.pathState[formPath].currentPath
    );
  }

  async onRemoteSelectedField(
    remoteWithColon: string,
    formPath: string
  ): Promise<void> {
    const [remote] = remoteWithColon.split(":");
    this.pathState[formPath] = {
      remoteName: remote,
      currentPath: "",
      options: [],
    };
    const control = this.remoteConfigForm.get(formPath);
    if (control) {
      control.setValue(`${remote}:/`);
    }
    await this.fetchEntriesForField(formPath, remote, "");
  }

  resetRemoteSelectionField(formPath: string): void {
    this.pathState[formPath] = { remoteName: "", currentPath: "", options: [] };
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
      this.handleError(error, "loading existing remotes");
    }
  }

  private async loadRemoteTypes(): Promise<void> {
    try {
      const providers = await this.rcloneService.getRemoteTypes();
      this.remoteTypes = providers.map((provider: any) => ({
        value: provider.name,
        label: provider.description,
      }));
    } catch (error) {
      this.handleError(error, "loading remote types");
    }
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

      this.dynamicRemoteFields = this.mapRemoteFields(response);
      this.addDynamicRemoteFieldsToForm();
    } catch (error) {
      this.handleError(error, "fetching remote type config");
    } finally {
      this.isLoading.remoteConfig = false;
    }
  }

  private addDynamicRemoteFieldsToForm(): void {
    this.dynamicRemoteFields.forEach((field) => {
      const control = this.createFormControlForField(field);
      this.remoteForm.addControl(field.Name, control);
    });
  }

  private createFormControlForField(field: RemoteField): FormControl {
    // Use field.Default if defined, otherwise field.Value, otherwise type default
    let initialValue =
      field.Default !== undefined
        ? this.coerceValueToType(field.Default, field.Type as FieldType)
        : field.Value !== undefined
        ? this.coerceValueToType(field.Value, field.Type as FieldType)
        : this.getDefaultValueForType(field.Type as FieldType);

    // Fix: If initialValue is an object (not array), convert to string (or boolean for bool)
    if (
      typeof initialValue === "object" &&
      !Array.isArray(initialValue) &&
      initialValue !== null
    ) {
      if (field.Type === "bool") {
        initialValue = false;
      } else {
        initialValue = JSON.stringify(initialValue);
      }
    }

    const validators = [];
    if (field.Required) {
      validators.push(Validators.required);
    }

    // Add type-specific validators
    switch (field.Type) {
      case "int":
      case "int64":
      case "uint32":
      case "SizeSuffix":
        validators.push(Validators.pattern("^[0-9]*$"));
        break;
      case "stringArray":
      case "CommaSeparatedList":
        validators.push(this.arrayValidator);
        break;
    }

    return this.fb.control(initialValue, validators);
  }

  // Custom array validator
  private arrayValidator(control: AbstractControl): ValidationErrors | null {
    if (!control.value) return null;
    try {
      const arr = Array.isArray(control.value)
        ? control.value
        : JSON.parse(control.value);
      if (!Array.isArray(arr)) {
        return { invalidArray: true };
      }
      return null;
    } catch {
      return { invalidArray: true };
    }
  }
  //#endregion

  //#region Flag Configuration Methods
  private async loadFlagFields(): Promise<void> {
    try {
      await Promise.all(
        this.FLAG_TYPES.map(async (type) => {
          const methodName = `get${this.capitalizeFirstLetter(type)}Flags`;
          if (typeof (this.rcloneService as any)[methodName] === "function") {
            const flags = await (
              (this.rcloneService as any)[methodName] as () => Promise<any[]>
            )();
            console.log(
              `Loaded ${type} flags:`,
              flags.map((flag) => flag.FieldName)
            );
            this.dynamicFlagFields[type] = this.mapFlagFields(flags);
          }
        })
      );
    } catch (error) {
      this.handleError(error, "loading flag fields");
    }
  }

  toggleOption(flagType: FlagType, field: FlagField): void {
    // Get the correct config group based on flagType
    const configGroup = this.remoteConfigForm.get(
      `${flagType}Config`
    ) as FormGroup;
    if (!configGroup) return;

    // Get the options control from the config group
    const optionsControl = configGroup.get("options");
    if (!optionsControl) return;

    // Parse the current JSON value
    const parsedValue = this.safeJsonParse(optionsControl.value || "{}");
    this.selectedOptions[flagType] = { ...parsedValue };

    // Toggle the field
    if (this.selectedOptions[flagType][field.name] !== undefined) {
      delete this.selectedOptions[flagType][field.name];
    } else {
      // Get value with proper type
      let value =
        field.Value !== null
          ? field.Value
          : field.ValueStr !== undefined
          ? field.ValueStr
          : field.default !== null
          ? field.default
          : this.getDefaultValueForType(field.type);

      // Special case for Tristate
      if (field.type === "Tristate") {
        value = false;
      }

      // Convert to proper type immediately
      this.selectedOptions[flagType][field.name] = this.coerceValueToType(
        value,
        field.type
      );
    }

    this.updateJsonDisplay(flagType);
  }

  private updateJsonDisplay(flagType: FlagType): void {
    const configGroup = this.remoteConfigForm.get(
      `${flagType}Config`
    ) as FormGroup;
    const optionsControl = configGroup?.get("options");
    if (!optionsControl) return;

    // Create type-preserved version
    const typedOptions = this.preserveOptionTypes(
      this.selectedOptions[flagType],
      this.dynamicFlagFields[flagType]
    );

    const jsonStr = JSON.stringify(typedOptions, this.jsonReplacer, 2);
    optionsControl.setValue(jsonStr);
  }

  private jsonReplacer(key: string, value: any): any {
    // Handle special cases for JSON serialization
    if (value === null || value === undefined) return undefined;
    if (Array.isArray(value) && value.length === 0) return undefined;
    if (typeof value === "object" && Object.keys(value).length === 0)
      return undefined;
    return value;
  }

  private preserveOptionTypes(
    options: Record<string, any>,
    fields: FlagField[]
  ): Record<string, any> {
    const result: Record<string, any> = {};

    for (const [key, value] of Object.entries(options)) {
      const field = fields.find((f) => f.name === key);
      if (!field) {
        result[key] = value;
        continue;
      }

      // Convert based on field type
      switch (field.type) {
        case "bool":
          result[key] = Boolean(value);
          break;
        case "int":
        case "int64":
        case "uint32":
        case "SizeSuffix":
          result[key] = parseInt(value, 10) || 0;
          break;
        case "stringArray":
          result[key] = Array.isArray(value) ? value : [String(value)];
          break;
        default:
          result[key] = value;
      }
    }

    return result;
  }

  validateJson(flagType: FlagType): void {
    const configGroup = this.remoteConfigForm.get(
      `${flagType}Config`
    ) as FormGroup;
    if (!configGroup) return;

    const optionsControl = configGroup.get("options");
    if (!optionsControl) return;

    try {
      const parsedValue = this.safeJsonParse(optionsControl.value || "{}");
      const cleanedValue: Record<string, any> = {};

      // Validate each field against its type
      for (const [key, value] of Object.entries(parsedValue)) {
        const field = this.dynamicFlagFields[flagType].find(
          (f) => f.name === key
        );
        if (field) {
          cleanedValue[key] = this.coerceValueToType(value, field.type);
        }
      }

      this.selectedOptions[flagType] = cleanedValue;
      optionsControl.setErrors(null);
    } catch (error) {
      console.error(`Invalid JSON in ${flagType}:`, error);
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
          this.populateMountForm(config);
          break;
        case "copy":
          this.populateCopyForm(config);
          break;
        case "sync":
          this.populateSyncForm(config);
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

  private populateMountForm(config: any): void {
    this.remoteConfigForm.patchValue({
      mountConfig: {
        autoMount: config.autoMount ?? false,
        dest: config.dest || "",
        source: config.source || "",
        options: JSON.stringify(config.options || {}, null, 2),
      },
    });
    this.syncSelectedOptionsFromJson("mount");
  }

  private populateCopyForm(config: any): void {
    this.remoteConfigForm.patchValue({
      copyConfig: {
        autoCopy: config.auto_copy ?? false,
        source: config.source || "",
        dest: config.dest || "",
        options: JSON.stringify(config.options || {}, null, 2),
      },
    });
    this.syncSelectedOptionsFromJson("copy");
  }

  private populateSyncForm(config: any): void {
    this.remoteConfigForm.patchValue({
      syncConfig: {
        autoSync: config.auto_sync ?? false,
        source: config.source || "",
        dest: config.dest || "",
        options: JSON.stringify(config.options || {}, null, 2),
      },
    });
    this.syncSelectedOptionsFromJson("sync");
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
      this.handleError(error, "saving configuration");
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
    const remoteName = this.data.name || this.remoteForm.get("name")?.value;

    await this.stateService.startAuth(remoteName, true);

    switch (this.editTarget) {
      case "remote":
        await this.handleRemoteUpdate(updatedConfig);
        break;
      case "mount":
        await this.handleMountUpdate(updatedConfig);
        break;
      case "copy":
        await this.handleCopyUpdate(updatedConfig);
        break;
      case "sync":
        await this.handleSyncUpdate(updatedConfig);
        break;
      case "filter":
      case "vfs":
        await this.handleFlagUpdate(updatedConfig);
        break;
    }

    await this.settingsService.saveRemoteSettings(remoteName, updatedConfig);
    console.log("Settings saved:", updatedConfig, remoteName);
    return { success: true };
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
      !this.FLAG_TYPES.includes(this.editTarget as FlagType)
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
  private getDefaultValueForType(type: FieldType): any {
    switch (type) {
      case "bool":
        return false;
      case "int":
      case "int64":
      case "uint32":
      case "SizeSuffix":
        return 0;
      case "string":
      case "Duration":
      case "FileMode":
      case "CacheMode":
        return "";
      case "stringArray":
        return [""];
      case "Tristate":
        return null;
      case "HARD|SOFT|CAUTIOUS":
        return "HARD";
      default:
        return null;
    }
  }

  private coerceValueToType(value: any, type: FieldType): any {
    if (value === null || value === undefined || value === "") {
      return this.getDefaultValueForType(type);
    }

    try {
      switch (type) {
        case "bool":
          if (typeof value === "string") {
            const normalized = value.trim().toLowerCase();
            if (normalized === "true") return true;
            if (normalized === "false") return false;
          }
          return Boolean(value);

        case "int":
        case "int64":
        case "uint32":
        case "SizeSuffix":
          const intValue = parseInt(value, 10);
          return isNaN(intValue) ? this.getDefaultValueForType(type) : intValue;

        case "stringArray":
        case "CommaSeparatedList":
          if (Array.isArray(value)) return value;
          if (typeof value === "string") {
            return value
              .split(",")
              .map((item) => item.trim())
              .filter((item) => item);
          }
          return [String(value)];

        case "Tristate":
          if (value === "true") return true;
          if (value === "false") return false;
          return value;

        default:
          return value;
      }
    } catch (error) {
      console.warn(
        `Failed to coerce value '${value}' to type '${type}'`,
        error
      );
      return this.getDefaultValueForType(type);
    }
  }

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

  private mapFlagFields(fields: any[]): FlagField[] {
    return fields.map((field) => ({
      ValueStr: field.ValueStr ?? "",
      Value: field.Value ?? null,
      name: field.FieldName || field.Name,
      default: field.Default || null,
      help: field.Help || "No description available",
      type: field.Type || "string",
      required: field.Required || false,
      examples: field.Examples || [],
    }));
  }

  private mapRemoteFields(remoteOptions: any[]): RemoteField[] {
    return remoteOptions.map((option) => ({
      Name: option.Name,
      Type: option.Type?.toLowerCase() || "string",
      Help: option.Help || "No description available",
      Value: option.Value || null,
      Default: option.Default || null,
      Required: option.Required ?? false,
      Advanced: option.Advanced ?? false,
      Examples: option.Examples || [],
    }));
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
        ? this.coerceValueToType(field.Default, field.Type as FieldType)
        : this.coerceValueToType(field.Value, field.Type as FieldType);

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

  private capitalizeFirstLetter(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  private handleError(error: any, context: string): void {
    console.error(`Error in ${context}:`, error);
  }
  //#endregion

  //#region UI Helper Methods
  get basicFieldsCount(): number {
    return this.dynamicRemoteFields.filter((f) => !f.Advanced).length;
  }

  get advancedFieldsCount(): number {
    return this.dynamicRemoteFields.filter((f) => f.Advanced).length;
  }

  isSensitiveField(fieldName: string): boolean {
    return SENSITIVE_KEYS.some((key) => fieldName.toLowerCase().includes(key));
  }

  selectLocalFolder(whichFormPath: string): void {
    this.rcloneService.selectFolder(true).then((selectedPath) => {
      this.remoteConfigForm.get(whichFormPath)?.setValue(selectedPath);
    });
  }

  allowOnlyNumbers(event: KeyboardEvent): void {
    const charCode = event.key ? event.key.charCodeAt(0) : 0;
    if (charCode < 48 || charCode > 57) {
      event.preventDefault();
    }
  }

  sanitizeNumberInput(fieldName: string): void {
    const value = this.remoteForm.get(fieldName)?.value;
    if (value && isNaN(value)) {
      this.remoteForm.get(fieldName)?.setValue("");
    }
  }

  toggleAdvancedOptions() {
    this.showAdvancedOptions = !this.showAdvancedOptions;
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

  get isEditMode(): boolean {
    return !!this.editTarget;
  }

  shouldShowRemotePath(): boolean {
    return this.editTarget === "mount";
  }

  shouldShowPathPairs(): boolean {
    return this.editTarget === "copy" || this.editTarget === "sync";
  }
  //#endregion
}
