import { Component, HostListener, OnInit } from "@angular/core";
import {
  FormBuilder,
  FormGroup,
  ReactiveFormsModule,
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
  ],
  templateUrl: "./quick-add-remote.component.html",
  styleUrl: "./quick-add-remote.component.scss",
})
export class QuickAddRemoteComponent implements OnInit {
  quickAddForm: FormGroup;
  oauthSupportedRemotes: any[] = [];
  isOAuthRequired = false;
  isLoading = false;
  errorMessage = "";

  constructor(
    private fb: FormBuilder,
    private rcloneService: RcloneService,
    private dialogRef: MatDialogRef<QuickAddRemoteComponent>,
    private settingsService: SettingsService
  ) {
    this.quickAddForm = this.fb.group({
      remoteName: [
        "",
        [Validators.required, Validators.pattern(/^[a-zA-Z0-9_-]+$/)],
      ],
      remoteType: ["", Validators.required],
      autoMount: false, // Default disabled
      mountPath: ["", []], // Initially not required
    });

    // Update mountPath validators based on autoMount value
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
      this.oauthSupportedRemotes =
        await this.rcloneService.getOAuthSupportedRemotes();
      // ✅ Filter only OAuth-supported remotes
      // this.oauthSupportedRemotes = allRemotes.filter(remote =>
      //   remote.Options.some((option: { Name: string; }) => option.Name === 'token')
      // );
      console.log("OAuth-supported remotes:", this.oauthSupportedRemotes);
    } catch (error) {
      console.error("Error fetching remote types:", error);
    }
  }

  /** 📌 Handle Remote Type Selection */
  onRemoteTypeChange() {
    const selectedRemote = this.quickAddForm.get("remoteType")?.value;

    if (!selectedRemote) return;

    // ✅ Auto-generate a Remote Name
    this.quickAddForm.patchValue({
      remoteName: `${selectedRemote.replace(/\s+/g, "")}-1`,
    });
  }

  selectFolder(): void {
    this.rcloneService.selectFolder().then((selectedPath) => {
      if (selectedPath) {
        this.quickAddForm.patchValue({ mountPath: selectedPath });
      }
    });
  }

  /** 📌 Handle Quick Add Submission */
  async onSubmit() {
    if (this.quickAddForm.invalid) return;

    this.isLoading = true;
    this.errorMessage = "";

    try {
      const { remoteName, remoteType, autoMount, mountPath } = this.quickAddForm.value;

      const remoteConfig = {
        name: remoteName,
        type: remoteType,
      };

      // ✅ Create Remote
      await this.rcloneService.createRemote(remoteName, remoteConfig);

    // ✅ Save Remote-Specific Settings
    const remoteSettings = {
      name: remoteName,
      mount_point: mountPath || "",
      auto_mount: autoMount || false,
      custom_flags: [], // Empty array for now (user can customize later)
      vfs_options: {
        cache_mode: "full",
        chunk_size: "32M",
      },
    };

    await this.settingsService.saveRemoteSettings(remoteName, remoteSettings);
    console.log(`✅ Saved settings for remote: ${remoteName}`);

      console.log("Remote added successfully!");
    } catch (error) {
      console.error("Error adding remote:", error);
      // this.errorMessage = error.message || 'Failed to add remote';
    } finally {

      const { remoteName, autoMount, mountPath } =
        this.quickAddForm.value;

      // ✅ Auto-mount the remote if enabled
      if (autoMount && mountPath) {
        try {
          
          await this.rcloneService.mountRemote(remoteName, mountPath);
          console.log("Remote mounted successfully!");
        }
        catch (error) {
          console.error("Error mounting remote:", error);
          // this.errorMessage = error.message || 'Failed to mount remote';
        }
      }
      this.isLoading = false;
      this.dialogRef.close();
    }
  }

  @HostListener("document:keydown.escape", ["$event"])
  close(): void {
    this.dialogRef.close();
    this.rcloneService.quitOAuth();
  }
}
