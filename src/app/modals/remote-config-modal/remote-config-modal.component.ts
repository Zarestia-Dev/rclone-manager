import { Component, HostListener, Inject, Input, OnInit } from "@angular/core";
import { CommonModule } from "@angular/common";
import { animate, style, transition, trigger } from "@angular/animations";
import {
  FormBuilder,
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

@Component({
  selector: "app-remote-config-modal",
  standalone: true,
  imports: [
    ReactiveFormsModule,
    CommonModule,
    MatSelectModule,
    MatFormFieldModule,
    MatDividerModule,
    MatProgressSpinnerModule,
    MatInputModule,
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
        animate(
          "300ms ease-in-out",
          style({ transform: "translateX(0)", opacity: 1 })
        ),
      ]),
      transition(":leave", [
        animate(
          "300ms ease-in-out",
          style({ transform: "translateX(-50%)", opacity: 0 })
        ),
      ]),
    ]),
  ],
})
export class RemoteConfigModalComponent implements OnInit {
  @Input() editMode: boolean = false;
  @Input() editTarget: "remote" | "mount" | null = null;
  @Input() existingConfig: any = null;

  remoteForm: FormGroup;
  mountForm: FormGroup;
  currentStep: number = 1;

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

    this.remoteForm = this.fb.group({
      name: ["", Validators.required],
      type: ["", Validators.required],
    });

    this.mountForm = this.fb.group({
      mountType: ["", Validators.required],
      mountPath: ["", Validators.required],
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
  /** Fetch remote configuration fields dynamically */
  async onRemoteTypeChange(): Promise<void> {
    const selectedRemoteType = this.remoteForm.get("type")?.value;
    if (!selectedRemoteType) return;

    try {
      const configFields = await this.rcloneService.getRemoteConfigFields(
        selectedRemoteType
      );

      this.dynamicRemoteFields = configFields.map((field: any) => ({
        name: field.Name,
        label: field.Help,
        type: field.Type || "string",
        required: field.Required || false,
      }));

      this.generateFormControls();
    } catch (error) {
      console.error("Error fetching remote config fields:", error);
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

  /** Fetch mount configuration fields dynamically */
  async onMountTypeChange(): Promise<void> {
    const selectedMountType = this.mountForm.get("mountType")?.value;
    if (!selectedMountType) return;

    this.isLoadingMountConfig = true;
    try {
      const mountOptions = await this.rcloneService.getMountOptions();

      // Process and store mount options dynamically
      this.dynamicMountFields = mountOptions
        .filter((option: any) => option.Groups === "Mount") // Only process Mount options
        .map((field: any) => ({
          name: field.Name || field.FieldName, // Ensure name is always present
          label: field.Help || "No description available",
          type: field.Type || "string", // Default to "string" if no type is given
          required: field.Required || false,
        }));

      this.generateMountFormControls();
    } catch (error) {
      console.error("Error fetching mount config fields:", error);
    } finally {
      this.isLoadingMountConfig = false;
    }
  }

  /** Generate form controls dynamically for mount options */
  generateMountFormControls(): void {
    this.dynamicMountFields.forEach((field) => {
      this.mountForm.addControl(
        field.name,
        this.fb.control(
          this.existingConfig?.[field.name] || "",
          field.required ? Validators.required : []
        )
      );
    });
  }

  /** Populate mount form when editing an existing mount */
  populateMountForm(config: any = {}): void {
    if (this.editTarget === "mount") {
      this.currentStep = 2;
    }
    if (!config) {
      this.mountForm = this.fb.group({
        mountType: ["", Validators.required],
      });

      this.dynamicMountFields = []; // Clear any existing dynamic fields
      this.generateMountFormControls(); // Generate default form controls

      return;
    }
    Object.keys(config).forEach((key) => {
      if (!this.mountForm.contains(key)) {
        this.mountForm.addControl(key, this.fb.control(config[key] || ""));
      } else {
        this.mountForm.get(key)?.setValue(config[key]);
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
          if (remoteData.name) {
            await this.rcloneService.saveMountConfig(remoteData.name, mountData.mountPath, mountData);
          } else {
            console.error("Remote name is undefined");
          }
        }
      } else {
        console.log("Adding new remote:", remoteData);
        await this.rcloneService.createRemote(remoteData.name, remoteData);
        
        console.log("Saving mount configuration:", mountData);
        await this.rcloneService.saveMountConfig(remoteData.name, mountData.mountPath, mountData);
      }
  
      console.log("Configuration saved successfully!");
      this.dialogRef.close({ remoteSpecs: remoteData, mountSpecs: mountData });
    } catch (error) {
      console.error("Failed to save configuration:", error);
    }
  }

  private cleanFormData(formData: any): any {
    return Object.keys(formData)
      .filter(key => formData[key] !== null && formData[key] !== "")
      .reduce((acc: { [key: string]: any }, key: string) => {
        acc[key] = formData[key];
        return acc;
      }, {});
  }
  
}
