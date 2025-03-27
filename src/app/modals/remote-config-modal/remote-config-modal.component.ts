import {
  Component,
  ElementRef,
  HostListener,
  Inject,
  OnInit,
  ViewChild,
} from "@angular/core";
import { CommonModule } from "@angular/common";
import { animate, style, transition, trigger } from "@angular/animations";
import {
  AbstractControl,
  FormBuilder,
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

  jsonError: string | null = null;
  remoteForm: FormGroup;
  remoteConfigForm: FormGroup;

  currentStep = 1;
  totalSteps = 6;

  editTarget: "remote" | "mount" | "copy" | "sync" | "filter" | "vfs" | null =
    null;
  flagTypes = ["mount", "copy", "sync", "filter", "vfs"];

  dynamicFlagFields: Record<string, any[]> = {
    mount: [],
    copy: [],
    sync: [],
    filter: [],
    vfs: [],
  };

  /** Object holding selected options for each flag type */
  selectedOptions: Record<string, Record<string, any>> = {
    mount: {},
    copy: {},
    sync: {},
    filter: {},
    vfs: {},
  };

  remoteTypes: any[] = [];
  mountTypes: any[] = [];
  dynamicRemoteFields: any[] = [];
  existingRemotes: string[] = [];

  isLoading = {
    remoteConfig: false,
    mountConfig: false,
    saving: false,
  };

  constructor(
    private fb: FormBuilder,
    private rcloneService: RcloneService,
    private settingsService: SettingsService,
    public dialogRef: MatDialogRef<RemoteConfigModalComponent>,
    @Inject(MAT_DIALOG_DATA) public data: any
  ) {
    this.editTarget = data?.editTarget || null; // Determine edit mode

    this.remoteForm = this.fb.group({
      name: ["", [Validators.required, this.validateRemoteName.bind(this)]],
      type: ["", Validators.required],
    });

    this.remoteConfigForm = this.fb.group({
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

  async ngOnInit(): Promise<void> {
    this.existingRemotes = await this.rcloneService.getRemotes();

    if (this.data?.existingConfig) {
      this.populateForm(this.data.existingConfig);
    }

    await this.loadRemoteTypes();
    await this.loadMountTypes();
    await this.loadFlagFields();
  }

  selectFolder(): void {
    this.rcloneService.selectFolder().then((selectedPath) => {
      this.remoteConfigForm.get("mountPath")?.setValue(selectedPath);
    });
  }

  /** ✅ Custom Validator: Prevent duplicate remote names */
  validateRemoteName(control: AbstractControl): ValidationErrors | null {
    const value = control.value?.trim();
    if (!value) return null; // Skip empty validation
    return this.existingRemotes.includes(value) ? { nameTaken: true } : null;
  }

  /** Helper function to map API fields */
  private mapFlagFields(fields: any[]): any[] {
    return fields.map((field) => ({
      name: field.FieldName || field.Name,
      default: field.Default || null,
      help: field.Help || "No description available",
      type: field.Type || "string",
      required: field.Required || false,
      examples: field.Examples || [],
    }));
  }

  async loadRemoteTypes(): Promise<void> {
    try {
      const providers = await this.rcloneService.getRemoteTypes();
      this.remoteTypes = providers.map((provider: any) => ({
        value: provider.name,
        label: provider.name,
      }));
    } catch (error) {
      console.error("Failed to load remote types", error);
    }
  }

  async loadMountTypes(): Promise<void> {
    try {
      this.mountTypes = [
        { value: "Native", label: "Native (Direct Mounting)" },
        { value: "Systemd", label: "Systemd Service Mounting" },
      ];
    } catch (error) {
      console.error("Error fetching mount types:", error);
    }
  }

  private mapRemoteFields(remoteOptions: any[]): any[] {
    return remoteOptions.map((option) => ({
      Name: option.Name,
      Type: option.Type?.toLowerCase() || "string",
      Help: option.Help || "No description available",
      Value: option.Value || null,
      Required: option.Required ?? false,
      Examples: option.Examples || [], // ✅ Store available choices for dropdowns
    }));
  }

  async onRemoteTypeChange() {
    this.isLoading.remoteConfig = true;
    try {
      const remoteName = this.remoteForm.get("name")?.value;
      const remoteType = this.remoteForm.get("type")?.value;
      const response = await this.rcloneService.getRemoteConfigFields(
        remoteType
      );

      console.log("Remote type config:", response);

      // ✅ Reset form and ensure 'type' & 'name' fields exist
      this.remoteForm = this.fb.group({
        name: [
          remoteName,
          [Validators.required, this.validateRemoteName.bind(this)],
        ],
        type: [remoteType, Validators.required],
      });

      // ✅ Map and store remote fields
      this.dynamicRemoteFields = this.mapRemoteFields(response);

      this.dynamicRemoteFields.forEach((field) => {
        const validators = field.Required ? [Validators.required] : [];

        this.remoteForm.addControl(
          field.Name,
          this.fb.control(field.Value, validators)
        );
      });
    } catch (error) {
      console.error("Failed to fetch remote type config:", error);
    } finally {
      this.isLoading.remoteConfig = false;
    }
  }

  async loadFlagFields(): Promise<void> {
    try {
      await Promise.all(
        this.flagTypes.map(async (type) => {
          const methodName = `get${
            type.charAt(0).toUpperCase() + type.slice(1)
          }Flags` as keyof RcloneService;
          if (typeof this.rcloneService[methodName] === "function") {
            this.dynamicFlagFields[type] = this.mapFlagFields(
              await (this.rcloneService[methodName] as () => Promise<any[]>)()
            );
          }
        })
      );
      console.log("Flag Fields Loaded:", this.dynamicFlagFields);
    } catch (error) {
      console.error("Failed to load flag fields:", error);
    }
  }

  /** Generate form controls dynamically */
  generateFormControls(): void {
    this.dynamicRemoteFields.forEach((field) => {
      this.remoteForm.addControl(
        field.name,
        this.fb.control(field.required ? Validators.required : [])
      );
    });
  }

  /** Fetch mount configuration fields dynamically */
  async onMountTypeChange(): Promise<void> {
    const selectedMountType = this.remoteConfigForm.get("mountType")?.value;
    if (!selectedMountType) return;

    this.isLoading.mountConfig = true;
    try {
      const mountOptions = await this.rcloneService.getMountFlags();

      // ✅ Filter and map mount options dynamically
      this.dynamicFlagFields["mount"] = this.mapFlagFields(mountOptions);

      this.generateMountFormControls();
    } catch (error) {
      console.error("Error fetching mount config fields:", error);
    } finally {
      this.isLoading.mountConfig = false;
    }
  }

  /** Add/remove option when a chip is selected */
  toggleOption(flagType: keyof typeof this.selectedOptions, field: any): void {
    const jsonConfigsGroup = this.remoteConfigForm.get(
      "jsonConfigs"
    ) as FormGroup;
    if (!jsonConfigsGroup || !jsonConfigsGroup.contains(flagType)) return;

    let parsedValue = {};
    try {
      parsedValue = JSON.parse(jsonConfigsGroup.get(flagType)?.value || "{}");
    } catch (error) {
      console.warn("Invalid JSON detected, keeping last valid input.");
    }

    // ✅ Preserve manually added values
    this.selectedOptions[flagType] = { ...parsedValue };

    if (this.selectedOptions[flagType][field.name] !== undefined) {
      // ✅ Deselect: Remove from JSON
      delete this.selectedOptions[flagType][field.name];
    } else {
      // ✅ Select: Add value
      this.selectedOptions[flagType][field.name] = field.default ?? "";
    }

    // ✅ Update JSON display
    this.updateJsonDisplay(flagType);
  }

  updateJsonDisplay(flagType: keyof typeof this.selectedOptions): void {
    const jsonConfigsGroup = this.remoteConfigForm.get(
      "jsonConfigs"
    ) as FormGroup;
    if (!jsonConfigsGroup || !jsonConfigsGroup.contains(flagType)) return;

    const jsonStr = JSON.stringify(this.selectedOptions[flagType], null, 2);
    jsonConfigsGroup.get(flagType)?.setValue(jsonStr);

    this.autoResize();
    this.validateJson(flagType);
  }

  validateJson(step: keyof typeof this.selectedOptions): void {
    const jsonConfigsGroup = this.remoteConfigForm.get(
      "jsonConfigs"
    ) as FormGroup;
    if (!jsonConfigsGroup || !jsonConfigsGroup.contains(step)) return;

    const control = jsonConfigsGroup.get(step);
    const jsonValue = control?.value || "{}";

    try {
      const parsedValue = JSON.parse(jsonValue);
      this.selectedOptions[step] = parsedValue;

      // ✅ Remove error if JSON is valid
      control?.setErrors(null);
    } catch (error) {
      console.error("Invalid JSON detected:", error);

      // ❌ Set validation error
      control?.setErrors({ invalidJson: true });
    }

    this.autoResize();
  }

  /** ✅ Reset JSON Input */
  resetJson(step: keyof typeof this.selectedOptions): void {
    const jsonConfigsGroup = this.remoteConfigForm.get(
      "jsonConfigs"
    ) as FormGroup;
    if (!jsonConfigsGroup || !jsonConfigsGroup.contains(step)) return;

    // ✅ Reset value to an empty JSON object
    jsonConfigsGroup.get(step)?.setValue("{}");

    // ✅ Clear selected options
    this.selectedOptions[step] = {};

    this.autoResize();
  }

  /** Auto-adjust textarea height */
  autoResize(): void {
    setTimeout(() => {
      if (this.jsonArea) {
        const textarea = this.jsonArea.nativeElement;
        textarea.style.height = "auto";
        textarea.style.height = textarea.scrollHeight + "px";
      }
    }, 0);
  }

  /** Generate dynamic form controls */
  private generateMountFormControls(): void {
    this.dynamicFlagFields["mount"].forEach((field) => {
      const validators = field.required ? [Validators.required] : [];

      let defaultValue: any = null;

      if (field.Type === "bool") {
        defaultValue = field.Value !== null ? field.Value : field.Default;
      } else if (field.Type === "stringArray") {
        defaultValue = field.Value || field.Default || []; // Use array for multi-select
      } else if (field.examples.length > 0) {
        defaultValue =
          field.ValueStr || field.DefaultStr || field.examples[0].Value;
      } else if (["int", "SizeSuffix", "bits"].includes(field.Type)) {
        defaultValue = field.Value !== null ? field.Value : field.Default;
      } else {
        defaultValue = field.ValueStr || field.DefaultStr || "";
      }

      // ✅ Add control to form, keeping default values intact
      this.remoteConfigForm.addControl(
        field.name,
        this.fb.control(defaultValue, validators)
      );
    });
  }

  /** ✅ Load only relevant section when editing */
  populateForm(config: any = {}): void {
    if (this.editTarget === "remote") {
      this.remoteForm.patchValue(config);

      // ✅ Wait for dynamic fields before patching
      this.onRemoteTypeChange().then(() => {
        this.dynamicRemoteFields.forEach((field) => {
          if (!this.remoteForm.contains(field.Name)) {
            this.remoteForm.addControl(field.Name, this.fb.control(""));
          }
          this.remoteForm.get(field.Name)?.setValue(config[field.Name] || "");
        });
      });
    } else if (this.editTarget === "mount") {
      // Extract mount options from config
      const mountOptions = config || {};

      // Patch direct form values
      this.remoteConfigForm.patchValue({
        mountType: config.mountType || "Native",
        mountPath: mountOptions.mount_point || "",
        autoMount: mountOptions.auto_mount ?? false,
      });

      // Get the jsonConfigs group
      const jsonConfigsGroup = this.remoteConfigForm.get(
        "jsonConfigs"
      ) as FormGroup;

      // Remove the direct fields we already set from the JSON config
      const { mount_point, auto_mount, ...jsonMountOptions } = mountOptions;

      if (jsonConfigsGroup.contains("mount")) {
        jsonConfigsGroup
          .get("mount")
          ?.setValue(JSON.stringify(jsonMountOptions, null, 2));
        this.validateJson("mount");
        this.autoResize();
      }
    } else if (this.editTarget) {
      const jsonConfigsGroup = this.remoteConfigForm.get(
        "jsonConfigs"
      ) as FormGroup;

      if (jsonConfigsGroup.contains(this.editTarget)) {
        jsonConfigsGroup
          .get(this.editTarget)
          ?.setValue(JSON.stringify(config, null, 2));

        this.validateJson(this.editTarget);
        this.autoResize();
      }
    }
  }

  async onSubmit(): Promise<void> {
    this.isLoading.saving = true;

    try {
      const updatedConfig: any = {};

      if (this.editTarget) {
        switch (this.editTarget) {
          case "remote":
            await this.handleRemoteUpdate(updatedConfig);
            break;

          case "mount":
            await this.handleMountUpdate(updatedConfig);
            break;

          default:
            await this.handleGenericUpdate(updatedConfig);
            break;
        }
        console.log("📌 Updated config for:", this.data.name)
        await this.settingsService.saveRemoteSettings(
          this.data.name,
          updatedConfig
        );
        console.log(`✅ Successfully updated ${this.editTarget} settings!`);
        this.dialogRef.close(updatedConfig);
      } else {
        await this.handleNewRemoteCreation();
      }
    } catch (error) {
      console.error("❌ Failed to save configuration:", error);
    } finally {
      this.isLoading.saving = false;
    }
  }

  private async handleRemoteUpdate(updatedConfig: any): Promise<void> {
    const remoteData = this.cleanFormData(this.remoteForm.value);
    updatedConfig.name = remoteData.name;
    updatedConfig.type = remoteData.type;

    console.log("📌 Updating remote settings:", updatedConfig);
    await this.rcloneService.updateRemote(remoteData.name, remoteData);
  }

  private async handleMountUpdate(updatedConfig: any): Promise<void> {
    const mountData = this.cleanFormData(this.remoteConfigForm.value);
    updatedConfig.mount_options = {
      auto_mount: mountData.autoMount,
      mount_point: mountData.mountPath,
      ...this.parseJson(mountData.jsonConfigs?.mount),
    };

    console.log("📌 Updating mount settings:", updatedConfig.mount_options);
  }

  private async handleGenericUpdate(updatedConfig: any): Promise<void> {
    const jsonConfigsGroup = this.remoteConfigForm.get(
      "jsonConfigs"
    ) as FormGroup;
    const jsonValue = this.editTarget
      ? jsonConfigsGroup.get(this.editTarget)?.value || "{}"
      : "{}";

    try {
      updatedConfig[`${this.editTarget}_options`] = JSON.parse(jsonValue);
    } catch (error) {
      console.error(`❌ Failed to parse ${this.editTarget} JSON:`, error);
      jsonConfigsGroup.get(this.editTarget!)?.setErrors({ invalidJson: true });
      throw error;
    }

    console.log(`📌 Updating ${this.editTarget} settings:`, updatedConfig);
  }

  private async handleNewRemoteCreation(): Promise<void> {
    const remoteData = this.cleanFormData(this.remoteForm.value);
    const mountData = this.cleanFormData(this.remoteConfigForm.value);

    const finalConfig = {
      custom_flags: [],
      mount_options: {
        auto_mount: mountData.autoMount,
        mount_point: mountData.mountPath,
        ...this.parseJson(mountData.jsonConfigs?.mount),
      },
      vfs_options: this.parseJson(mountData.jsonConfigs?.vfs),
      copy_options: this.parseJson(mountData.jsonConfigs?.copy),
      sync_options: this.parseJson(mountData.jsonConfigs?.sync),
      filter_options: this.parseJson(mountData.jsonConfigs?.filter),
    };

    await this.rcloneService.createRemote(remoteData.name, remoteData);
    await this.settingsService.saveRemoteSettings(remoteData.name, finalConfig);

    console.log(
      `✅ Saved settings for remote: ${remoteData.name}`,
      finalConfig
    );
    this.dialogRef.close();
  }

  /** Helper function to safely parse JSON strings */
  private parseJson(data: any): any {
    try {
      return data ? (typeof data === "string" ? JSON.parse(data) : data) : {};
    } catch (error) {
      console.error("Failed to parse JSON:", data, error);
      return {};
    }
  }

  private cleanFormData(formData: any): any {
    return Object.entries(formData)
      .filter(([_, value]) => value !== null && value !== "")
      .reduce((acc, [key, value]) => ({ ...acc, [key]: value }), {});
  }

  ngOnDestroy(): void {
    this.dialogRef.close();
    this.cancelAuth();
    this.remoteForm.reset();
    this.remoteConfigForm.reset();
  }

  cancelAuth(): void {
    this.rcloneService.quitOAuth();
    this.isLoading.saving = false;
  }

  allowOnlyNumbers(event: KeyboardEvent): void {
    const charCode = event.key ? event.key.charCodeAt(0) : 0;
    if (charCode < 48 || charCode > 57) {
      event.preventDefault(); // ❌ Block non-numeric characters
    }
  }

  sanitizeNumberInput(fieldName: string): void {
    const value = this.remoteForm.get(fieldName)?.value;
    if (value && isNaN(value)) {
      this.remoteForm.get(fieldName)?.setValue("");
    }
  }

  nextStep(): void {
    if (this.currentStep < this.totalSteps && this.remoteForm.valid) {
      this.currentStep++;
    }
  }

  prevStep(): void {
    if (this.currentStep > 1) {
      this.currentStep--;
    }
  }

  @HostListener("document:keydown.escape", ["$event"])
  close(): void {
    this.dialogRef.close();
  }
}
