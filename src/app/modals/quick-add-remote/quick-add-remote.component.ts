import { 
  Component, 
  HostListener, 
  OnInit, 
  OnDestroy, 
  inject 
} from "@angular/core";
import { 
  AbstractControl, 
  FormBuilder, 
  FormGroup, 
  ReactiveFormsModule, 
  ValidationErrors, 
  Validators 
} from "@angular/forms";
import { CommonModule } from "@angular/common";
import { MatDialogRef } from "@angular/material/dialog";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatSelectModule } from "@angular/material/select";
import { MatInputModule } from "@angular/material/input";
import { MatDividerModule } from "@angular/material/divider";
import { MatSlideToggleModule } from "@angular/material/slide-toggle";
import { MatProgressSpinnerModule } from "@angular/material/progress-spinner";
import { MatIconModule } from "@angular/material/icon";
import { animate, style, transition, trigger } from "@angular/animations";
import { RcloneService } from "../../services/rclone.service";
import { SettingsService } from "../../services/settings.service";
import { Subscription } from "rxjs";

interface QuickAddForm {
  remoteName: string;
  remoteType: string;
  autoMount: boolean;
  mountPath: string;
}

interface RemoteSettings {
  name: string;
  custom_flags: string[];
  vfs_options: {
    cache_mode: string;
    chunk_size: string;
  };
  mount_options: {
    mount_point: string;
    auto_mount: boolean;
  };
}

@Component({
  selector: "app-quick-add-remote",
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatDividerModule,
    MatSlideToggleModule,
    MatProgressSpinnerModule,
    MatIconModule,
  ],
  templateUrl: "./quick-add-remote.component.html",
  styleUrls: ["./quick-add-remote.component.scss"],
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
export class QuickAddRemoteComponent implements OnInit, OnDestroy {
  private fb = inject(FormBuilder);
  private rcloneService = inject(RcloneService);
  private settingsService = inject(SettingsService);
  private dialogRef = inject(MatDialogRef<QuickAddRemoteComponent>);

  quickAddForm: FormGroup;
  oauthSupportedRemotes: string[] = [];
  existingRemotes: string[] = [];
  isLoading = false;
  authDisabled = false;
  cancelled = false;
  private formSubscriptions: Subscription[] = [];

  constructor() {
    this.quickAddForm = this.createQuickAddForm();
    this.setupFormListeners();
  }

  ngOnInit(): void {
    this.initializeComponent();
  }

  ngOnDestroy(): void {
    this.cleanup();
  }

  private createQuickAddForm(): FormGroup {
    return this.fb.group({
      remoteName: [
        { value: "", disabled: this.isLoading },
        [Validators.required, this.validateRemoteName.bind(this)],
      ],
      remoteType: [
        { value: "", disabled: this.isLoading },
        Validators.required,
      ],
      autoMount: [{ value: false, disabled: this.isLoading }],
      mountPath: [{ value: "", disabled: this.isLoading }],
    });
  }

  private setupFormListeners(): void {
    const autoMountSub = this.quickAddForm.get("autoMount")?.valueChanges
      .subscribe((autoMount: boolean) => {
        const mountPathControl = this.quickAddForm.get("mountPath");
        autoMount 
          ? mountPathControl?.setValidators([Validators.required])
          : mountPathControl?.clearValidators();
        mountPathControl?.updateValueAndValidity();
      });
    
    if (autoMountSub) {
      this.formSubscriptions.push(autoMountSub);
    }
  }

  private async initializeComponent(): Promise<void> {
    try {
      [this.existingRemotes, this.oauthSupportedRemotes] = await Promise.all([
        this.rcloneService.getRemotes(),
        this.rcloneService.getOAuthSupportedRemotes()
      ]);
    } catch (error) {
      console.error("Error initializing component:", error);
    }
  }

  validateRemoteName(control: AbstractControl): ValidationErrors | null {
    const value = control.value?.trim();
    if (!value) return null;
    return this.existingRemotes.includes(value) ? { nameTaken: true } : null;
  }

  onRemoteTypeChange(): void {
    const selectedRemote = this.quickAddForm.get("remoteType")?.value;
    if (!selectedRemote) return;

    const baseName = selectedRemote.replace(/\s+/g, "");
    let newName = baseName;
    let counter = 1;

    while (this.existingRemotes.includes(newName)) {
      newName = `${baseName}-${counter}`;
      counter++;
    }

    this.quickAddForm.patchValue({ remoteName: newName });
  }

  async selectFolder(): Promise<void> {
    try {
      const selectedPath = await this.rcloneService.selectFolder(true);
      if (selectedPath) {
        this.quickAddForm.patchValue({ mountPath: selectedPath });
      }
    } catch (error) {
      console.error("Error selecting folder:", error);
    }
  }

  async onSubmit(): Promise<void> {
    if (this.quickAddForm.invalid || this.isLoading) return;

    this.isLoading = true;
    this.cancelled = false;

    try {
      const formValue = this.quickAddForm.value as QuickAddForm;
      await this.handleRemoteCreation(formValue);
      
      if (!this.cancelled) {
        this.dialogRef.close(true);
      }
    } catch (error) {
      console.error("Error in onSubmit:", error);
    } finally {
      this.isLoading = false;
    }
  }

  private async handleRemoteCreation(formValue: QuickAddForm): Promise<void> {
    const { remoteName, remoteType, autoMount, mountPath } = formValue;

    await this.rcloneService.createRemote(remoteName, {
      name: remoteName,
      type: remoteType
    });

    const remoteSettings: RemoteSettings = {
      name: remoteName,
      custom_flags: [],
      vfs_options: { cache_mode: "full", chunk_size: "32M" },
      mount_options: {
        mount_point: mountPath || "",
        auto_mount: autoMount || false,
      },
    };

    await this.settingsService.saveRemoteSettings(remoteName, remoteSettings);

    if (autoMount && mountPath) {
      await this.rcloneService.mountRemote(remoteName, mountPath);
      console.log("Remote mounted successfully!");
    }
  }

  async cancelAuth(): Promise<void> {
    this.isLoading = false;
    this.cancelled = true;
    this.authDisabled = true;

    try {
      await this.rcloneService.quitOAuth();
    } catch (error) {
      console.error("Error during OAuth cancellation:", error);
    } finally {
      this.authDisabled = false;
      this.setFormState(false);
    }
  }

  private setFormState(disabled: boolean): void {
    disabled ? this.quickAddForm.disable() : this.quickAddForm.enable();
  }

  @HostListener("document:keydown.escape", ["$event"])
  close(): void {
    this.dialogRef.close();
  }

  private cleanup(): void {
    this.formSubscriptions.forEach(sub => sub.unsubscribe());
    this.rcloneService.quitOAuth();
  }
}