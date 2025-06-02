import { Component, EventEmitter, Input, Output } from "@angular/core";
import { FormGroup, ReactiveFormsModule } from "@angular/forms";
import {
  Entry,
  FlagField,
  FlagType,
  LinebreaksPipe,
} from "../../remote-config-types";
import { MatTooltipModule } from "@angular/material/tooltip";
import { MatIconModule } from "@angular/material/icon";
import { MatAutocompleteModule } from "@angular/material/autocomplete";
import { MatChipsModule } from "@angular/material/chips";
import { MatSlideToggleModule } from "@angular/material/slide-toggle";
import { MatInputModule } from "@angular/material/input";
import { MatFormFieldModule } from "@angular/material/form-field";
import { CommonModule } from "@angular/common";
import { MatButtonModule } from "@angular/material/button";
import { MatProgressSpinnerModule } from "@angular/material/progress-spinner";

@Component({
  selector: "app-flag-config-step",
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatSlideToggleModule,
    MatChipsModule,
    MatAutocompleteModule,
    MatProgressSpinnerModule,
    MatIconModule,
    MatTooltipModule,
    MatButtonModule,
    MatInputModule,
    LinebreaksPipe,
  ],
  templateUrl: "./flag-config-step.component.html",
  styleUrl: "./flag-config-step.component.scss",
})
export class FlagConfigStepComponent {
  @Input() form!: FormGroup;
  @Input() flagType!: FlagType;
  @Input() isEditMode = false;
  @Input() existingRemotes: string[] = [];
  @Input() pathState: Record<
    string,
    { remoteName: string; currentPath: string; options: Entry[] }
  > = {};
  @Input() sourceLoading: boolean = false;
  @Input() destLoading: boolean = false;
  @Input() dynamicFlagFields: FlagField[] = [];
  @Input() selectedOptions: Record<FlagType, Record<string, any>> = {
    mount: {},
    sync: {},
    copy: {},
    filter: {},
    vfs: {},
  };

  @Output() optionToggled = new EventEmitter<FlagField>();
  @Output() jsonValidated = new EventEmitter<void>();
  @Output() jsonReset = new EventEmitter<void>();
  @Output() remoteSelected = new EventEmitter<string>();
  @Output() destOptionSelected = new EventEmitter<string>();
  @Output() sourceOptionSelected = new EventEmitter<string>();
  @Output() folderSelected = new EventEmitter<
  {
    formPath: string;
    requiredEmpty: boolean;
  }
  >();
  @Output() remoteSelectionReset = new EventEmitter<string>();

  get configGroup(): FormGroup {
    return this.form.get(`${this.flagType}Config`) as FormGroup;
  }

  get isMount(): boolean {
    return this.flagType === "mount";
  }

  get isSync(): boolean {
    return this.flagType === "sync";
  }

  get isCopy(): boolean {
    return this.flagType === "copy";
  }

  get getDynamicFlagFields(): FlagField[] {
    return this.dynamicFlagFields;
  }

  get getSelectedOptions(): Record<FlagType, Record<string, any>> {
    return this.selectedOptions;
  }

  onToggleOption(field: FlagField): void {
    this.optionToggled.emit(field);
  }

  onValidateJson(): void {
    this.jsonValidated.emit();
  }

  onResetJson(): void {
    this.jsonReset.emit();
  }

  onRemoteSelected(remote: string): void {
    this.remoteSelected.emit(remote);
  }

  onDestOptionSelected(option: string): void {
    this.destOptionSelected.emit(option);
  }

  onSourceOptionSelected(option: string): void {
    this.sourceOptionSelected.emit(option);
  }

  onSelectFolder(formPath: string, requiredEmpty: boolean): void {
    this.folderSelected.emit({ formPath, requiredEmpty });
  }

  onResetRemoteSelection(formPath: string): void {
    this.remoteSelectionReset.emit(formPath);
  }
}
