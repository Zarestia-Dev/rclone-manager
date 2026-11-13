import { Component, inject, ChangeDetectionStrategy } from '@angular/core';
import { ReactiveFormsModule, FormControl, FormRecord, Validators } from '@angular/forms';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import { ConfigValue, RcConfigOption } from '@app/types';
import { staticFlagDefinitions } from '../../../services/remote/flag-definitions';
import { SettingControlComponent } from '../../components/setting-control/setting-control.component';
import { AlertBannerComponent } from '../../components/alert-banner/alert-banner.component';
import { EscapeCloseDirective } from '../../directives/escape-close.directive';

interface IndexCreateData {
  /** Where the listings are written, as shown to the user (`remote:path`). */
  target: string;
}

/** What the dialog closes with: the options by rclone's names, as a profile keeps them. */
type IndexCreateResult = Record<string, ConfigValue>;

interface IndexSection {
  /** Translation key of the section's title. */
  title: string;
  options: RcConfigOption[];
}

const I18N = 'nautilus.modals.index';
const OPTIONS = staticFlagDefinitions['index'];

/** The options of `fields`, in that order. */
function optionsOf(...fields: string[]): RcConfigOption[] {
  return fields.flatMap(field => OPTIONS.filter(option => option.FieldName === field));
}

@Component({
  selector: 'app-index-create-modal',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatIconModule,
    TranslatePipe,
    SettingControlComponent,
    AlertBannerComponent,
  ],
  hostDirectives: [EscapeCloseDirective],
  template: `
    <header data-tauri-drag-region>
      <button type="button">
        <mat-icon svgIcon="file-lines"></mat-icon>
      </button>
      <p class="header-title">{{ 'nautilus.modals.index.title' | translate }}</p>
      <button
        matIconButton
        type="button"
        (click)="dismiss()"
        [attr.aria-label]="'common.close' | translate"
      >
        <mat-icon svgIcon="circle-xmark"></mat-icon>
      </button>
    </header>

    <main>
      <p class="target">
        {{ 'nautilus.modals.index.description' | translate: { target: data.target } }}
      </p>

      <app-alert-banner
        severity="warning"
        [description]="'nautilus.modals.index.overwriteWarning' | translate"
      />

      <form [formGroup]="form">
        @for (section of sections; track section.title) {
          <section class="form-section">
            <span class="section-label">{{ section.title | translate }}</span>
            @for (option of section.options; track option.FieldName) {
              <app-setting-control
                [option]="option"
                [formControlName]="option.FieldName"
                [showFlag]="false"
              />
            }
          </section>
        }
      </form>
    </main>

    <footer>
      <button matButton="filled" type="button" [disabled]="form.invalid" (click)="onConfirm()">
        {{ 'nautilus.modals.index.confirm' | translate }}
      </button>
    </footer>
  `,
  styles: [
    `
      main {
        display: flex;
        flex-direction: column;
        gap: var(--space-md);
      }

      .target {
        margin: 0;
        color: var(--dim-color);
        user-select: text;
      }

      form {
        display: flex;
        flex-direction: column;
        gap: var(--space-md);
      }
    `,
  ],
  styleUrl: '../../../styles/_shared-modal.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class IndexCreateModalComponent {
  private readonly dialogRef = inject(MatDialogRef<IndexCreateModalComponent, IndexCreateResult>);
  public readonly data = inject<IndexCreateData>(MAT_DIALOG_DATA);

  public readonly sections: IndexSection[] = [
    { title: `${I18N}.sections.output`, options: optionsOf('output') },
    {
      title: `${I18N}.sections.folders`,
      options: optionsOf('maxDepth', 'IncludeRule', 'ExcludeRule'),
    },
    {
      title: `${I18N}.sections.appearance`,
      options: optionsOf('dirTime', 'noModTime', 'linkIndex'),
    },
    { title: `${I18N}.sections.advanced`, options: optionsOf('UseServerModTime', 'rewrite') },
  ];

  /** One control per option, started at the option's default. */
  public readonly form = new FormRecord(
    Object.fromEntries(
      OPTIONS.map(option => [
        option.FieldName,
        new FormControl<ConfigValue>(option.Default ?? null, {
          // A listing format has to be picked: no format would write nothing.
          validators: option.Required ? [Validators.required] : [],
        }),
      ])
    )
  );

  onConfirm(): void {
    if (this.form.invalid) return;
    this.dialogRef.close(this.form.getRawValue() as IndexCreateResult);
  }

  dismiss(): void {
    this.dialogRef.close();
  }
}
