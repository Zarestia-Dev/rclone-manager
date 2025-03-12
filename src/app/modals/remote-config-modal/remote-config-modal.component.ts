import { Component, HostListener, Inject } from "@angular/core";
import { CommonModule } from "@angular/common";
import { animate, style, transition, trigger } from "@angular/animations";
import {
  FormBuilder,
  FormGroup,
  ReactiveFormsModule,
  Validators,
} from "@angular/forms";
import { MAT_DIALOG_DATA, MatDialogRef } from "@angular/material/dialog";
import { MatFormFieldModule, MatLabel } from "@angular/material/form-field";
import { MatSelectModule } from "@angular/material/select";
import {
  createRemoteInstance,
  RemoteModels,
} from "../../models/remote-config.model";
import { MatDividerModule } from "@angular/material/divider";
import { MatInputModule } from "@angular/material/input";
import {
  createMountInstance,
  MountModels,
} from "../../models/mount-config.model";

@Component({
  selector: "app-remote-config-modal",
  standalone: true,
  imports: [
    ReactiveFormsModule,
    CommonModule,
    MatSelectModule,
    MatLabel,
    MatFormFieldModule,
    MatDividerModule,
    MatInputModule,
  ],
  templateUrl: "./remote-config-modal.component.html",
  styleUrl: "./remote-config-modal.component.scss",
  animations: [
    trigger("slideAnimation", [
      transition(":enter", [
        style({ transform: "translateX(100%)", opacity: 0 }),
        animate(
          "300ms ease-in-out",
          style({ transform: "translateX(0)", opacity: 1 })
        ),
      ]),
      transition(":leave", [
        animate(
          "300ms ease-in-out",
          style({ transform: "translateX(-100%)", opacity: 0 })
        ),
      ]),
    ]),
  ],
})
export class RemoteConfigModalComponent {
  currentStep = 1;
  remoteForm: FormGroup;
  mountForm: FormGroup;

  remoteTypes = Object.keys(RemoteModels).map((key) => ({
    value: key,
    label: key,
  }));

  mountTypes = Object.keys(MountModels).map((key) => ({
    value: key,
    label: key,
  }));

  constructor(
    private fb: FormBuilder,
    public dialogRef: MatDialogRef<RemoteConfigModalComponent>,
    @Inject(MAT_DIALOG_DATA) public data: any
  ) {
    this.remoteForm = this.fb.group({
      remoteName: ["", Validators.required],
      remoteType: ["", Validators.required],
    });

    this.mountForm = this.fb.group({
      mountType: ["", Validators.required],
    });
  }

  onRemoteTypeChange(): void {
    const selectedRemoteType = this.remoteForm.get("remoteType")?.value;
    if (selectedRemoteType) {
      this.addRemoteSpecificFields(selectedRemoteType);
    }
  }

  onMountTypeChange(): void {
    const selectedMountType = this.mountForm.get("mountType")?.value;
    if (selectedMountType) {
      this.addMountSpecificFields(selectedMountType);
    }
  }

  addRemoteSpecificFields(remoteType: string): void {
    const remoteInstance = createRemoteInstance(remoteType);
    if (remoteInstance) {
      // Clear previously added fields to avoid duplicates
      this.removeDynamicFields("remote");

      // Dynamically add controls based on the remote instance
      const fields = Object.keys(remoteInstance).filter(
        (key) => key !== "name" && key !== "type"
      );
      fields.forEach((field) => {
        this.remoteForm.addControl(
          field,
          this.fb.control("", Validators.required)
        );
      });

      // Trigger change detection to update the view
      this.remoteForm.updateValueAndValidity();
    }
  }

  addMountSpecificFields(mountType: string): void {
    const mountInstance = createMountInstance(mountType);
    if (mountInstance) {
      // Clear previously added fields to avoid duplicates
      this.removeDynamicFields("mount");

      // Dynamically add controls based on the mount instance
      const fields = Object.keys(mountInstance).filter((key) => key !== "type");

      fields.forEach((field) => {
        this.mountForm.addControl(
          field,
          this.fb.control("", Validators.required)
        );
      });

      // Trigger change detection to update the view
      this.mountForm.updateValueAndValidity();
    }
  }

  removeDynamicFields(type: string): void {
    // Remove any dynamically added controls to reset the form
    if (type === "remote") {
      const fields = this.remoteForm.controls;
      for (const controlName in fields) {
        if (fields.hasOwnProperty(controlName)) {
          if (controlName !== "remoteName" && controlName !== "remoteType") {
            this.remoteForm.removeControl(controlName);
          }
        }
      }
    } else if (type === "mount") {
      const mountFields = this.mountForm.controls;
      for (const controlName in mountFields) {
        if (mountFields.hasOwnProperty(controlName)) {
          if (controlName !== "mountPoint" && controlName !== "mountType") {
            this.mountForm.removeControl(controlName);
          }
        }
      }
    }
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

  onSubmit(): void {
    if (this.mountForm.valid) {
      const data = {
        remoteConfig: this.remoteForm.value,
        mountOptions: this.mountForm.value,
      };
      console.log("Submitted Data:", data);
      this.dialogRef.close(data); // Pass the data back when closing the modal
    }
  }

  getDynamicFields(type: string): string[] {
    if (type === "remote") {
      const remoteType = this.remoteForm.get("remoteType")?.value;
      const remoteInstance = createRemoteInstance(remoteType);
      if (remoteInstance) {
        return Object.keys(remoteInstance).filter(
          (key) => key !== "name" && key !== "type"
        );
      }
      return [];
    } else if (type === "mount") {
      const mountType = this.mountForm.get("mountType")?.value;
      const mountInstance = createMountInstance(mountType);
      if (mountInstance) {
        return Object.keys(mountInstance).filter(
          (key) => key !== "path" && key !== "type"
        );
      }
      return [];
    }
    return [];
  }
}
