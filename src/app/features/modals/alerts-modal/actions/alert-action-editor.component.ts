import { Component, inject, ChangeDetectionStrategy, signal } from '@angular/core';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatDividerModule } from '@angular/material/divider';
import { TranslateModule } from '@ngx-translate/core';

import { ModalService, AlertService } from '@app/services';
import { AlertAction, AlertActionKind, ScriptAction, WebhookAction } from '@app/types';

@Component({
  selector: 'app-alert-action-editor',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatSlideToggleModule,
    MatDividerModule,
    TranslateModule,
  ],
  template: `
    <h2 mat-dialog-title class="dialog-title">
      <div class="title-content">
        <div class="icon-wrapper">
          <mat-icon [svgIcon]="data?.kind ? 'bolt' : 'plus'"></mat-icon>
        </div>
        <span>{{ (data ? 'alerts.editAction' : 'alerts.createAction') | translate }}</span>
      </div>
    </h2>

    <mat-dialog-content>
      <form [formGroup]="form" (ngSubmit)="save()" class="editor-form">
        <!-- Basic Info Section -->
        <h3 class="section-title">
          <mat-icon svgIcon="info" class="sm-icon"></mat-icon>
          {{ 'alerts.action.basicInfo' | translate }}
        </h3>

        <div class="panel">
          <div class="form-row">
            <mat-form-field appearance="fill" class="flex-2">
              <mat-label>{{ 'common.name' | translate }}</mat-label>
              <input
                matInput
                formControlName="name"
                [placeholder]="'alerts.action.placeholderName' | translate"
              />
              @if (form.controls.name.hasError('required')) {
                <mat-error>{{ 'common.required' | translate }}</mat-error>
              }
            </mat-form-field>

            <mat-form-field appearance="fill" class="flex-1">
              <mat-label>{{ 'alerts.action.kind' | translate }}</mat-label>
              <mat-select formControlName="kind" (selectionChange)="onKindChange()">
                <mat-option value="os_toast">
                  <div class="kind-option">
                    <mat-icon svgIcon="desktop" class="sm-icon"></mat-icon>
                    {{ 'alerts.action.os_toast' | translate }}
                  </div>
                </mat-option>
                <mat-option value="webhook">
                  <div class="kind-option">
                    <mat-icon svgIcon="webhook" class="sm-icon"></mat-icon>
                    {{ 'alerts.action.webhook' | translate }}
                  </div>
                </mat-option>
                <mat-option value="script">
                  <div class="kind-option">
                    <mat-icon svgIcon="terminal" class="sm-icon"></mat-icon>
                    {{ 'alerts.action.script' | translate }}
                  </div>
                </mat-option>
              </mat-select>
            </mat-form-field>
          </div>

          <div class="toggle-container">
            <mat-slide-toggle formControlName="enabled" color="primary">
              {{ 'alerts.enabled' | translate }}
            </mat-slide-toggle>
          </div>
        </div>

        <!-- Configuration Section -->
        <h3 class="section-title mt-md">
          <mat-icon svgIcon="settings" class="sm-icon"></mat-icon>
          {{ 'alerts.action.configuration' | translate }}
        </h3>

        <div class="panel">
          <!-- Webhook Fields -->
          @if (form.controls.kind.value === 'webhook') {
            <div class="kind-fields anim-fade-in">
              <mat-form-field appearance="fill" class="full-width">
                <mat-label>{{ 'alerts.action.url' | translate }}</mat-label>
                <mat-icon matPrefix svgIcon="link" class="prefix-icon"></mat-icon>
                <input
                  matInput
                  formControlName="url"
                  placeholder="https://api.example.com/webhook"
                />
              </mat-form-field>

              <div class="form-row">
                <mat-form-field appearance="fill" class="flex-1">
                  <mat-label>{{ 'alerts.action.method' | translate }}</mat-label>
                  <mat-select formControlName="method">
                    <mat-option value="POST">POST</mat-option>
                    <mat-option value="GET">GET</mat-option>
                    <mat-option value="PUT">PUT</mat-option>
                  </mat-select>
                </mat-form-field>

                <mat-form-field appearance="fill" class="flex-1">
                  <mat-label>{{ 'alerts.action.timeout' | translate }}</mat-label>
                  <input matInput type="number" formControlName="timeout_secs" />
                  <span matSuffix class="suffix-text">sec</span>
                </mat-form-field>

                <mat-form-field appearance="fill" class="flex-1">
                  <mat-label>{{ 'alerts.action.retryCount' | translate }}</mat-label>
                  <input matInput type="number" formControlName="retry_count" min="0" max="5" />
                </mat-form-field>
              </div>

              <mat-form-field appearance="fill" class="full-width">
                <mat-label>{{ 'alerts.action.bodyTemplate' | translate }}</mat-label>
                <textarea
                  matInput
                  formControlName="body_template"
                  rows="4"
                  class="code-font"
                ></textarea>
              </mat-form-field>

              <div class="info-box">
                <mat-icon svgIcon="info"></mat-icon>
                <div class="info-content">
                  <span class="info-title"
                    >{{ 'alerts.action.bodyTemplateHint' | translate }}:</span
                  >
                  <div class="tags-container">
                    @for (key of templateKeys(); track key) {
                      <span class="code-tag">{{ '{{' }}{{ key }}{{ '}}' }}</span>
                    }
                  </div>
                </div>
              </div>

              <div class="toggle-container mt-sm">
                <mat-slide-toggle formControlName="tls_verify" color="primary">
                  {{ 'alerts.action.tlsVerify' | translate }}
                </mat-slide-toggle>
              </div>
            </div>
          }

          <!-- Script Fields -->
          @if (form.controls.kind.value === 'script') {
            <div class="kind-fields anim-fade-in">
              <mat-form-field appearance="fill" class="full-width">
                <mat-label>{{ 'alerts.action.command' | translate }}</mat-label>
                <mat-icon matPrefix svgIcon="terminal" class="prefix-icon"></mat-icon>
                <input
                  matInput
                  formControlName="command"
                  placeholder="/usr/local/bin/notify.sh"
                  class="code-font"
                />
              </mat-form-field>

              <mat-form-field appearance="fill" class="full-width">
                <mat-label>{{ 'alerts.action.args' | translate }}</mat-label>
                <input
                  matInput
                  formControlName="argsRaw"
                  [placeholder]="'alerts.action.argsHint' | translate"
                  class="code-font"
                />
              </mat-form-field>

              <mat-form-field appearance="fill" class="full-width">
                <mat-label>{{ 'alerts.action.timeout' | translate }}</mat-label>
                <input matInput type="number" formControlName="timeout_secs" />
                <span matSuffix class="suffix-text">sec</span>
              </mat-form-field>

              <div class="info-box">
                <mat-icon svgIcon="terminal"></mat-icon>
                <div class="info-content">
                  <span class="info-title"
                    >{{ 'alerts.action.scriptContextHint' | translate }}:</span
                  >
                  <div class="tags-container">
                    @for (key of templateKeys(); track key) {
                      <span class="code-tag">ALERT_{{ key.toUpperCase() }}</span>
                    }
                  </div>
                </div>
              </div>
            </div>
          }

          <!-- OS Toast Fields -->
          @if (form.controls.kind.value === 'os_toast') {
            <div class="kind-fields anim-fade-in">
              <div class="info-box accent">
                <mat-icon svgIcon="desktop"></mat-icon>
                <span>{{ 'alerts.action.os_toast_info' | translate }}</span>
              </div>
            </div>
          }
        </div>

        <!-- Hidden submit button to allow Enter key submission -->
        <button type="submit" style="display:none"></button>
      </form>
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button mat-button (click)="cancel()" type="button">{{ 'common.cancel' | translate }}</button>
      <button mat-flat-button color="primary" [disabled]="form.invalid" (click)="save()">
        {{ 'common.save' | translate }}
      </button>
    </mat-dialog-actions>
  `,
  styles: [
    `
      .dialog-title {
        margin: 0;
        padding: var(--space-lg) var(--space-lg) var(--space-md);
        border-bottom: 1px solid var(--border-color);

        .title-content {
          display: flex;
          align-items: center;
          gap: var(--space-md);

          .icon-wrapper {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 40px;
            height: 40px;
            border-radius: 50%;
            background: rgba(var(--accent-color-rgb), 0.1);
            color: var(--accent-color);
          }
        }
      }

      .editor-form {
        display: flex;
        flex-direction: column;
        gap: var(--space-md);
      }

      .panel {
        background: var(--bg-elevated);
        border: 1px solid var(--border-color);
        border-radius: var(--card-border-radius);
        padding: var(--space-md);
        display: flex;
        flex-direction: column;
        gap: var(--space-sm);
      }

      .section-title {
        font-size: 0.85rem;
        font-weight: 600;
        color: var(--text-muted);
        margin: 0;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        display: flex;
        align-items: center;
        gap: var(--space-sm);

        .sm-icon {
          width: 18px;
          height: 18px;
          font-size: 18px;
        }
      }

      .form-row {
        display: flex;
        gap: var(--space-md);
        align-items: flex-start;

        &.align-center {
          align-items: center;
        }
        .flex-1 {
          flex: 1;
        }
        .flex-2 {
          flex: 2;
        }
      }

      .full-width {
        width: 100%;
      }

      .mt-md {
        margin-top: var(--space-md);
      }

      .mt-sm {
        margin-top: var(--space-sm);
      }

      .toggle-container {
        padding: var(--space-xs) 0;
      }

      .kind-fields {
        display: flex;
        flex-direction: column;
        gap: var(--space-sm);
      }

      .kind-option {
        display: flex;
        align-items: center;
        gap: var(--space-sm);

        .sm-icon {
          width: 18px;
          height: 18px;
          font-size: 18px;
          opacity: 0.7;
        }
      }

      .prefix-icon {
        margin-right: var(--space-sm);
        opacity: 0.5;
      }

      .suffix-text {
        color: var(--text-muted);
        margin-right: 4px;
        font-size: 0.9em;
      }

      .code-font {
        font-family: 'JetBrains Mono', 'Fira Code', monospace;
        font-size: 0.9em;
      }

      .info-box {
        display: flex;
        align-items: flex-start;
        gap: var(--space-md);
        padding: var(--space-md);
        background: var(--bg-color);
        border: 1px solid var(--border-color);
        border-radius: var(--card-border-radius);
        color: var(--text-muted);
        font-size: var(--font-size-sm);

        &.accent {
          background: rgba(var(--accent-color-rgb), 0.05);
          border-color: rgba(var(--accent-color-rgb), 0.2);
          color: var(--window-fg-color);

          mat-icon {
            color: var(--accent-color);
          }
        }

        mat-icon {
          width: 24px;
          height: 24px;
          font-size: 24px;
          opacity: 0.8;
          flex-shrink: 0;
        }

        .info-content {
          display: flex;
          flex-direction: column;
          gap: var(--space-sm);
        }

        .info-title {
          font-weight: 500;
          color: var(--window-fg-color);
        }

        .tags-container {
          display: flex;
          flex-wrap: wrap;
          gap: var(--space-xs);
        }

        .code-tag {
          background: var(--bg-elevated);
          border: 1px solid var(--border-color);
          padding: 2px 6px;
          border-radius: 4px;
          font-family: 'JetBrains Mono', 'Fira Code', monospace;
          font-size: 0.85em;
          color: var(--accent-color);
        }
      }

      .anim-fade-in {
        animation: fadeIn 0.3s ease-in-out;
      }

      @keyframes fadeIn {
        from {
          opacity: 0;
          transform: translateY(4px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }
    `,
  ],
  styleUrl: '../../../../styles/_shared-modal.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AlertActionEditorComponent {
  private fb = inject(FormBuilder);
  private dialogRef = inject(MatDialogRef<AlertActionEditorComponent>);
  private modalService = inject(ModalService);
  private alertService = inject(AlertService);
  data = inject(MAT_DIALOG_DATA) as AlertAction | undefined;

  templateKeys = signal<string[]>([]);

  form = this.fb.nonNullable.group({
    id: [''],
    name: ['', Validators.required],
    kind: ['webhook' as AlertActionKind, Validators.required],
    enabled: [true],

    // Webhook specific
    url: [''],
    method: ['POST'],
    body_template: ['{"text": "{{title}}: {{body}}"}'],
    timeout_secs: [10],
    tls_verify: [true],
    retry_count: [1],

    // Script specific
    command: [''],
    argsRaw: [''],
  });

  constructor() {
    if (this.data) {
      const patchValue: any = { ...this.data };
      if (this.data.kind === 'script') {
        patchValue.argsRaw = (this.data as ScriptAction).args.join(' ');
      }
      this.form.patchValue(patchValue);
    }
    this.onKindChange();

    this.alertService.getTemplateKeys().subscribe(keys => this.templateKeys.set(keys));
  }

  onKindChange(): void {
    const kind = this.form.controls.kind.value;
    const urlControl = this.form.controls.url;
    const commandControl = this.form.controls.command;

    if (kind === 'webhook') {
      urlControl.setValidators([Validators.required]);
      commandControl.clearValidators();
    } else if (kind === 'script') {
      commandControl.setValidators([Validators.required]);
      urlControl.clearValidators();
    } else {
      urlControl.clearValidators();
      commandControl.clearValidators();
    }
    urlControl.updateValueAndValidity();
    commandControl.updateValueAndValidity();
  }

  save(): void {
    if (this.form.invalid) return;

    const val = this.form.getRawValue();
    const kind = val.kind;

    let action: any = {
      id: val.id || '',
      name: val.name,
      kind: kind,
      enabled: val.enabled,
    };

    if (kind === 'webhook') {
      action = {
        ...action,
        url: val.url,
        method: val.method,
        body_template: val.body_template,
        timeout_secs: val.timeout_secs,
        tls_verify: val.tls_verify,
        retry_count: val.retry_count,
        headers: this.data?.kind === 'webhook' ? (this.data as WebhookAction).headers : {},
      };
    } else if (kind === 'script') {
      action = {
        ...action,
        command: val.command,
        args: val.argsRaw ? val.argsRaw.split(' ') : [],
        timeout_secs: val.timeout_secs,
        env_vars: this.data?.kind === 'script' ? (this.data as ScriptAction).env_vars : {},
      };
    }

    this.modalService.animatedClose(this.dialogRef, action);
  }

  cancel(): void {
    this.modalService.animatedClose(this.dialogRef);
  }
}
