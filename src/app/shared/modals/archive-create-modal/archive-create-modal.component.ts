import { Component, inject, ChangeDetectionStrategy, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ReactiveFormsModule, FormGroup, FormControl, Validators } from '@angular/forms';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { FileBrowserItem, RcConfigOption } from '@app/types';
import { staticFlagDefinitions } from '../../../services/remote/flag-definitions';
import { SettingControlComponent } from '../../components/setting-control/setting-control.component';

export interface ArchiveCreateData {
  items: FileBrowserItem[];
  defaultName: string;
}

@Component({
  selector: 'app-archive-create-modal',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    TranslateModule,
    SettingControlComponent,
  ],
  host: {
    '(keydown.escape)': 'dismiss()',
  },
  template: `
    <header data-tauri-drag-region>
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

    <main>
      <form [formGroup]="form">
        <div class="setting-card">
          <app-setting-control [option]="filenameOption()" formControlName="filename" />
        </div>

        @for (opt of archiveOptions; track opt.Name) {
          <div class="setting-card">
            <app-setting-control [option]="opt" [formControlName]="opt.FieldName || opt.Name" />
          </div>
        }
      </form>
    </main>

    <footer>
      <button mat-flat-button [disabled]="form.invalid" (click)="onConfirm()">
        {{ 'nautilus.modals.archiveCreate.compress' | translate }}
      </button>
    </footer>
  `,
  styles: [
    `
      form {
        display: flex;
        flex-direction: column;
        gap: var(--space-md);
      }

      .setting-card {
        ::ng-deep .setting-item {
          box-shadow: none !important;
          background: transparent !important;
          padding: 0 !important;
        }
      }
    `,
  ],
  styleUrl: '../../../styles/_shared-modal.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ArchiveCreateModalComponent {
  private readonly dialogRef = inject(MatDialogRef<ArchiveCreateModalComponent>);
  private readonly translate = inject(TranslateService);
  public readonly data = inject<ArchiveCreateData>(MAT_DIALOG_DATA);

  public readonly form = new FormGroup({
    filename: new FormControl(this.data.defaultName, {
      nonNullable: true,
      validators: [Validators.required],
    }),
    format: new FormControl('zip', { nonNullable: true }),
    prefix: new FormControl('', { nonNullable: true }),
    fullPath: new FormControl(false, { nonNullable: true }),
  });

  public readonly filenameOption = signal<RcConfigOption>(
    this.buildFilenameOption(this.data.defaultName)
  );

  public readonly archiveOptions = staticFlagDefinitions['archivecreate'];

  constructor() {
    this.form.controls.format.valueChanges.pipe(takeUntilDestroyed()).subscribe(format => {
      const baseName = this.stripExtension(this.form.controls.filename.value);
      const filename = `${baseName}.${format}`;

      this.form.controls.filename.setValue(filename, { emitEvent: false });
      this.filenameOption.set(this.buildFilenameOption(filename));
    });
  }

  onConfirm(): void {
    if (this.form.valid) {
      this.dialogRef.close(this.form.value);
    }
  }

  dismiss(): void {
    this.dialogRef.close();
  }

  private stripExtension(filename: string): string {
    const lastDotIndex = filename.lastIndexOf('.');
    return lastDotIndex > 0 ? filename.slice(0, lastDotIndex) : filename;
  }

  private buildFilenameOption(filename: string): RcConfigOption {
    return {
      Name: 'filename',
      Help: this.translate.instant('nautilus.modals.archiveCreate.filenameDesc'),
      Default: filename,
      DefaultStr: filename,
      Value: filename,
      Type: 'string',
      Advanced: false,
      FieldName: this.translate.instant('nautilus.modals.archiveCreate.filenameLabel'),
      Required: true,
    };
  }
}
