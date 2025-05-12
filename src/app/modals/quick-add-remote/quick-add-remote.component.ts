import {
  Component,
  HostListener,
  OnInit,
  OnDestroy,
} from "@angular/core";
import {
  AbstractControl,
  FormBuilder,
  FormGroup,
  ReactiveFormsModule,
  ValidationErrors,
  Validators,
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
import { StateService } from "../../services/state.service";
import { MatButtonModule } from "@angular/material/button";
import { LoadingState, QuickAddForm, RemoteSettings, RemoteType } from "../../shared/remote-config-types";

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
    MatButtonModule
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
  quickAddForm: FormGroup;
  remoteTypes: RemoteType[] = [];
  existingRemotes: string[] = [];

  isLoading: LoadingState = {
    saving: false,
    authDisabled: false,
    cancelled: false,
  };

  private formSubscriptions: Subscription[] = [];
  private authSubscriptions: Subscription[] = [];

  constructor(
    private fb: FormBuilder,
    private dialogRef: MatDialogRef<QuickAddRemoteComponent>,
    private rcloneService: RcloneService,
    private settingsService: SettingsService,
    private stateService: StateService
  ) {
    this.quickAddForm = this.createQuickAddForm();
    this.setupFormListeners();
  }

  ngOnInit(): void {
    this.initializeComponent();
    this.setupAuthStateListeners();
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

  ngOnDestroy(): void {
    this.cleanupSubscriptions();
    this.cleanup();
  }

  private cleanupSubscriptions(): void {
    this.formSubscriptions.forEach((sub) => sub.unsubscribe());
    this.authSubscriptions.forEach((sub) => sub.unsubscribe());
    this.formSubscriptions = [];
    this.authSubscriptions = [];
  }

  private createQuickAddForm(): FormGroup {
    return this.fb.group({
      remoteName: [
        { value: "", disabled: this.isLoading.saving },
        [Validators.required, this.validateRemoteName.bind(this)],
      ],
      remoteType: [
        { value: "", disabled: this.isLoading.saving },
        Validators.required,
      ],
      autoMount: [{ value: false, disabled: this.isLoading.saving }],
      mountPath: [{ value: "", disabled: this.isLoading.saving }],
    });
  }

  private setupFormListeners(): void {
    const autoMountSub = this.quickAddForm
      .get("autoMount")
      ?.valueChanges.subscribe((autoMount: boolean) => {
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
      // [this.existingRemotes, this.oauthSupportedRemotes] = await Promise.all([
      //   this.rcloneService.getRemotes(),
      //   this.rcloneService.getOAuthSupportedRemotes(),
      // ]);
      const oauthSupportedRemotes = await this.rcloneService.getOAuthSupportedRemotes();
      console.log("OAuth Supported Remotes:", oauthSupportedRemotes);
      this.remoteTypes = oauthSupportedRemotes.map((remote: any) => ({
        value: remote.name,
        label: remote.description,
      }));
      this.existingRemotes = await this.rcloneService.getRemotes();
      console.log("OAuth Supported Remotes:", this.remoteTypes);
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
    if (this.quickAddForm.invalid || this.isLoading.saving) return;

    const formValue = this.quickAddForm.value as QuickAddForm;
    await this.stateService.startAuth(formValue.remoteName, false);

    try {
      await this.handleRemoteCreation(formValue);
      if (!this.isLoading.cancelled) {
        this.dialogRef.close(true);
      }
    } catch (error) {
      console.error("Error in onSubmit:", error);
    } finally {
      this.stateService.resetAuthState();
    }
  }

  private async handleRemoteCreation(formValue: QuickAddForm): Promise<void> {
    const { remoteName, remoteType, autoMount, mountPath } = formValue;

    await this.rcloneService.createRemote(remoteName, {
      name: remoteName,
      type: remoteType,
    });

    const remoteSettings: RemoteSettings = {
      name: remoteName,
      custom_flags: [],
      vfs_options: { CacheMode: "full", ChunkSize: "32M" },
      show_in_tray_menu: true,
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
    await this.stateService.cancelAuth();
  }

  private setFormState(disabled: boolean): void {
    disabled ? this.quickAddForm.disable() : this.quickAddForm.enable();
  }

  @HostListener("document:keydown.escape", ["$event"])
  close(): void {
    this.dialogRef.close();
  }

  private cleanup(): void {
    this.formSubscriptions.forEach((sub) => sub.unsubscribe());
    this.authSubscriptions.forEach((sub) => sub.unsubscribe());
    this.cancelAuth();
  }
}
