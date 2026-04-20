import { Component, inject, ChangeDetectionStrategy } from '@angular/core';
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
    <h2 mat-dialog-title>
      <mat-icon [svgIcon]="data?.kind ? 'bolt' : 'plus'"></mat-icon>
      {{ (data ? 'alerts.editAction' : 'alerts.createAction') | translate }}
    </h2>

    <mat-dialog-content class="editor-content hide-scrollbar">
      <form [formGroup]="form" (ngSubmit)="save()" class="editor-form">
        <!-- Common Fields -->
        <div class="form-row">
          <mat-form-field class="flex-2">
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

          <mat-form-field class="flex-1">
            <mat-label>{{ 'alerts.action.kind' | translate }}</mat-label>
            <mat-select formControlName="kind" (selectionChange)="onKindChange()">
              <mat-option value="os_toast">{{ 'alerts.action.os_toast' | translate }}</mat-option>
              <mat-option value="webhook">{{ 'alerts.action.webhook' | translate }}</mat-option>
              <mat-option value="script">{{ 'alerts.action.script' | translate }}</mat-option>
            </mat-select>
          </mat-form-field>
        </div>

        <mat-slide-toggle formControlName="enabled" class="mb-xs">
          {{ 'alerts.enabled' | translate }}
        </mat-slide-toggle>

        <mat-divider class="my-4"></mat-divider>

        <!-- Webhook Fields -->
        @if (form.controls.kind.value === 'webhook') {
          <div class="kind-fields">
            <mat-form-field>
              <mat-label>{{ 'alerts.action.url' | translate }}</mat-label>
              <input matInput formControlName="url" placeholder="https://api.example.com/webhook" />
            </mat-form-field>

            <div class="form-row">
              <mat-form-field class="flex-1">
                <mat-label>{{ 'alerts.action.method' | translate }}</mat-label>
                <mat-select formControlName="method">
                  <mat-option value="POST">POST</mat-option>
                  <mat-option value="GET">GET</mat-option>
                  <mat-option value="PUT">PUT</mat-option>
                </mat-select>
              </mat-form-field>

              <mat-form-field class="flex-1">
                <mat-label>{{ 'alerts.action.timeout' | translate }} (Secs)</mat-label>
                <input matInput type="number" formControlName="timeout_secs" />
              </mat-form-field>
            </div>

            <mat-form-field>
              <mat-label>{{ 'alerts.action.bodyTemplate' | translate }}</mat-label>
              <textarea matInput formControlName="body_template" rows="4"></textarea>
            </mat-form-field>

            <div class="info-box">
              <mat-icon svgIcon="info"></mat-icon>
              <span ngNonBindable
                >Supports Handlebars variables: &#123;&#123;title&#125;&#125;,
                &#123;&#123;body&#125;&#125;, &#123;&#123;severity&#125;&#125;,
                &#123;&#123;remote&#125;&#125;, &#123;&#123;event_kind&#125;&#125;,
                &#123;&#123;rule_name&#125;&#125;</span
              >
            </div>

            <div class="form-row mt-md align-center">
              <mat-slide-toggle formControlName="tls_verify" class="flex-1">
                {{ 'alerts.action.tlsVerify' | translate }}
              </mat-slide-toggle>
              <mat-form-field class="flex-1">
                <mat-label>{{ 'alerts.action.retryCount' | translate }}</mat-label>
                <input matInput type="number" formControlName="retry_count" min="0" max="5" />
              </mat-form-field>
            </div>
          </div>
        }

        <!-- Script Fields -->
        @if (form.controls.kind.value === 'script') {
          <div class="kind-fields">
            <mat-form-field>
              <mat-label>{{ 'alerts.action.command' | translate }}</mat-label>
              <input matInput formControlName="command" placeholder="/usr/local/bin/notify.sh" />
            </mat-form-field>

            <mat-form-field>
              <mat-label>{{ 'alerts.action.args' | translate }} (Space separated)</mat-label>
              <input matInput formControlName="argsRaw" placeholder="--silent --force" />
            </mat-form-field>

            <div class="info-box">
              <mat-icon svgIcon="terminal"></mat-icon>
              <span
                >Context is injected as <code>ALERT_*</code> environment variables (e.g.
                <code>ALERT_TITLE</code>, <code>ALERT_SEVERITY</code>).</span
              >
            </div>

            <mat-form-field class="flex-1 mt-md">
              <mat-label>{{ 'alerts.action.timeout' | translate }} (Secs)</mat-label>
              <input matInput type="number" formControlName="timeout_secs" />
            </mat-form-field>
          </div>
        }

        <!-- OS Toast Fields -->
        @if (form.controls.kind.value === 'os_toast') {
          <div class="kind-fields">
            <div class="info-box accent">
              <mat-icon svgIcon="desktop"></mat-icon>
              <span
                >No additional configuration required for OS Native Notifications. It will use the
                standard system notification subsystem.</span
              >
            </div>
          </div>
        }

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
      .editor-content {
        min-width: 500px;
        max-width: 600px;
        padding-top: var(--space-md) !important;
      }

      .editor-form {
        display: flex;
        flex-direction: column;
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

      .kind-fields {
        display: flex;
        flex-direction: column;
        gap: var(--space-sm);
      }

      .info-box {
        display: flex;
        align-items: flex-start;
        gap: var(--space-sm);
        padding: var(--space-sm) var(--space-md);
        background: var(--bg-elevated);
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
          width: 20px;
          height: 20px;
          font-size: 20px;
          opacity: 0.8;
          margin-top: 2px;
        }

        code {
          background: rgba(var(--window-fg-color-rgb), 0.1);
          padding: 2px 4px;
          border-radius: 4px;
        }
      }

      .my-4 {
        margin-top: var(--space-md);
        margin-bottom: var(--space-md);
        opacity: 0.6;
      }
      .mt-md {
        margin-top: var(--space-md);
      }
      .mb-xs {
        margin-bottom: var(--space-xs);
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AlertActionEditorComponent {
  private fb = inject(FormBuilder);
  private dialogRef = inject(MatDialogRef<AlertActionEditorComponent>);
  data = inject(MAT_DIALOG_DATA) as AlertAction | undefined;

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
  }

  onKindChange() {
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

  save() {
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

    this.dialogRef.close(action);
  }

  cancel() {
    this.dialogRef.close();
  }
}
