import { Component, HostListener, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  FormsModule,
  ReactiveFormsModule,
  FormBuilder,
  FormGroup,
  Validators,
} from '@angular/forms';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { TranslateModule } from '@ngx-translate/core';
import { FileBrowserItem } from '@app/types';

export interface ArchiveCreateData {
  items: FileBrowserItem[];
  defaultName: string;
}

@Component({
  selector: 'app-archive-create-modal',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ReactiveFormsModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatCheckboxModule,
    TranslateModule,
  ],
  template: `
    <header class="modal-header" data-tauri-drag-region>
      <button>
        <mat-icon svgIcon="box-archive"></mat-icon>
      </button>
      <p class="header-title">
        {{ 'nautilus.modals.archiveCreate.title' | translate }}
      </p>
      <button mat-icon-button (click)="dismiss()" [attr.aria-label]="'common.close' | translate">
        <mat-icon svgIcon="circle-xmark"></mat-icon>
      </button>
    </header>

    <mat-dialog-content>
      <form [formGroup]="form">
        <mat-form-field>
          <mat-label>{{ 'nautilus.modals.archiveCreate.filenameLabel' | translate }}</mat-label>
          <input matInput formControlName="filename" />
        </mat-form-field>

        <mat-form-field>
          <mat-label>{{ 'nautilus.modals.archiveCreate.formatLabel' | translate }}</mat-label>
          <mat-select formControlName="format">
            @for (format of formats; track format) {
              <mat-option [value]="format">{{ format }}</mat-option>
            }
          </mat-select>
        </mat-form-field>

        <mat-form-field>
          <mat-label>{{ 'nautilus.modals.archiveCreate.prefixLabel' | translate }}</mat-label>
          <input matInput formControlName="prefix" />
          <mat-hint>{{ 'nautilus.modals.archiveCreate.prefixHint' | translate }}</mat-hint>
        </mat-form-field>

        <mat-checkbox formControlName="fullPath">
          {{ 'nautilus.modals.archiveCreate.fullPathLabel' | translate }}
        </mat-checkbox>
        <div class="field-hint">
          {{ 'nautilus.modals.archiveCreate.fullPathHint' | translate }}
        </div>
      </form>
    </mat-dialog-content>

    <mat-dialog-actions>
      <button mat-flat-button [disabled]="form.invalid" (click)="onConfirm()">
        {{ 'nautilus.modals.archiveCreate.compress' | translate }}
      </button>
    </mat-dialog-actions>
  `,
  styles: [
    `
      .field-hint {
        font-size: 0.75rem;
        color: var(--mat-sys-on-surface-variant);
        padding-left: 32px;
        opacity: 0.8;
      }

      mat-checkbox {
        margin-top: var(--space-md);
      }
    `,
  ],
  styleUrl: '../../../styles/_shared-modal.scss',
})
export class ArchiveCreateModalComponent implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly dialogRef = inject(MatDialogRef<ArchiveCreateModalComponent>);
  public readonly data = inject<ArchiveCreateData>(MAT_DIALOG_DATA);

  public form!: FormGroup;
  public readonly formats = [
    'zip',
    'tar',
    'tar.gz',
    'tar.bz2',
    'tar.xz',
    'tar.zst',
    'tar.br',
    'tar.sz',
    'tar.mz',
    'tar.lz',
    'tar.lz4',
  ];

  ngOnInit(): void {
    this.form = this.fb.group({
      filename: [this.data.defaultName, [Validators.required]],
      format: ['zip'],
      prefix: [''],
      fullPath: [false],
    });

    // Auto-update filename extension when format changes
    this.form.get('format')?.valueChanges.subscribe(format => {
      const currentFilename = this.form.get('filename')?.value || '';
      const baseName = currentFilename.split('.')[0] || 'archive';
      this.form.get('filename')?.setValue(`${baseName}.${format}`, { emitEvent: false });
    });
  }

  onConfirm(): void {
    if (this.form.valid) {
      this.dialogRef.close(this.form.value);
    }
  }

  @HostListener('keydown.escape')
  dismiss(): void {
    this.dialogRef.close();
  }
}
