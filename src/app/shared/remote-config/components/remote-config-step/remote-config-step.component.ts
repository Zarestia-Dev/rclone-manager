import { Component, EventEmitter, Input, Output } from "@angular/core";
import { RemoteField, RemoteType, LinebreaksPipe } from "../../remote-config-types";
import { FormGroup, ReactiveFormsModule } from "@angular/forms";
import { MatProgressSpinnerModule } from "@angular/material/progress-spinner";
import { MatDividerModule } from "@angular/material/divider";
import { MatCardModule } from "@angular/material/card";
import { MatSlideToggleModule } from "@angular/material/slide-toggle";
import { MatInputModule } from "@angular/material/input";
import { MatSelectModule } from "@angular/material/select";
import { MatFormFieldModule } from "@angular/material/form-field";

import { SENSITIVE_KEYS } from "../../../components/types";

@Component({
  selector: "app-remote-config-step",
  imports: [
    ReactiveFormsModule,
    MatFormFieldModule,
    MatSelectModule,
    MatInputModule,
    MatSlideToggleModule,
    MatCardModule,
    MatDividerModule,
    MatProgressSpinnerModule,
    LinebreaksPipe
],
  templateUrl: "./remote-config-step.component.html",
  styleUrl: "./remote-config-step.component.scss",
})
export class RemoteConfigStepComponent {
  @Input() form!: FormGroup;
  @Input() remoteFields: RemoteField[] = [];
  @Input() remoteTypes: RemoteType[] = [];
  @Input() isLoading = false;
  @Input() existingRemotes: string[] = [];
  @Input() restrictMode!: boolean;

  @Output() advancedOptionsToggled = new EventEmitter<boolean>();
  @Output() remoteTypeChanged = new EventEmitter<void>();

  showAdvancedOptions = false;

  get basicFields(): RemoteField[] {
    return this.remoteFields.filter((f) => !f.Advanced);
  }

  get advancedFields(): RemoteField[] {
    return this.remoteFields.filter((f) => f.Advanced);
  }

  toggleAdvancedOptions(): void {
    this.showAdvancedOptions = !this.showAdvancedOptions;
    this.advancedOptionsToggled.emit(this.showAdvancedOptions);
  }

  onRemoteTypeChange(): void {
    this.remoteTypeChanged.emit();
  }

  isSensitiveField(fieldName: string): boolean {    
    return SENSITIVE_KEYS.some((key) =>
      fieldName.toLowerCase().includes(key)
    ) && this.restrictMode;
  }

  allowOnlyNumbers(event: KeyboardEvent): void {
    const charCode = event.key ? event.key.charCodeAt(0) : 0;
    if (charCode < 48 || charCode > 57) {
      event.preventDefault();
    }
  }

  sanitizeNumberInput(fieldName: string): void {
    const value = this.form.get(fieldName)?.value;
    if (value && isNaN(value)) {
      this.form.get(fieldName)?.setValue("");
    }
  }
}
