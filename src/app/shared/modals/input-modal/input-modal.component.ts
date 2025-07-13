import { Component, HostListener, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { InputField } from '../../components/types';
import { FileSystemService } from '../../../services/file-operations/file-system.service';

@Component({
  selector: 'app-input-modal',
  imports: [
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    FormsModule,
    MatIconModule,
    MatButtonModule,
  ],
  templateUrl: './input-modal.component.html',
  styleUrls: ['./input-modal.component.scss', '../../../styles/_shared-modal.scss'],
})
export class InputModalComponent {
  formData: Record<string, string> = {};
  fieldErrors: Record<string, string> = {};
  showPassword = false;

  public dialogRef = inject(MatDialogRef<InputModalComponent>);
  private fileSystemService = inject(FileSystemService);
  public data = inject<{ title: string; description: string; fields: InputField[] }>(
    MAT_DIALOG_DATA
  );

  constructor() {
    // Initialize form data with empty values
    this.data.fields.forEach(field => {
      this.formData[field.name] = '';
    });
  }

  isFormValid(): boolean {
    return this.data.fields.every(field => {
      if (field.required && !this.formData[field.name]) {
        return false;
      }
      if (field.type === 'select' && field.options) {
        return field.options.includes(this.formData[field.name]);
      }
      return true;
    });
  }

  /**
   * Check if a field is invalid (has errors)
   */
  isFieldInvalid(field: InputField): boolean {
    const value = this.formData[field.name];
    const hasError = this.fieldErrors[field.name];

    // Required field validation
    if (field.required && !value) {
      return true;
    }

    return !!hasError;
  }

  /**
   * Check if a field is valid (has value and no errors)
   */
  isFieldValid(field: InputField): boolean {
    const value = this.formData[field.name];
    const hasError = this.fieldErrors[field.name];

    if (!value) {
      return false;
    }

    return !hasError;
  }

  /**
   * Get placeholder text for a field
   */
  getFieldPlaceholder(field: InputField): string {
    const placeholders: Record<string, string> = {
      text: `Enter ${field.label.toLowerCase()}`,
      password: `Enter ${field.label.toLowerCase()}`,
      number: `Enter ${field.label.toLowerCase()}`,
      select: `Select ${field.label.toLowerCase()}`,
      folder: `Click folder button to select ${field.label.toLowerCase()}`,
    };

    return placeholders[field.type] || `Enter ${field.label.toLowerCase()}`;
  }

  /**
   * Validate a specific field and set error messages
   */
  validateField(field: InputField): void {
    const value = this.formData[field.name];
    let error = '';

    // Clear previous error
    delete this.fieldErrors[field.name];

    // Required field validation
    if (field.required && !value) {
      error = `${field.label} is required`;
    }

    // Type-specific validation
    if (value) {
      switch (field.type) {
        case 'number':
          if (isNaN(Number(value))) {
            error = `${field.label} must be a valid number`;
          }
          break;
        case 'select':
          if (field.options && !field.options.includes(value)) {
            error = `Please select a valid ${field.label.toLowerCase()}`;
          }
          break;
        case 'text':
        case 'password':
          if (value.length < 1) {
            error = `${field.label} cannot be empty`;
          }
          break;
      }
    }

    if (error) {
      this.fieldErrors[field.name] = error;
    }
  }

  /**
   * Toggle password visibility
   */
  togglePasswordVisibility(): void {
    this.showPassword = !this.showPassword;
  }

  async selectFolder(field?: InputField) {
    try {
      const selected = await this.fileSystemService.selectFolder(false);
      const fieldName = field ? field.name : 'folder';
      this.formData[fieldName] = selected;

      // Clear any validation errors for this field
      if (field) {
        delete this.fieldErrors[field.name];
      }
    } catch (err) {
      console.error('Failed to select folder:', err);
    }
  }

  confirm(): void {
    // Validate all fields before confirming
    this.data.fields.forEach(field => this.validateField(field));

    if (this.isFormValid()) {
      this.dialogRef.close(this.formData);
    }
  }

  @HostListener('document:keydown.escape', ['$event'])
  close() {
    this.dialogRef.close(undefined);
  }

  @HostListener('document:keydown.enter', ['$event'])
  onEnterKey(event: KeyboardEvent) {
    // Only auto-submit if form is valid and we're not in a textarea
    const target = event.target as HTMLElement;
    if (target.tagName !== 'TEXTAREA' && this.isFormValid()) {
      this.confirm();
    }
  }
}
