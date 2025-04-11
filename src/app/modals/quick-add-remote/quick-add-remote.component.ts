import { Component, HostListener, OnInit } from "@angular/core";
import {
  AbstractControl,
  FormBuilder,
  FormGroup,
  ReactiveFormsModule,
  ValidationErrors,
  Validators,
} from "@angular/forms";
import { RcloneService } from "../../services/rclone.service";
import { CommonModule } from "@angular/common";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatSelectModule } from "@angular/material/select";
import { MatInputModule } from "@angular/material/input";
import { MatDialogRef } from "@angular/material/dialog";
import { MatDividerModule } from "@angular/material/divider";
import { MatSlideToggleModule } from "@angular/material/slide-toggle";
import { SettingsService } from "../../services/settings.service";
import { animate, style, transition, trigger } from "@angular/animations";
import { MatProgressSpinnerModule } from "@angular/material/progress-spinner";
import { MatIconModule } from "@angular/material/icon";

@Component({
  selector: "app-quick-add-remote",
  imports: [
    CommonModule,
    MatFormFieldModule,
    ReactiveFormsModule,
    MatInputModule,
    MatSelectModule,
    MatDividerModule,
    MatSlideToggleModule,
    MatProgressSpinnerModule,
    MatIconModule,
  ],
  templateUrl: "./quick-add-remote.component.html",
  styleUrl: "./quick-add-remote.component.scss",
  animations: [
    trigger("slideInOut", [
      transition(":enter", [
        style({ height: "0px", opacity: 0 }),
        animate("200ms ease-out", style({ height: "*", opacity: 1 })),
      ]),
      transition(":leave", [
        animate("200ms ease-in", style({ height: "0px", opacity: 0 })),
      ]),
    ]),
  ],
})
export class QuickAddRemoteComponent implements OnInit {
  quickAddForm: FormGroup;
  oauthSupportedRemotes: string[] = [];
  existingRemotes: string[] = [];
  isLoading = false;
  authDisabled = false;
  cancelced = false;

  constructor(
    private fb: FormBuilder,
    private rcloneService: RcloneService,
    private dialogRef: MatDialogRef<QuickAddRemoteComponent>,
    private settingsService: SettingsService
  ) {
    // ✅ Initialize the form with validators
    this.quickAddForm = this.fb.group({
      remoteName: [
        { value: "", disabled: this.isLoading },
        [Validators.required, this.validateRemoteName.bind(this)],
      ],
      remoteType: [
        { value: "", disabled: this.isLoading },
        Validators.required,
      ],
      autoMount: [{ value: false, disabled: this.isLoading }], // Default disabled
      mountPath: [{ value: "", disabled: this.isLoading }], // Initially not required
    });

    // ✅ Automatically toggle mountPath validation based on autoMount
    this.quickAddForm
      .get("autoMount")
      ?.valueChanges.subscribe((autoMount: boolean) => {
        const mountPathControl = this.quickAddForm.get("mountPath");
        if (autoMount) {
          mountPathControl?.setValidators([Validators.required]);
        } else {
          mountPathControl?.clearValidators();
        }
        mountPathControl?.updateValueAndValidity();
      });
  }

  async ngOnInit() {
    try {
      // ✅ Load existing remotes to prevent conflicts
      this.existingRemotes = await this.rcloneService.getRemotes();
      console.log("Loaded existing remotes:", this.existingRemotes);

      // ✅ Fetch OAuth-supported remotes
      this.oauthSupportedRemotes =
        await this.rcloneService.getOAuthSupportedRemotes();
      console.log("OAuth-supported remotes:", this.oauthSupportedRemotes);
    } catch (error) {
      console.error("Error loading remote data:", error);
    }
  }

  /** ✅ Custom Validator: Prevent duplicate remote names */
  validateRemoteName(control: AbstractControl): ValidationErrors | null {
    const value = control.value?.trim();
    if (!value) return null; // Skip empty validation
    return this.existingRemotes.includes(value) ? { nameTaken: true } : null;
  }

  /** 📌 Handle Remote Type Selection */
  onRemoteTypeChange() {
    const selectedRemote = this.quickAddForm.get("remoteType")?.value;
    if (!selectedRemote) return;

    // ✅ Generate a unique remote name (e.g., "GoogleDrive-1")
    let baseName = selectedRemote.replace(/\s+/g, "");
    let newName = baseName;
    let counter = 1;

    while (this.existingRemotes.includes(newName)) {
      newName = `${baseName}-${counter}`;
      counter++;
    }

    this.quickAddForm.patchValue({ remoteName: newName });
  }

  /** 📂 Select Folder for Mount Path */
  async selectFolder(): Promise<void> {
    const selectedPath = await this.rcloneService.selectFolder(true);
    if (selectedPath) {
      this.quickAddForm.patchValue({ mountPath: selectedPath });
    }
  }

  /** 📌 Handle Quick Add Submission */
  async onSubmit() {
    if (this.quickAddForm.invalid) return;

    this.isLoading = true;

    try {
      const { remoteName, remoteType, autoMount, mountPath } =
        this.quickAddForm.value;

      // ✅ Prepare remote config
      const remoteConfig = {
        name: remoteName,
        type: remoteType,
      };

      this.setFormState(true); // Disable form fields
      // ✅ Create Remote
      await this.rcloneService.createRemote(remoteName, remoteConfig);

      // ✅ Save Remote-Specific Settings (Need to add the settings for editeable default quick remote settings.)
      const remoteSettings = {
        name: remoteName,
        custom_flags: [], // Empty array for now (user can customize later)
        vfs_options: { cache_mode: "full", chunk_size: "32M" },
        mount_options: {
          mount_point: mountPath || "",
          auto_mount: autoMount || false,
        },
      };

      await this.settingsService.saveRemoteSettings(remoteName, remoteSettings);
      console.log(`✅ Saved settings for remote: ${remoteName}`);

      // ✅ Auto-mount if enabled
      if (autoMount && mountPath) {
        // await this.rcloneService.mountRemote();
        console.log("Remote mounted successfully!");
      }
      this.isLoading = false;
    } catch (error) {
      console.error("Error adding remote:", error);
    } finally {
      if (!this.cancelced) {
        this.setFormState(false); // Re-enable form fields
        this.dialogRef.close(true); // Close modal and return success
      }
      this.isLoading = false; // Reset loading state
      this.cancelced = false; // Reset cancellation state
    }
  }

  async cancelAuth() {
    this.isLoading = false;
    this.setFormState(false);
    this.cancelced = true;
    try {
      this.authDisabled = true;
      await this.rcloneService.quitOAuth();
    }
    catch (error) {
      console.error("Error during OAuth cancellation:", error);
    }
    finally {
      this.authDisabled = false;
    }
  }

  setFormState(disabled: boolean) {
    if (disabled) {
      this.quickAddForm.disable(); // 🚀 Disables all form fields
    } else {
      this.quickAddForm.enable(); // ✅ Enables all form fields
    }
  }

  /** ✅ Handle closing modal with ESC */
  @HostListener("document:keydown.escape", ["$event"])
  close(): void {
    this.dialogRef.close();
  }

  /** ✅ Ensure cleanup on modal close */
  ngOnDestroy() {
    this.rcloneService.quitOAuth();
  }
}
