
import { Component, HostListener, Inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { MAT_DIALOG_DATA, MatDialogRef } from "@angular/material/dialog";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatIconModule } from "@angular/material/icon";
import { MatInputModule } from "@angular/material/input";
import { MatSelectModule } from "@angular/material/select";
import { RcloneService } from "../../services/rclone.service";
import { MatButtonModule } from "@angular/material/button";

export type InputField = {
  name: string;
  label: string;
  type: "text" | "password" | "number" | "select" | "folder";
  required: boolean;
  options?: string[]; // for select type
};

@Component({
  selector: "app-input-modal",
  imports: [
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    FormsModule,
    MatIconModule,
    MatButtonModule
],
  templateUrl: "./input-modal.component.html",
  styleUrl: "./input-modal.component.scss",
})
export class InputModalComponent {
  formData: Record<string, string> = {};

  constructor(
    public dialogRef: MatDialogRef<InputModalComponent>,
    private rcloneService: RcloneService,
    @Inject(MAT_DIALOG_DATA)
    public data: { title: string; description: string; fields: InputField[] }
  ) {}

  isFormValid(): boolean {
    return this.data.fields.every((field) => {
      if (field.required && !this.formData[field.name]) {
        return false;
      }
      if (field.type === "select" && field.options) {
        return field.options.includes(this.formData[field.name]);
      }
      return true;
    });
  }

  async selectFolder() {
    try {
      const selected = await this.rcloneService.selectFolder(false);
      this.formData["folder"] = selected;
    } catch (err) {
      console.error("Failed to select folder:", err);
    }
  }

  confirm(): void {
    this.dialogRef.close(this.formData);
  }

  @HostListener("document:keydown.escape", ["$event"])
  close(event?: KeyboardEvent) {
    this.dialogRef.close(undefined);
  }
}
