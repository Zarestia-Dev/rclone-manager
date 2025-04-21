import {
  Component,
  ElementRef,
  HostListener,
  Inject,
  OnInit,
  Optional,
  ViewChild,
} from "@angular/core";
import { CommonModule } from "@angular/common";
import { animate, style, transition, trigger } from "@angular/animations";
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
import { MatButtonModule } from "@angular/material/button";

// Types and Interfaces
type FlagType = "mount" | "copy" | "sync" | "filter" | "vfs";
type EditTarget = FlagType | "remote" | null;

interface RemoteType {
  value: string;
  label: string;
}

interface MountType {
  value: string;
  label: string;
}

interface FlagField {
  ValueStr: any;
  Value: null;
  name: string;
  default: any;
  help: string;
  type: string;
  required: boolean;
  examples: any[];
}

interface RemoteField {
  Name: string;
  Type: string;
  Help: string;
  Value: any;
  Required: boolean;
  Examples: any[];
}

interface LoadingState {
  remoteConfig: boolean;
  mountConfig: boolean;
  saving: boolean;
  [key: string]: boolean;
}

interface JsonConfigs {
  mount: string;
  copy: string;
  sync: string;
  filter: string;
  vfs: string;
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
    MatButtonModule
  ],
  templateUrl: "./remote-config-modal.component.html",
  styleUrl: "./remote-config-modal.component.scss",
  animations: [
    trigger("slideAnimation", [
      transition(":enter", [
        style({ opacity: 0, transform: "translateX(100%)" }),
        animate(
          "500ms cubic-bezier(0.25, 0.8, 0.25, 1)",
          style({ opacity: 1, transform: "translateX(0)" })
        ),
      ]),
      transition(":leave", [
        animate(
          "500ms cubic-bezier(0.25, 0.8, 0.25, 1)",
          style({ opacity: 0, transform: "translateX(-100%)" })
        ),
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

  remoteForm: FormGroup;
  remoteConfigForm: FormGroup;

  remoteTypes: RemoteType[] = [];
  mountTypes: MountType[] = [
    { value: "Native", label: "Native (Direct Mounting)" },
    { value: "Systemd", label: "Systemd Service Mounting" },
  ];
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
  };

  constructor(
    private fb: FormBuilder,
    private rcloneService: RcloneService,
    private settingsService: SettingsService,
    public dialogRef: MatDialogRef<RemoteConfigModalComponent>,
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
  }

  ngOnDestroy(): void {
    this.cleanupSubscriptions();
    this.cancelAuth();
  }

  private initializeComponent(): void {
    this.loadExistingRemotes();
    if (this.data?.existingConfig) {
      this.populateForm(this.data.existingConfig);
    }
    this.loadRemoteTypes();
    this.loadFlagFields();
  }

  private setupFormListeners(): void {
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
    this.subscriptions = [];
  }

  private createRemoteForm(): FormGroup {
    return this.fb.group({
      name: ["", [Validators.required, this.validateRemoteName.bind(this)]],
      type: ["", Validators.required],
    });
  }

  private createRemoteConfigForm(): FormGroup {
    return this.fb.group({
      mountType: ["", Validators.required],
      mountPath: ["", Validators.required],
      autoMount: [false],
      jsonConfigs: this.fb.group({
        mount: ["{}"],
        copy: ["{}"],
        sync: ["{}"],
        filter: ["{}"],
        vfs: ["{}"],
      }),
    });
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
      const validators = field.Required ? [Validators.required] : [];
      this.remoteForm.addControl(
        field.Name,
        this.fb.control(field.Value, validators)
      );
    });
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
            this.dynamicFlagFields[type] = this.mapFlagFields(flags);
          }
        })
      );
    } catch (error) {
      this.handleError(error, "loading flag fields");
    }
  }

  async onMountTypeChange(): Promise<void> {
    this.isLoading.mountConfig = true;
    try {
      const mountOptions = await this.rcloneService.getMountFlags();
      this.dynamicFlagFields.mount = this.mapFlagFields(mountOptions);
    } catch (error) {
      this.handleError(error, "fetching mount config fields");
    } finally {
      this.isLoading.mountConfig = false;
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
      this.selectedOptions[flagType][field.name] = field.default ?? "";
    }

    this.updateJsonDisplay(flagType);
  }

  private updateJsonDisplay(flagType: FlagType): void {
    const jsonConfigsGroup = this.remoteConfigForm.get(
      "jsonConfigs"
    ) as FormGroup;
    if (!jsonConfigsGroup?.contains(flagType)) return;

    const jsonStr = JSON.stringify(this.selectedOptions[flagType], null, 2);
    jsonConfigsGroup.get(flagType)?.setValue(jsonStr);
    this.autoResize();
  }

  validateJson(flagType: FlagType): void {
    const jsonConfigsGroup = this.remoteConfigForm.get(
      "jsonConfigs"
    ) as FormGroup;
    const control = jsonConfigsGroup?.get(flagType);
    if (!control) return;

    try {
      const parsedValue = JSON.parse(control.value || "{}");
      this.selectedOptions[flagType] = parsedValue;
      control.setErrors(null);
    } catch (error) {
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

  private populateRemoteForm(config: any): void {
    this.remoteForm.patchValue(config);
    this.onRemoteTypeChange().then(() => {
      this.dynamicRemoteFields.forEach((field) => {
        if (!this.remoteForm.contains(field.Name)) {
          this.remoteForm.addControl(field.Name, this.fb.control(""));
        }
        this.remoteForm.get(field.Name)?.setValue(config[field.Name] || "");
      });
    });
  }

  private populateMountForm(config: any): void {
    const { mount_point, auto_mount, ...mountOptions } = config;
    this.remoteConfigForm.patchValue({
      mountType: config.mountType || "Native",
      mountPath: mount_point || "",
      autoMount: auto_mount ?? false,
    });

    const jsonConfigsGroup = this.remoteConfigForm.get(
      "jsonConfigs"
    ) as FormGroup;
    jsonConfigsGroup
      .get("mount")
      ?.setValue(JSON.stringify(mountOptions, null, 2));
    this.validateJson("mount");
  }

  private populateFlagForm(flagType: FlagType, config: any): void {
    const jsonConfigsGroup = this.remoteConfigForm.get(
      "jsonConfigs"
    ) as FormGroup;
    jsonConfigsGroup.get(flagType)?.setValue(JSON.stringify(config, null, 2));
    this.validateJson(flagType);
  }
  //#endregion

  //#region Form Submission Methods
  async onSubmit(): Promise<void> {
    if (this.isLoading.saving) return;

    this.isLoading.saving = true;
    try {
      const result = this.editTarget
        ? await this.handleEditMode()
        : await this.handleCreateMode();

      if (result.success) {
        this.close();
      }
    } catch (error) {
      this.handleError(error, "saving configuration");
    } finally {
      this.isLoading.saving = false;
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
    const remoteData = this.cleanFormData(this.remoteForm.value);
    const mountData = this.cleanFormData(this.remoteConfigForm.value);

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

    await this.rcloneService.createRemote(remoteData.name, remoteData);
    await this.settingsService.saveRemoteSettings(remoteData.name, finalConfig);
    return { success: true };
  }

  private async handleRemoteUpdate(updatedConfig: any): Promise<void> {
    const remoteData = this.cleanFormData(this.remoteForm.value);
    updatedConfig.name = remoteData.name;
    updatedConfig.type = remoteData.type;
    await this.rcloneService.updateRemote(remoteData.name, remoteData);
  }

  private async handleMountUpdate(updatedConfig: any): Promise<void> {
    const mountData = this.cleanFormData(this.remoteConfigForm.value);
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
      Required: option.Required ?? false,
      Examples: option.Examples || [],
    }));
  }

  private cleanFormData(formData: any): any {
    return Object.entries(formData)
      .filter(([_, value]) => value !== null && value !== "")
      .reduce((acc, [key, value]) => ({ ...acc, [key]: value }), {});
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
    // Could add user notification here
  }
  //#endregion

  //#region UI Helper Methods
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

  cancelAuth(): void {
    this.rcloneService.quitOAuth();
    this.isLoading.saving = false;
  }

  @HostListener("document:keydown.escape", ["$event"])
  close(): void {
    this.dialogRef.close(false);
  }
  //#endregion
}
