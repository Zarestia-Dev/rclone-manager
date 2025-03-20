import { Component, ElementRef, HostListener, Inject, Input, OnInit, ViewChild } from "@angular/core";
import { CommonModule } from "@angular/common";
import { animate, style, transition, trigger } from "@angular/animations";
import {
  FormBuilder,
  FormControl,
  FormGroup,
  ReactiveFormsModule,
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
import { MatChipInputEvent, MatChipsModule } from "@angular/material/chips";
import { MatTooltipModule } from "@angular/material/tooltip";

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
        MatTooltipModule
    ],
    templateUrl: "./remote-config-modal.component.html",
    styleUrl: "./remote-config-modal.component.scss",
    animations: [
        trigger("slideAnimation", [
            transition(":enter", [
                style({
                    transform: "translateX(100%)",
                    opacity: 0,
                    position: "absolute",
                    width: "100%",
                }),
                animate("300ms ease-in-out", style({ transform: "translateX(0)", opacity: 1 })),
            ]),
            transition(":leave", [
                animate("300ms ease-in-out", style({ transform: "translateX(-50%)", opacity: 0 })),
            ]),
        ]),
    ]
})
export class RemoteConfigModalComponent implements OnInit {
  @Input() editMode: boolean = false;
  @Input() editTarget: "remote" | "mount" | null = null;
  @Input() existingConfig: any = null;

  remoteForm: FormGroup;
  mountForm: FormGroup;
  currentStep: number = 2;

  remoteTypes: any[] = [];
  mountTypes: any[] = [];
  dynamicRemoteFields: any[] = [];
  dynamicMountFields: any[] = [];
  isLoadingRemoteConfig = false;
  isLoadingMountConfig = false;

  constructor(
    private fb: FormBuilder,
    private rcloneService: RcloneService,
    public dialogRef: MatDialogRef<RemoteConfigModalComponent>,
    @Inject(MAT_DIALOG_DATA) public data: any
  ) {
    this.editMode = data?.editMode || false;
    this.editTarget = data?.editTarget || null;
    this.existingConfig = data?.existingConfig || null;
    console.log("Existing config:", this.existingConfig);

    this.remoteForm = this.fb.group({
      name: ["", Validators.required],
      type: ["", Validators.required],
    });
    this.mountForm = this.fb.group({
      mountType: ["", Validators.required],
      mountPath: ["", Validators.required],
      jsonText: ["{}"], // Add jsonText control
    });
  }

  async ngOnInit(): Promise<void> {
    if (this.editMode && this.editTarget === "remote") {
      console.log("Editing existing config:", this.existingConfig);

      this.populateForm(this.existingConfig);
    }
    if (this.editMode && this.editTarget === "mount") {
      console.log("Editing existing mount config:", this.existingConfig);

      this.populateMountForm(this.existingConfig);
    }
    await this.loadRemoteTypes();
    await this.loadMountTypes();
  }

  selectFolder(): void {
    this.rcloneService.selectFolder().then((selectedPath) => {
      this.mountForm.get("mountPath")?.setValue(selectedPath);
    });
  }

  async loadRemoteTypes(): Promise<void> {
    try {
      const providers = await this.rcloneService.getRemoteTypes();
      this.remoteTypes = providers.map((provider: any) => ({
        value: provider.Name,
        label: provider.Name,
      }));
    } catch (error) {
      console.error("Failed to load remote types", error);
    }
  }

  async loadMountTypes(): Promise<void> {
    try {
      const response = await this.rcloneService.getMountTypes();
      this.mountTypes = [
        { value: "Native", label: "Native (Direct Mounting)" },
        { value: "Systemd", label: "Systemd Service Mounting" },
        ...response.map((type: string) => ({ value: type, label: type })),
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
    this.isLoadingRemoteConfig = true;
    try {
      const remoteType = this.remoteForm.get("type")?.value;
      const response = await this.rcloneService.getRemoteConfigFields(
        remoteType
      );

      console.log("Remote type config:", response);

      // ✅ Reset form and ensure 'type' & 'name' fields exist
      this.remoteForm = this.fb.group({
        name: this.fb.control("", [Validators.required]),
        type: this.fb.control(remoteType, [Validators.required]),
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
      this.isLoadingRemoteConfig = false;
    }
  }

  /** Generate form controls dynamically */
  generateFormControls(): void {
    this.dynamicRemoteFields.forEach((field) => {
      this.remoteForm.addControl(
        field.name,
        this.fb.control(
          this.existingConfig?.[field.name] || "",
          field.required ? Validators.required : []
        )
      );
    });
  }

  /** Fetch mount configuration fields dynamically */
  async onMountTypeChange(): Promise<void> {
    const selectedMountType = this.mountForm.get("mountType")?.value;
    if (!selectedMountType) return;
  
    this.isLoadingMountConfig = true;
    try {
      const mountOptions = await this.rcloneService.getMountFlags();
  
      // ✅ Filter and map mount options dynamically
      this.dynamicMountFields = mountOptions
        .filter((option: any) => option.Groups === "Mount") // Process only Mount options
        .map((field: any) => ({
          name: field.FieldName || field.Name, // Ensure field name
          default: field.Default || null,
          help: field.Help || "No description available",
          type: field.Type || "string", // Default to "string" if no type
          required: field.Required || false,
          examples: field.Examples || [],
        }));
  
      this.generateMountFormControls();
    } catch (error) {
      console.error("Error fetching mount config fields:", error);
    } finally {
      this.isLoadingMountConfig = false;
    }
  }
  /** Object holding selected options */
  selectedOptions: Record<string, any> = {};

  /** Error message if JSON is invalid */
  jsonError: string | null = null;

  /** Reference to the textarea element */
  @ViewChild('jsonArea') jsonArea!: ElementRef<HTMLTextAreaElement>;

  /** Add/remove option when a chip is selected */
  addOption(field: any): void {
    if (this.selectedOptions[field.name]) {
      delete this.selectedOptions[field.name]; // Unselect on second click
    } else {
      this.selectedOptions[field.name] = field.default ?? ""; // Add with default value
    }

    // Update JSON display & auto-resize
    this.updateJsonDisplay();
  }

  /** Update JSON string */
  updateJsonDisplay(): void {
    const jsonStr = JSON.stringify(this.selectedOptions, null, 2);
    this.mountForm.get('jsonText')?.setValue(jsonStr);
    this.autoResize();
  }

  /** Validate JSON input */
  validateJson(): void {
    try {
      this.selectedOptions = JSON.parse(this.mountForm.get('jsonText')?.value || "{}");
      this.jsonError = null;
      this.autoResize();
    } catch (error) {
      this.jsonError = "Invalid JSON format!";
    }
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
  this.dynamicMountFields.forEach((field) => {
    const validators = field.required ? [Validators.required] : [];

    let defaultValue: any = null;
    
    if (field.Type === "bool") {
      defaultValue = field.Value !== null ? field.Value : field.Default;
    } else if (field.Type === "stringArray") {
      defaultValue = field.Value || field.Default || []; // Use array for multi-select
    } else if (field.examples.length > 0) {
      defaultValue = field.ValueStr || field.DefaultStr || field.examples[0].Value;
    } else if (['int', 'SizeSuffix', 'bits'].includes(field.Type)) {
      defaultValue = field.Value !== null ? field.Value : field.Default;
    } else {
      defaultValue = field.ValueStr || field.DefaultStr || "";
    }

    // ✅ Add control to form, keeping default values intact
    this.mountForm.addControl(field.name, this.fb.control(defaultValue, validators));
  });
}


  /** Populate form when editing an existing remote */
  populateForm(config: any = {}): void {
    Object.keys(config).forEach((key) => {
      if (this.remoteForm.contains(key)) {
        this.remoteForm.get(key)?.setValue(config[key]);
      } else {
        this.remoteForm.addControl(key, this.fb.control(config[key] || ""));
      }
    });

    this.onRemoteTypeChange(); // Fetch dynamic fields if remote type changes
  }

  /** Populate mount form when editing an existing mount */
  populateMountForm(config: any = {}): void {
    if (!config) {
      this.mountForm = this.fb.group({
        mountType: ["", Validators.required],
        mountPath: ["", Validators.required],
      });

      this.dynamicMountFields = [];
      this.generateMountFormControls();
      return;
    }

    // Ensure we switch to the mount step
    if (this.editTarget === "mount") {
      this.currentStep = 2;
    }

    console.log("Populating Mount Form with config:", config);

    // Ensure mountSpecs exists and extract data safely
    const mountSpecs = config.mountSpecs || {};
    const options = mountSpecs.options || {};

    // Set static fields first
    this.mountForm.patchValue({
      mountType: mountSpecs.mountType || "Native",
      mountPath: mountSpecs.mountPath || config.mount_path || "",
    });

    // Handle dynamic mount options
    Object.keys(options).forEach((key) => {
      if (!this.mountForm.contains(key)) {
        this.mountForm.addControl(key, this.fb.control(options[key] || ""));
      } else {
        this.mountForm.get(key)?.setValue(options[key]);
      }
    });

    this.onMountTypeChange(); // Fetch mount options dynamically
  }

  nextStep(): void {
    if (this.remoteForm.valid) {
      this.currentStep = 2;
    }
  }

  prevStep(): void {
    this.currentStep = 1;
  }

  @HostListener("document:keydown.escape", ["$event"])
  close(): void {
    this.dialogRef.close();
  }

  async onSubmit(): Promise<void> {
    if (this.editTarget === "remote" && !this.remoteForm.valid) {
      console.error("Remote form is invalid");
      return;
    }
    if (this.editTarget === "mount" && !this.mountForm.valid) {
      console.error("Mount form is invalid");
      return;
    }

    const remoteData = this.cleanFormData(this.remoteForm.value);
    const mountData = this.cleanFormData(this.mountForm.value);

    try {
      if (this.editMode) {
        console.log("Editing mode detected");

        if (this.editTarget === "remote") {
          console.log("Updating remote:", remoteData);
          await this.rcloneService.updateRemote(remoteData.name, remoteData);
        } else if (this.editTarget === "mount") {
          console.log("Updating mount:", mountData);

          const remoteName =
            remoteData.name || this.existingConfig?.remoteSpecs?.name;
          if (remoteName) {
            await this.rcloneService.saveMountConfig(
              remoteName,
              mountData.mountPath,
              mountData
            );
          } else {
            console.error("Remote name is undefined");
          }
        }
      } else {
        console.log("Adding new remote:", remoteData);
        await this.rcloneService.createRemote(remoteData.name, remoteData);

        console.log("Saving mount configuration:", mountData);
        await this.rcloneService.saveMountConfig(
          remoteData.name,
          mountData.mountPath,
          mountData
        );
      }

      console.log("Configuration saved successfully!");
      this.dialogRef.close({ remoteSpecs: remoteData, mountSpecs: mountData });
    } catch (error) {
      console.error("Failed to save configuration:", error);
    }
  }

  ngOnDestroy(): void {
    this.dialogRef.close();
    this.remoteForm.reset();
    this.mountForm.reset();
  }

  private cleanFormData(formData: any): any {
    return Object.keys(formData)
      .filter((key) => formData[key] !== null && formData[key] !== "")
      .reduce((acc: { [key: string]: any }, key: string) => {
        acc[key] = formData[key];
        return acc;
      }, {});
  }

  allowOnlyNumbers(event: KeyboardEvent) {
    const charCode = event.key ? event.key.charCodeAt(0) : 0;
    if (charCode < 48 || charCode > 57) {
      event.preventDefault(); // ❌ Block non-numeric characters
    }
  }
  
  sanitizeNumberInput(fieldName: string) {
    const value = this.remoteForm.get(fieldName)?.value;
    if (value && isNaN(value)) {
      this.remoteForm.get(fieldName)?.setValue('');
    }
  }
}
