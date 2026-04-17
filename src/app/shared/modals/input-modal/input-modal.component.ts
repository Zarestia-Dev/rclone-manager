import { Component, HostListener, inject, OnInit, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatDialogRef, MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import {
  FormsModule,
  ReactiveFormsModule,
  FormControl,
  FormGroup,
  Validators,
  AbstractControl,
  ValidationErrors,
} from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';

export interface InputFieldConfig {
  key: string;
  label?: string;
  placeholder?: string;
  initialValue?: string;
  type?: 'text' | 'password' | 'url';
  required?: boolean;
  forbiddenChars?: boolean;
  uniqueness?: {
    existingNames: string[];
    typeLabel?: string;
  };
}

export interface InputModalData {
  title?: string;
  label?: string;
  icon: string;
  placeholder?: string;
  initialValue?: string;
  existingNames?: string[];
  existingNameType?: string;
  createLabel?: string;
  forbiddenCharsMessage?: string;
  fields?: InputFieldConfig[];
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
    TranslateModule,
  ],
  templateUrl: './input-modal.component.html',
  styleUrls: ['./input-modal.component.scss', '../../../styles/_shared-modal.scss'],
})
export class InputModalComponent implements OnInit {
  public dialogRef = inject(MatDialogRef<InputModalComponent>);
  public data = inject<InputModalData>(MAT_DIALOG_DATA);
  protected readonly translate = inject(TranslateService);
  private readonly destroyRef = inject(DestroyRef);

  public form = new FormGroup<any>({});
  public fields: InputFieldConfig[] = [];

  ngOnInit(): void {
    if (this.data.fields && this.data.fields.length > 0) {
      this.fields = this.data.fields;
    } else {
      // Create a default field for backward compatibility
      this.fields = [
        {
          key: 'single',
          label: this.data.label,
          placeholder: this.data.placeholder,
          initialValue: this.data.initialValue,
          required: true,
          forbiddenChars: true,
          uniqueness: this.data.existingNames
            ? {
                existingNames: this.data.existingNames,
                typeLabel: this.data.existingNameType,
              }
            : undefined,
        },
      ];
    }

    this.initForm();
  }

  private initForm(): void {
    for (const field of this.fields) {
      const validators = [];
      if (field.required) validators.push(Validators.required);
      if (field.uniqueness) validators.push(this.uniqueNameValidator(field.uniqueness).bind(this));
      if (field.forbiddenChars) validators.push(this.forbiddenCharsValidator.bind(this));

      const control = new FormControl(field.initialValue || '', {
        nonNullable: true,
        validators,
      });

      this.form.addControl(field.key, control);
    }
    this.form.updateValueAndValidity();
    this.setupUrlAutoFilename();
  }

  private setupUrlAutoFilename(): void {
    const urlControl = this.form.get('url');
    const filenameControl = this.form.get('filename');

    if (urlControl && filenameControl) {
      urlControl.valueChanges.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(url => {
        if (!url) return;

        const currentFilename = (filenameControl.value || '').toString().trim();
        if (!currentFilename || filenameControl.pristine) {
          const extracted = this.extractFilenameFromUrl(url);
          if (extracted) {
            filenameControl.setValue(extracted);
            filenameControl.markAsPristine();
          }
        }
      });
    }
  }

  private extractFilenameFromUrl(url: string): string | null {
    try {
      const parsed = new URL(url);
      const path = parsed.pathname || '';
      const candidate = path.split('/').pop()?.trim() || '';
      const filename = candidate.split('?')[0].split('#')[0];
      if (!filename) return null;
      if (filename.includes('.') && !filename.endsWith('.')) {
        return filename;
      }
      return null;
    } catch {
      return null;
    }
  }

  @HostListener('document:keydown.escape')
  onEscapeKey(): void {
    this.dialogRef.close(null);
  }

  @HostListener('document:keydown.enter')
  onEnterKey(): void {
    if (this.form.valid) this.onConfirm();
  }

  getControl(key: string): FormControl {
    return this.form.get(key) as FormControl;
  }

  uniqueNameValidator(config: {
    existingNames: string[];
    typeLabel?: string;
  }): (control: AbstractControl) => ValidationErrors | null {
    return (control: AbstractControl): ValidationErrors | null => {
      const existing = (config.existingNames || []).map(e => e.toString().trim().toLowerCase());
      const val = (control.value || '').toString().trim().toLowerCase();
      return existing.some(e => e === val) ? { alreadyExists: true } : null;
    };
  }

  forbiddenCharsValidator(control: AbstractControl): ValidationErrors | null {
    const val = (control.value || '').toString();
    if (val.includes('/') || val.includes(':')) return { forbiddenChars: true };
    return null;
  }

  onConfirm(): void {
    const val = this.form.getRawValue() as Record<string, any>;
    // If it was a single field (legacy or just one defined), return the string value for convenience
    const keys = Object.keys(val);
    if (keys.length === 1 && (keys[0] === 'single' || !this.data.fields)) {
      const result = val[keys[0]];
      this.dialogRef.close(typeof result === 'string' ? result.trim() : result);
    } else {
      this.dialogRef.close(val);
    }
  }

  onCancel(): void {
    this.dialogRef.close(null);
  }
}
