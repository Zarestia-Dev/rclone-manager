import { Component, inject, ChangeDetectionStrategy, signal } from '@angular/core';
import { ReactiveFormsModule, FormBuilder, Validators, FormArray } from '@angular/forms';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatDividerModule } from '@angular/material/divider';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslateModule } from '@ngx-translate/core';

import { ModalService, AlertService, FileSystemService } from '@app/services';
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
    MatTooltipModule,
    TranslateModule,
  ],
  template: `
    <header class="modal-header" data-tauri-drag-region>
      <button>
        <mat-icon [svgIcon]="data ? 'pen' : 'plus'"></mat-icon>
      </button>
      <p class="header-title">
        {{ (data ? 'alerts.editAction' : 'alerts.createAction') | translate }}
      </p>
      <button mat-icon-button (click)="cancel()" [attr.aria-label]="'common.close' | translate">
        <mat-icon svgIcon="circle-xmark"></mat-icon>
      </button>
    </header>

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
                    <mat-icon svgIcon="link" class="sm-icon"></mat-icon>
                    {{ 'alerts.action.webhook' | translate }}
                  </div>
                </mat-option>
                <mat-option value="script">
                  <div class="kind-option">
                    <mat-icon svgIcon="terminal" class="sm-icon"></mat-icon>
                    {{ 'alerts.action.script' | translate }}
                  </div>
                </mat-option>
                <mat-option value="telegram">
                  <div class="kind-option">
                    <mat-icon svgIcon="telegram" class="sm-icon"></mat-icon>
                    {{ 'alerts.action.telegram' | translate }}
                  </div>
                </mat-option>
                <mat-option value="mqtt">
                  <div class="kind-option">
                    <mat-icon svgIcon="message" class="sm-icon"></mat-icon>
                    {{ 'alerts.action.mqtt' | translate }}
                  </div>
                </mat-option>
                <mat-option value="email">
                  <div class="kind-option">
                    <mat-icon svgIcon="envelope" class="sm-icon"></mat-icon>
                    {{ 'alerts.action.email' | translate }}
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
            <div class="kind-fields">
              <div class="presets-row mb-3">
                <span class="label-small">{{ 'alerts.action.presets' | translate }}:</span>
                <button
                  mat-stroked-button
                  type="button"
                  (click)="applyPreset('discord')"
                  class="preset-btn"
                >
                  <mat-icon svgIcon="discord"></mat-icon> Discord
                </button>
                <button
                  mat-stroked-button
                  type="button"
                  (click)="applyPreset('slack')"
                  class="preset-btn"
                >
                  <mat-icon svgIcon="slack"></mat-icon> Slack
                </button>
              </div>

              <mat-form-field appearance="fill" class="full-width">
                <mat-label>{{ 'alerts.action.url' | translate }}</mat-label>
                <mat-icon matPrefix svgIcon="link" class="prefix-icon"></mat-icon>
                <input
                  matInput
                  formControlName="url"
                  placeholder="https://api.example.com/webhook"
                  type="password"
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

              <!-- Headers Section -->
              <div class="headers-section mb-3">
                <div class="section-header d-flex align-center justify-between">
                  <span class="label-small">{{ 'alerts.action.headers' | translate }}</span>
                  <button
                    mat-icon-button
                    type="button"
                    (click)="addHeader()"
                    color="primary"
                    matTooltip="Add Header"
                  >
                    <mat-icon svgIcon="plus"></mat-icon>
                  </button>
                </div>
                <div formArrayName="headers" class="headers-list">
                  @for (header of headers.controls; track $index) {
                    <div [formGroupName]="$index" class="header-row d-flex gap-2 align-center mb-2">
                      <mat-form-field class="flex-1 dense-form-field">
                        <input
                          matInput
                          formControlName="key"
                          placeholder="Key (e.g. Authorization)"
                        />
                      </mat-form-field>
                      <mat-form-field class="flex-2 dense-form-field">
                        <input matInput formControlName="value" placeholder="Value" />
                      </mat-form-field>
                      <button
                        mat-icon-button
                        type="button"
                        color="warn"
                        (click)="removeHeader($index)"
                      >
                        <mat-icon svgIcon="trash"></mat-icon>
                      </button>
                    </div>
                  }
                </div>
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
            <div class="kind-fields">
              <div class="form-row align-center">
                <mat-form-field appearance="fill" class="flex-1">
                  <mat-label>{{ 'alerts.action.command' | translate }}</mat-label>
                  <mat-icon matPrefix svgIcon="terminal" class="prefix-icon"></mat-icon>
                  <input
                    matInput
                    formControlName="command"
                    placeholder="/usr/local/bin/notify.sh"
                    class="code-font"
                  />
                </mat-form-field>
                <button
                  mat-icon-button
                  type="button"
                  (click)="browseScript()"
                  [matTooltip]="'common.browse' | translate"
                >
                  <mat-icon svgIcon="folder-open"></mat-icon>
                </button>
              </div>

              <mat-form-field appearance="fill" class="full-width">
                <mat-label>{{ 'alerts.action.args' | translate }}</mat-label>
                <input
                  matInput
                  formControlName="argsRaw"
                  [placeholder]="'alerts.action.argsHint' | translate"
                  class="code-font"
                />
              </mat-form-field>

              <div class="form-row">
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
            <div class="kind-fields">
              <div class="info-box accent">
                <mat-icon svgIcon="desktop"></mat-icon>
                <span>{{ 'alerts.action.os_toast_info' | translate }}</span>
              </div>
            </div>
          }

          <!-- Telegram Fields -->
          @if (form.controls.kind.value === 'telegram') {
            <div class="kind-fields">
              <mat-form-field appearance="fill" class="full-width">
                <mat-label>{{ 'alerts.action.botToken' | translate }}</mat-label>
                <mat-icon matPrefix svgIcon="key" class="prefix-icon"></mat-icon>
                <input
                  matInput
                  type="password"
                  formControlName="bot_token"
                  placeholder="123456789:ABCDefGHiJKlmnoPQRstUVwxyz_abc"
                />
                @if (form.controls.bot_token.hasError('required')) {
                  <mat-error>{{ 'common.required' | translate }}</mat-error>
                }
              </mat-form-field>

              <mat-form-field appearance="fill" class="full-width">
                <mat-label>{{ 'alerts.action.chatId' | translate }}</mat-label>
                <mat-icon matPrefix svgIcon="comment" class="prefix-icon"></mat-icon>
                <input
                  matInput
                  formControlName="chat_id"
                  placeholder="-1001234567890 or 1234567890"
                />
                @if (form.controls.chat_id.hasError('required')) {
                  <mat-error>{{ 'common.required' | translate }}</mat-error>
                }
              </mat-form-field>

              <div class="form-row">
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
                <mat-label>{{ 'alerts.action.messageTemplate' | translate }}</mat-label>
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
                    >{{ 'alerts.action.messageTemplateHint' | translate }}:</span
                  >
                  <div class="tags-container">
                    @for (key of templateKeys(); track key) {
                      <span class="code-tag">{{ '{{' }}{{ key }}{{ '}}' }}</span>
                    }
                  </div>
                </div>
              </div>

              <div class="info-box accent">
                <mat-icon svgIcon="info"></mat-icon>
                <span>{{ 'alerts.action.telegram_info' | translate }}</span>
              </div>
            </div>
          }

          <!-- MQTT Fields -->
          @if (form.controls.kind.value === 'mqtt') {
            <div class="kind-fields">
              <div class="form-row">
                <mat-form-field appearance="fill" class="flex-2">
                  <mat-label>{{ 'alerts.action.host' | translate }}</mat-label>
                  <mat-icon matPrefix svgIcon="link" class="prefix-icon"></mat-icon>
                  <input matInput formControlName="host" placeholder="localhost" />
                  @if (form.controls.host.hasError('required')) {
                    <mat-error>{{ 'common.required' | translate }}</mat-error>
                  }
                </mat-form-field>

                <mat-form-field appearance="fill" class="flex-1">
                  <mat-label>{{ 'alerts.action.port' | translate }}</mat-label>
                  <input matInput type="number" formControlName="port" />
                </mat-form-field>

                <div class="flex-1 toggle-container align-center d-flex">
                  <mat-slide-toggle formControlName="use_tls" color="primary">
                    {{ 'alerts.action.useTls' | translate }}
                  </mat-slide-toggle>
                </div>
              </div>

              <mat-form-field appearance="fill" class="full-width">
                <mat-label>{{ 'alerts.action.topic' | translate }}</mat-label>
                <mat-icon matPrefix svgIcon="tag" class="prefix-icon"></mat-icon>
                <input matInput formControlName="topic" placeholder="rclone/alerts" />
                @if (form.controls.topic.hasError('required')) {
                  <mat-error>{{ 'common.required' | translate }}</mat-error>
                }
              </mat-form-field>

              <div class="form-row">
                <mat-form-field appearance="fill" class="flex-1">
                  <mat-label>{{ 'common.username' | translate }}</mat-label>
                  <input matInput formControlName="username" />
                </mat-form-field>

                <mat-form-field appearance="fill" class="flex-1">
                  <mat-label>{{ 'common.password' | translate }}</mat-label>
                  <input matInput type="password" formControlName="password" />
                </mat-form-field>
              </div>

              <div class="form-row">
                <mat-form-field appearance="fill" class="flex-1">
                  <mat-label>{{ 'alerts.action.qos' | translate }}</mat-label>
                  <mat-select formControlName="qos">
                    <mat-option [value]="0">0 - At most once</mat-option>
                    <mat-option [value]="1">1 - At least once</mat-option>
                    <mat-option [value]="2">2 - Exactly once</mat-option>
                  </mat-select>
                </mat-form-field>

                <div class="flex-1 toggle-container align-center d-flex">
                  <mat-slide-toggle formControlName="retain" color="primary">
                    {{ 'alerts.action.retain' | translate }}
                  </mat-slide-toggle>
                </div>
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
                    >{{ 'alerts.action.messageTemplateHint' | translate }}:</span
                  >
                  <div class="tags-container">
                    @for (key of templateKeys(); track key) {
                      <span class="code-tag">{{ '{{' }}{{ key }}{{ '}}' }}</span>
                    }
                  </div>
                </div>
              </div>
            </div>
          }

          <!-- Email Fields -->
          @if (form.controls.kind.value === 'email') {
            <div class="kind-fields">
              <div class="form-row">
                <mat-form-field appearance="fill" class="flex-2">
                  <mat-label>{{ 'alerts.action.smtpServer' | translate }}</mat-label>
                  <input matInput formControlName="smtp_server" placeholder="smtp.gmail.com" />
                  @if (form.controls.smtp_server.hasError('required')) {
                    <mat-error>{{ 'common.required' | translate }}</mat-error>
                  }
                </mat-form-field>

                <mat-form-field appearance="fill" class="flex-1">
                  <mat-label>{{ 'alerts.action.smtpPort' | translate }}</mat-label>
                  <input matInput type="number" formControlName="smtp_port" />
                </mat-form-field>
              </div>

              <div class="form-row">
                <mat-form-field appearance="fill" class="flex-1">
                  <mat-label>{{ 'common.username' | translate }}</mat-label>
                  <input matInput formControlName="username" />
                </mat-form-field>

                <mat-form-field appearance="fill" class="flex-1">
                  <mat-label>{{ 'common.password' | translate }}</mat-label>
                  <input matInput type="password" formControlName="password" />
                </mat-form-field>
              </div>

              <div class="form-row">
                <mat-form-field appearance="fill" class="flex-1">
                  <mat-label>{{ 'alerts.action.from' | translate }}</mat-label>
                  <input matInput formControlName="from" placeholder="alerts@example.com" />
                </mat-form-field>

                <mat-form-field appearance="fill" class="flex-1">
                  <mat-label>{{ 'alerts.action.to' | translate }}</mat-label>
                  <input matInput formControlName="to" placeholder="you@example.com" />
                  @if (form.controls.to.hasError('required')) {
                    <mat-error>{{ 'common.required' | translate }}</mat-error>
                  }
                </mat-form-field>
              </div>

              <mat-form-field appearance="fill" class="full-width">
                <mat-label>{{ 'alerts.action.encryption' | translate }}</mat-label>
                <mat-select formControlName="encryption">
                  <mat-option value="none">None</mat-option>
                  <mat-option value="tls">TLS (Port 465)</mat-option>
                  <mat-option value="starttls">StartTLS (Port 587)</mat-option>
                </mat-select>
              </mat-form-field>

              <div class="form-row">
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
                <mat-label>{{ 'alerts.action.subjectTemplate' | translate }}</mat-label>
                <input matInput formControlName="subject_template" />
              </mat-form-field>

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
                    >{{ 'alerts.action.messageTemplateHint' | translate }}:</span
                  >
                  <div class="tags-container">
                    @for (key of templateKeys(); track key) {
                      <span class="code-tag">{{ '{{' }}{{ key }}{{ '}}' }}</span>
                    }
                  </div>
                </div>
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
        font-family: var(--font-mono);
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
          font-family: var(--font-mono);
          font-size: 0.85em;
          color: var(--accent-color);
        }
      }
      .preset-btn {
        margin-right: 8px;
        font-size: 13px;
      }
      .headers-section {
        background: rgba(var(--mat-sys-primary-rgb), 0.05);
        border-radius: 8px;
        padding: 12px;
        margin-top: 8px;
      }
      .header-row {
        margin-bottom: 4px;
      }
      .dense-form-field {
        font-size: 12px;
      }
      .label-small {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        color: var(--mat-sys-outline);
        margin-bottom: 8px;
        display: block;
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
  private fileSystem = inject(FileSystemService);
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
    body_template: ['{{title}}: {{body}}'],
    timeout_secs: [10],
    tls_verify: [true],
    retry_count: [1],
    headers: this.fb.array<any>([]),
    webhook_preset: ['generic'],

    // Script specific
    command: [''],
    argsRaw: [''],

    // Telegram specific
    bot_token: [''],
    chat_id: [''],

    // MQTT specific
    host: ['localhost'],
    port: [1883],
    use_tls: [false],
    topic: ['rclone/alerts'],
    qos: [0],
    retain: [false],

    // Email specific
    smtp_server: [''],
    smtp_port: [587],
    from: [''],
    to: [''],
    subject_template: ['Rclone Alert: {{title}}'],
    encryption: ['starttls'],
    username: [''],
    password: [''],
  });

  constructor() {
    if (this.data) {
      const patchValue: any = { ...this.data };
      if (this.data.kind === 'script') {
        patchValue.argsRaw = (this.data as ScriptAction).args.join(' ');
      }

      if (this.data.kind === 'webhook') {
        const webhook = this.data as WebhookAction;
        // Populate headers FormArray
        const headersArray = this.form.controls.headers;
        headersArray.clear();
        if (webhook.headers) {
          Object.entries(webhook.headers).forEach(([key, value]) => {
            headersArray.push(
              this.fb.group({
                key: [key, Validators.required],
                value: [value, Validators.required],
              }) as any
            );
          });
        }
        delete patchValue.headers;
      }

      // Migration for old MQTT actions that used a single broker_url string
      if (this.data.kind === 'mqtt' && (this.data as any).broker_url) {
        const url = (this.data as any).broker_url as string;
        patchValue.use_tls = url.startsWith('mqtts://');

        const hostPort = url.replace('mqtt://', '').replace('mqtts://', '').split(':');
        patchValue.host = hostPort[0] || 'localhost';
        if (hostPort[1]) {
          patchValue.port = parseInt(hostPort[1], 10);
        } else {
          patchValue.port = patchValue.use_tls ? 8883 : 1883;
        }
      }

      this.form.patchValue(patchValue);
    }
    this.onKindChange();

    this.alertService.getTemplateKeys().subscribe(keys => this.templateKeys.set(keys));
  }

  onKindChange(): void {
    const kind = this.form.controls.kind.value;
    if (kind === 'webhook') {
      this.form.controls.url.setValidators([Validators.required]);
      this.clearOtherValidators(['url']);
    } else if (kind === 'script') {
      this.form.controls.command.setValidators([Validators.required]);
      this.clearOtherValidators(['command']);
    } else if (kind === 'telegram') {
      this.form.controls.bot_token.setValidators([Validators.required]);
      this.form.controls.chat_id.setValidators([Validators.required]);
      this.clearOtherValidators(['bot_token', 'chat_id']);
    } else if (kind === 'mqtt') {
      this.form.controls.host.setValidators([Validators.required]);
      this.form.controls.topic.setValidators([Validators.required]);
      this.clearOtherValidators(['host', 'topic']);
    } else if (kind === 'email') {
      this.form.controls.smtp_server.setValidators([Validators.required]);
      this.form.controls.to.setValidators([Validators.required]);
      this.clearOtherValidators(['smtp_server', 'to']);
    } else {
      this.clearOtherValidators([]);
    }

    Object.keys(this.form.controls).forEach(key => {
      this.form.get(key)?.updateValueAndValidity();
    });
  }

  private clearOtherValidators(exclude: string[]): void {
    const fieldsToClear = [
      'url',
      'command',
      'bot_token',
      'chat_id',
      'host',
      'topic',
      'smtp_server',
      'to',
    ];
    fieldsToClear.forEach(field => {
      if (!exclude.includes(field)) {
        this.form.get(field)?.clearValidators();
      }
    });
  }

  get headers() {
    return this.form.get('headers') as FormArray;
  }

  addHeader() {
    this.headers.push(
      this.fb.group({
        key: ['', Validators.required],
        value: ['', Validators.required],
      }) as any
    );
  }

  removeHeader(index: number) {
    this.headers.removeAt(index);
  }

  async browseScript() {
    try {
      const path = await this.fileSystem.selectFile();
      if (path) {
        this.form.patchValue({ command: path });
      }
    } catch {
      // User cancelled
    }
  }

  applyPreset(preset: string) {
    if (preset === 'discord') {
      this.form.patchValue({
        method: 'POST',
        body_template: JSON.stringify(
          {
            content: '@everyone',
            embeds: [
              {
                title: '{{title}}',
                description: '{{body}}',
                color: 5814783,
                fields: [
                  { name: 'Severity', value: '{{severity}}', inline: true },
                  { name: 'Time', value: '{{timestamp}}', inline: true },
                ],
              },
            ],
          },
          null,
          2
        ),
      });
      // Add Content-Type header if not exists
      if (!this.headers.value.some((h: any) => h.key.toLowerCase() === 'content-type')) {
        this.headers.push(
          this.fb.group({ key: ['Content-Type'], value: ['application/json'] }) as any
        );
      }
    } else if (preset === 'slack') {
      this.form.patchValue({
        method: 'POST',
        body_template: JSON.stringify(
          {
            text: '*{{title}}*\n{{body}}\n_Severity: {{severity}}_',
          },
          null,
          2
        ),
      });
      if (!this.headers.value.some((h: any) => h.key.toLowerCase() === 'content-type')) {
        this.headers.push(
          this.fb.group({ key: ['Content-Type'], value: ['application/json'] }) as any
        );
      }
    }
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
      const headerMap: Record<string, string> = {};
      this.headers.value.forEach((h: any) => {
        if (h.key && h.value) headerMap[h.key] = h.value;
      });

      action = {
        ...action,
        url: val.url,
        method: val.method,
        headers: headerMap,
        body_template: val.body_template,
        timeout_secs: val.timeout_secs,
        tls_verify: val.tls_verify,
        retry_count: val.retry_count,
      };
    } else if (kind === 'script') {
      action = {
        ...action,
        command: val.command,
        args: val.argsRaw ? val.argsRaw.split(' ') : [],
        timeout_secs: val.timeout_secs,
        retry_count: val.retry_count,
        env_vars: this.data?.kind === 'script' ? (this.data as ScriptAction).env_vars : {},
      };
    } else if (kind === 'telegram') {
      action = {
        ...action,
        bot_token: val.bot_token,
        chat_id: val.chat_id,
        body_template: val.body_template,
        timeout_secs: val.timeout_secs,
        retry_count: val.retry_count,
      };
    } else if (kind === 'mqtt') {
      action = {
        ...action,
        host: val.host,
        port: val.port,
        use_tls: val.use_tls,
        topic: val.topic,
        username: val.username,
        password: val.password,
        qos: val.qos,
        retain: val.retain,
        body_template: val.body_template,
        timeout_secs: val.timeout_secs,
        retry_count: val.retry_count,
      };
    } else if (kind === 'email') {
      action = {
        ...action,
        smtp_server: val.smtp_server,
        smtp_port: val.smtp_port,
        username: val.username,
        password: val.password,
        from: val.from,
        to: val.to,
        subject_template: val.subject_template,
        body_template: val.body_template,
        encryption: val.encryption,
        timeout_secs: val.timeout_secs,
        retry_count: val.retry_count,
      };
    }

    this.modalService.animatedClose(this.dialogRef, action);
  }

  cancel(): void {
    this.modalService.animatedClose(this.dialogRef);
  }
}
