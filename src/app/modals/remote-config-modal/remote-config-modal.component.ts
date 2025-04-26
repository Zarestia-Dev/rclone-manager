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

// Types and Interfaces
type FlagType = "mount" | "copy" | "sync" | "filter" | "vfs";
type EditTarget = FlagType | "remote" | null;

interface RemoteType {
  value: string;
  label: string;
}

// interface MountType {
//   value: string;
//   label: string;
// }

type FieldType =
  | "bool"
  | "int"
  | "Duration"
  | "string"
  | "SizeSuffix"
  | "HARD|SOFT|CAUTIOUS"
  | "stringArray"
  | "int64"
  | "Tristate"
  | "uint32"
  | "FileMode"
  | "CacheMode"
  | "CommaSeparatedList";

interface FlagField {
  name: string;
  type: FieldType;
  help: string;
  required: boolean;
  examples: { Value: any; Help: string }[];
  default: any;
  Value: any;
  ValueStr: string;
  hidden?: boolean;
  advanced?: boolean;
}

interface RemoteField {
  Name: string;
  Type: string;
  Help: string;
  Value: any;
  Default: any;
  Required: boolean;
  Advanced: boolean;
  Examples: any[];
}

interface LoadingState {
  remoteConfig: boolean;
  mountConfig: boolean;
  saving: boolean;
  authDisabled: boolean;
  cancelled: boolean;
  [key: string]: boolean;
}

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
                "500ms cubic-bezier(0.35, 0, 0.25, 1)",
                style({ transform: "translateX(0)", opacity: 1 })
              ),
            ],
            { optional: true }
          ),
          query(
            ":leave",
            [
              animate(
                "500ms cubic-bezier(0.35, 0, 0.25, 1)",
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

  ngOnInit(): void {
    this.initializeComponent();
    this.setupFormListeners();
    this.setupAuthStateListeners();
  }

  ngOnDestroy(): void {
    this.cleanupSubscriptions();
    this.cleanup();
  }

  private initializeComponent(): void {
    this.loadExistingRemotes();
    if (this.data?.existingConfig) {
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
    // Dynamically require mountPath if autoMount is enabled
    this.remoteConfigForm
      .get("autoMount")
      ?.valueChanges.subscribe((enabled) => {
        const mountPathCtrl = this.remoteConfigForm.get("mountPath");
        if (enabled) {
          mountPathCtrl?.setValidators([Validators.required]);
        } else {
          mountPathCtrl?.clearValidators();
        }
        mountPathCtrl?.updateValueAndValidity();
      });
      
    // Debounce JSON validation
    const jsonConfigs = this.remoteConfigForm.get("jsonConfigs") as FormGroup;
    this.FLAG_TYPES.forEach((flagType) => {
      const control = jsonConfigs.get(flagType) as FormControl;
      this.subscriptions.push(
        control.valueChanges
          .pipe(debounceTime(300), distinctUntilChanged())
          .subscribe(() => this.validateJson(flagType))
      );
    });

    // Auto-resize textarea on changes
    this.subscriptions.push(
      jsonConfigs.valueChanges.subscribe(() => this.autoResize())
    );
  }

  private cleanupSubscriptions(): void {
    this.subscriptions.forEach((sub) => sub.unsubscribe());
    this.authSubscriptions.forEach((sub) => sub.unsubscribe());
    this.subscriptions = [];
    this.authSubscriptions = [];
  }

  private createRemoteForm(): FormGroup {
    return this.fb.group({
      name: ["", [Validators.required, this.validateRemoteName.bind(this)]],
      type: ["", Validators.required],
    });
  }

  private createRemoteConfigForm(): FormGroup {
    return this.fb.group({
      // mountType: ["", Validators.required],
      autoMount: [false],
      mountPath: [""],
      jsonConfigs: this.fb.group({
        mount: ["{}", [this.jsonValidator]],
        copy: ["{}", [this.jsonValidator]],
        sync: ["{}", [this.jsonValidator]],
        filter: ["{}", [this.jsonValidator]],
        vfs: ["{}", [this.jsonValidator]],
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
        label: provider.name,
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
    const defaultValue = this.coerceValueToType(
      field.Value,
      field.Type as FieldType
    );
    const validators = field.Required ? [Validators.required] : [];

    // Add type-specific validators
    switch (field.Type) {
      case "int":
      case "int64":
      case "uint32":
        validators.push(Validators.pattern(/^-?\d+$/));
        break;
      case "SizeSuffix":
        validators.push(Validators.pattern(/^\d+[KMGTP]?[B]?$/i));
        break;
      case "stringArray":
      case "CommaSeparatedList":
        validators.push(this.arrayValidator);
        break;
    }

    return this.fb.control(defaultValue, validators);
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
    const jsonConfigsGroup = this.remoteConfigForm.get(
      "jsonConfigs"
    ) as FormGroup;
    if (!jsonConfigsGroup?.contains(flagType)) return;

    const parsedValue = this.safeJsonParse(
      jsonConfigsGroup.get(flagType)?.value || "{}"
    );
    this.selectedOptions[flagType] = { ...parsedValue };

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

  // Enhanced JSON handling with type preservation
  private updateJsonDisplay(flagType: FlagType): void {
    const jsonConfigsGroup = this.remoteConfigForm.get(
      "jsonConfigs"
    ) as FormGroup;
    const control = jsonConfigsGroup?.get(flagType);
    if (!control) return;

    // Create type-preserved version
    const typedOptions = this.preserveOptionTypes(
      this.selectedOptions[flagType],
      this.dynamicFlagFields[flagType]
    );

    const jsonStr = JSON.stringify(typedOptions, this.jsonReplacer, 2);
    control.setValue(jsonStr);
    this.autoResize();
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
          result[key] = parseInt(value, 10) || 0;
          break;
        case "SizeSuffix":
          result[key] = this.parseSizeSuffix(value);
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
    const jsonConfigsGroup = this.remoteConfigForm.get(
      "jsonConfigs"
    ) as FormGroup;
    const control = jsonConfigsGroup?.get(flagType);
    if (!control) return;

    try {
      const parsedValue = JSON.parse(control.value || "{}");
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
      control.setErrors(null);
    } catch (error) {
      console.error(`Invalid JSON in ${flagType}:`, error);
      control.setErrors({ invalidJson: true });
    }
  }

  resetJson(flagType: FlagType): void {
    const jsonConfigsGroup = this.remoteConfigForm.get(
      "jsonConfigs"
    ) as FormGroup;
    jsonConfigsGroup?.get(flagType)?.setValue("{}");
    this.selectedOptions[flagType] = {};
    this.autoResize();
  }
  //#endregion

  //#region Form Population Methods
  populateForm(config: any = {}): void {
    if (!this.editTarget) return;

    if (this.editTarget === "remote") {
      this.populateRemoteForm(config);
    } else if (this.editTarget === "mount") {
      this.populateMountForm(config);
    } else if (this.FLAG_TYPES.includes(this.editTarget)) {
      this.populateFlagForm(this.editTarget, config);
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
    const { mount_point, auto_mount, ...mountOptions } = config;
    this.remoteConfigForm.patchValue({
      // mountType: config.mountType || "Native",
      mountPath: mount_point || "",
      autoMount: auto_mount ?? false,
    });

    const jsonConfigsGroup = this.remoteConfigForm.get(
      "jsonConfigs"
    ) as FormGroup;
    jsonConfigsGroup
      .get("mount")
      ?.setValue(JSON.stringify(mountOptions, null, 2));

    this.syncSelectedOptionsFromJson("mount");
  }

  private populateFlagForm(flagType: FlagType, config: any): void {
    const jsonConfigsGroup = this.remoteConfigForm.get(
      "jsonConfigs"
    ) as FormGroup;
    jsonConfigsGroup.get(flagType)?.setValue(JSON.stringify(config, null, 2));

    this.syncSelectedOptionsFromJson(flagType);
  }

  private syncSelectedOptionsFromJson(flagType: FlagType): void {
    this.validateJson(flagType);
    const jsonConfigsGroup = this.remoteConfigForm.get(
      "jsonConfigs"
    ) as FormGroup;
    const control = jsonConfigsGroup.get(flagType);
    if (!control) return;
    try {
      const parsed = JSON.parse(control.value || "{}");
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

    switch (this.editTarget) {
      case "remote":
        await this.handleRemoteUpdate(updatedConfig);
        break;
      case "mount":
        await this.handleMountUpdate(updatedConfig);
        break;
      default:
        await this.handleFlagUpdate(updatedConfig);
        break;
    }

    await this.settingsService.saveRemoteSettings(remoteName, updatedConfig);
    return { success: true };
  }

  private async handleCreateMode(): Promise<{ success: boolean }> {
    const remoteData = this.cleanFormData(this.remoteForm.getRawValue());
    const mountData = this.cleanFormData(this.remoteConfigForm.getRawValue());

    const finalConfig = {
      custom_flags: [],
      mount_options: {
        auto_mount: mountData.autoMount,
        mount_point: mountData.mountPath,
        ...this.safeJsonParse(mountData.jsonConfigs?.mount),
      },
      vfs_options: this.safeJsonParse(mountData.jsonConfigs?.vfs),
      copy_options: this.safeJsonParse(mountData.jsonConfigs?.copy),
      sync_options: this.safeJsonParse(mountData.jsonConfigs?.sync),
      filter_options: this.safeJsonParse(mountData.jsonConfigs?.filter),
    };

    await this.stateService.startAuth(remoteData.name);
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
    const mountData = this.cleanFormData(this.remoteConfigForm.getRawValue());
    console.log("Mount Data:", mountData);
    updatedConfig.mount_options = {
      auto_mount: mountData.autoMount,
      mount_point: mountData.mountPath,
      ...this.safeJsonParse(mountData.jsonConfigs?.mount),
    };
  }

  private async handleFlagUpdate(updatedConfig: any): Promise<void> {
    if (
      !this.editTarget ||
      !this.FLAG_TYPES.includes(this.editTarget as FlagType)
    )
      return;

    const jsonConfigsGroup = this.remoteConfigForm.get(
      "jsonConfigs"
    ) as FormGroup;
    const jsonValue = jsonConfigsGroup.get(this.editTarget)?.value || "{}";
    updatedConfig[`${this.editTarget}_options`] = this.safeJsonParse(jsonValue);
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
          const intValue = parseInt(value, 10);
          return isNaN(intValue) ? this.getDefaultValueForType(type) : intValue;

        case "SizeSuffix":
          return this.parseSizeSuffix(value);

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

  private parseSizeSuffix(value: string | number): number {
    if (typeof value === "number") return value;

    const match = String(value).match(/^(\d+(?:\.\d+)?)\s*([KMGTP]?)[B]?$/i);
    if (!match) return 0;

    const num = parseFloat(match[1]);
    const suffix = match[2].toUpperCase();
    const multipliers = {
      "": 1,
      K: 1024,
      M: 1024 ** 2,
      G: 1024 ** 3,
      T: 1024 ** 4,
      P: 1024 ** 5,
    };

    return num * (multipliers[suffix as keyof typeof multipliers] || 1);
  }

  validateRemoteName(control: AbstractControl): ValidationErrors | null {
    const value = control.value?.trim();
    if (!value) return null;

    if (
      this.editTarget === "remote" &&
      this.data?.existingConfig?.name === value
    ) {
      return null;
    }

    return this.existingRemotes.includes(value) ? { nameTaken: true } : null;
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
        // Skip null/empty values
        if (value === null || value === "") return false;
        // Skip if value matches default
        return !this.isDefaultValue(key, value);
      })
      .reduce((acc, [key, value]) => ({ ...acc, [key]: value }), {});
  }

  private isDefaultValue(fieldName: string, value: any): boolean {
    const field = this.dynamicRemoteFields.find((f) => f.Name === fieldName);
    if (!field) return false;

    // Get the proper default value
    const defaultValue =
      field.Default !== undefined
        ? this.coerceValueToType(field.Default, field.Type as FieldType)
        : this.coerceValueToType(field.Value, field.Type as FieldType);

    // Special handling for different types
    if (Array.isArray(value) && Array.isArray(defaultValue)) {
      return (
        JSON.stringify(value.sort()) === JSON.stringify(defaultValue.sort())
      );
    }

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

  selectFolder(): void {
    this.rcloneService.selectFolder(true).then((selectedPath) => {
      this.remoteConfigForm.get("mountPath")?.setValue(selectedPath);
    });
  }

  autoResize(): void {
    setTimeout(() => {
      if (this.jsonArea) {
        const textarea = this.jsonArea.nativeElement;
        textarea.style.height = "auto";
        textarea.style.height = `${textarea.scrollHeight}px`;
      }
    }, 0);
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

  private cleanup(): void {
    this.cancelAuth();
  }
  //#endregion
}
