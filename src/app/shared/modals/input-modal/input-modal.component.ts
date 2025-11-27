import { Component, HostListener, inject, OnInit } from '@angular/core';
import { MatDialogRef, MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import {
  FormsModule,
  ReactiveFormsModule,
  FormControl,
  Validators,
  AbstractControl,
  ValidationErrors,
} from '@angular/forms';

export interface InputModalData {
  title?: string;
  label?: string;
  icon?: string;
  placeholder?: string;
  initialValue?: string;
  existingNames?: string[]; // used for uniqueness validation
  /** Human readable type for existing names (e.g. 'Folder', 'File', 'Remote') */
  existingNameType?: string;
  createLabel?: string;
  forbiddenCharsMessage?: string;
}

@Component({
  selector: 'app-input-modal',
  standalone: true,
  imports: [
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    FormsModule,
    ReactiveFormsModule,
  ],
  templateUrl: './input-modal.component.html',
  styleUrls: ['./input-modal.component.scss', '../../../styles/_shared-modal.scss'],
})
export class InputModalComponent implements OnInit {
  public dialogRef = inject(MatDialogRef<InputModalComponent>);
  public data = inject<InputModalData>(MAT_DIALOG_DATA);

  public nameControl = new FormControl('', {
    nonNullable: true,
    validators: [Validators.required, Validators.minLength(1)],
  });

  ngOnInit(): void {
    if (this.data.initialValue) this.nameControl.setValue(this.data.initialValue);
    // Add uniqueness validator if existingNames provided
    if (Array.isArray(this.data.existingNames)) {
      this.nameControl.addValidators(this.uniqueNameValidator.bind(this));
    }
    // Basic forbidden character validator: disallow '/' and ':' which conflict with rclone paths
    this.nameControl.addValidators(this.forbiddenCharsValidator.bind(this));
    this.nameControl.updateValueAndValidity();
  }

  @HostListener('document:keydown.escape')
  onEscapeKey(): void {
    this.dialogRef.close(null);
  }

  @HostListener('document:keydown.enter')
  onEnterKey(): void {
    if (this.nameControl.valid) this.onConfirm();
  }

  uniqueNameValidator(control: AbstractControl): ValidationErrors | null {
    const existing = (this.data.existingNames || []).map(e => e.toString().trim().toLowerCase());
    const val = (control.value || '').toString().trim().toLowerCase();
    return existing.some(e => e === val) ? { alreadyExists: true } : null;
  }

  forbiddenCharsValidator(control: AbstractControl): ValidationErrors | null {
    const val = (control.value || '').toString();
    if (val.includes('/') || val.includes(':')) return { forbiddenChars: true };
    return null;
  }

  onConfirm(): void {
    const value = this.nameControl.value.trim();
    this.dialogRef.close(value);
  }

  onCancel(): void {
    this.dialogRef.close(null);
  }
}
