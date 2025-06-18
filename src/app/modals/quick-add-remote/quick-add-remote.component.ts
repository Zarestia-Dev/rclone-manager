import { Component, HostListener, OnInit, OnDestroy } from "@angular/core";
import {
  AbstractControl,
  FormBuilder,
  FormGroup,
  ReactiveFormsModule,
  ValidationErrors,
  Validators,
} from "@angular/forms";

import { MatDialogRef } from "@angular/material/dialog";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatSelectModule } from "@angular/material/select";
import { MatInputModule } from "@angular/material/input";
import { MatDividerModule } from "@angular/material/divider";
import { MatProgressSpinnerModule } from "@angular/material/progress-spinner";
import { MatIconModule } from "@angular/material/icon";
import { MatExpansionModule } from "@angular/material/expansion";
import { animate, style, transition, trigger } from "@angular/animations";
import { RcloneService } from "../../services/rclone.service";
import { SettingsService } from "../../services/settings.service";
import { Subscription } from "rxjs";
import { StateService } from "../../services/state.service";
import { MatButtonModule } from "@angular/material/button";
import {
  LoadingState,
  QuickAddForm,
  RemoteSettings,
  RemoteType,
} from "../../shared/remote-config/remote-config-types";
import { MatCheckboxModule } from "@angular/material/checkbox";

@Component({
  selector: "app-quick-add-remote",
  standalone: true,
  imports: [
    ReactiveFormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatDividerModule,
    MatCheckboxModule,
    MatProgressSpinnerModule,
    MatIconModule,
    MatButtonModule,
    MatExpansionModule
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
      // Mount options
      autoMount: [{ value: false, disabled: this.isLoading.saving }],
      mountSource: [{ value: "", disabled: this.isLoading.saving }],
      mountPath: [{ value: "", disabled: this.isLoading.saving }],
      // Sync options
      autoSync: [{ value: false, disabled: this.isLoading.saving }],
      syncSource: [{ value: "", disabled: this.isLoading.saving }],
      syncDest: [{ value: "", disabled: this.isLoading.saving }],
      // Copy options
      autoCopy: [{ value: false, disabled: this.isLoading.saving }],
      copySource: [{ value: "", disabled: this.isLoading.saving }],
      copyDest: [{ value: "", disabled: this.isLoading.saving }],
    });
  }

  private setupFormListeners(): void {
    // Mount path validation - only destination required
    const autoMountSub = this.quickAddForm
      .get("autoMount")
      ?.valueChanges.subscribe((autoMount: boolean) => {
        const mountPathControl = this.quickAddForm.get("mountPath");
        autoMount
          ? mountPathControl?.setValidators([Validators.required])
          : mountPathControl?.clearValidators();
        mountPathControl?.updateValueAndValidity();
      });

    // Sync validation - only destination required
    const autoSyncSub = this.quickAddForm
      .get("autoSync")
      ?.valueChanges.subscribe((autoSync: boolean) => {
        const syncDestControl = this.quickAddForm.get("syncDest");
        
        if (autoSync) {
          syncDestControl?.setValidators([Validators.required]);
        } else {
          syncDestControl?.clearValidators();
        }
        
        syncDestControl?.updateValueAndValidity();
      });

    // Copy validation - only destination required
    const autoCopySub = this.quickAddForm
      .get("autoCopy")
      ?.valueChanges.subscribe((autoCopy: boolean) => {
        const copyDestControl = this.quickAddForm.get("copyDest");
        
        if (autoCopy) {
          copyDestControl?.setValidators([Validators.required]);
        } else {
          copyDestControl?.clearValidators();
        }
        
        copyDestControl?.updateValueAndValidity();
      });

    if (autoMountSub) this.formSubscriptions.push(autoMountSub);
    if (autoSyncSub) this.formSubscriptions.push(autoSyncSub);
    if (autoCopySub) this.formSubscriptions.push(autoCopySub);
  }

  private async initializeComponent(): Promise<void> {
    try {
      const oauthSupportedRemotes =
        await this.rcloneService.getOAuthSupportedRemotes();
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

  async selectFolder(fieldName: string = 'mountPath'): Promise<void> {
    try {
      const selectedPath = await this.rcloneService.selectFolder(true);
      if (selectedPath) {
        this.quickAddForm.patchValue({ [fieldName]: selectedPath });
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
    const { remoteName, remoteType, autoMount, mountSource, mountPath, autoSync, syncSource, syncDest, autoCopy, copySource, copyDest } = formValue;

    await this.rcloneService.createRemote(remoteName, {
      name: remoteName,
      type: remoteType,
    });

    const remoteSettings: RemoteSettings = {
      name: remoteName,
      vfsConfig: { CacheMode: "full", ChunkSize: "32M" },
      showOnTray: true,
      mountConfig: {
        dest: mountPath || "",
        source: mountSource || remoteName + ":/",
        autoStart: autoMount || false,
      },
      copyConfig: {
        autoStart: autoCopy || false,
        source: copySource || remoteName + ":/",
        dest: copyDest || "",
      },
      syncConfig: {
        autoStart: autoSync || false,
        source: syncSource || remoteName + ":/",
        dest: syncDest || "",
      },
      filterConfig: {},
    };

    await this.settingsService.saveRemoteSettings(remoteName, remoteSettings);

    // Auto-start operations based on user selections
    if (autoMount && mountPath) {
      const finalMountSource = mountSource || remoteName + ":/";
      await this.rcloneService.mountRemote(remoteName, finalMountSource, mountPath);
      console.log("Remote mounted successfully!");
    }

    if (autoSync && syncDest) {
      // Note: You may need to implement auto-sync starting logic
      const finalSyncSource = syncSource || remoteName + ":/";
      await this.rcloneService.startSync(remoteName, finalSyncSource, syncDest);
      console.log("Auto-sync configured for:", { source: finalSyncSource, dest: syncDest });
    }

    if (autoCopy && copyDest) {
      // Note: You may need to implement auto-copy starting logic
      const finalCopySource = copySource || remoteName + ":/";
      await this.rcloneService.startCopy(remoteName, finalCopySource, copyDest);
      console.log("Auto-copy configured for:", { source: finalCopySource, dest: copyDest });
    }
  }

  async cancelAuth(): Promise<void> {
    await this.stateService.cancelAuth();
  }

  private setFormState(disabled: boolean): void {
    disabled ? this.quickAddForm.disable() : this.quickAddForm.enable();
  }

  getSubmitButtonText(): string {
    if (this.isLoading.saving && !this.isLoading.cancelled) {
      return 'Adding Remote...';
    }
    return 'Create Remote';
  }

  onPanelToggle(operation: 'mount' | 'sync' | 'copy', isOpen: boolean): void {
    const controlName = `auto${operation.charAt(0).toUpperCase() + operation.slice(1)}`;
    this.quickAddForm.patchValue({ [controlName]: isOpen });
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
