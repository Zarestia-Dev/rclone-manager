import { Component, inject, signal, ChangeDetectionStrategy } from '@angular/core';
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

import { AlertRule, AlertEventKind, AlertSeverity, AlertAction, Origin } from '@app/types';
import { AlertService, RemoteFacadeService } from '@app/services';

@Component({
  selector: 'app-alert-rule-editor',
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
      <mat-icon [svgIcon]="data ? 'check-list' : 'plus'"></mat-icon>
      {{ (data ? 'alerts.editRule' : 'alerts.createRule') | translate }}
    </h2>

    <mat-dialog-content class="editor-content hide-scrollbar">
      <form [formGroup]="form" (ngSubmit)="save()" class="editor-form">
        <div class="form-section">
          <mat-form-field>
            <mat-label>{{ 'alerts.ruleName' | translate }}</mat-label>
            <input
              matInput
              formControlName="name"
              [placeholder]="'alerts.rule.placeholderName' | translate"
            />
            @if (form.controls.name.hasError('required')) {
              <mat-error>{{ 'common.required' | translate }}</mat-error>
            }
          </mat-form-field>

          <mat-slide-toggle formControlName="enabled">
            {{ 'alerts.enabled' | translate }}
          </mat-slide-toggle>
        </div>

        <mat-divider class="my-4"></mat-divider>
        <h3 class="section-title">{{ 'alerts.rule.filters' | translate }}</h3>

        <div class="form-section">
          <div class="form-row">
            <mat-form-field class="flex-1">
              <mat-label>{{ 'alerts.rule.severityMin' | translate }}</mat-label>
              <mat-select formControlName="severity_min">
                @for (s of severities; track s) {
                  <mat-option [value]="s">{{
                    'alerts.severityLevels.' + s | translate
                  }}</mat-option>
                }
              </mat-select>
            </mat-form-field>

            <mat-form-field class="flex-1">
              <mat-label>{{ 'alerts.rule.cooldown' | translate }}</mat-label>
              <input matInput type="number" formControlName="cooldown_secs" min="0" />
            </mat-form-field>
          </div>

          <mat-form-field>
            <mat-label>{{ 'alerts.rule.eventFilter' | translate }}</mat-label>
            <mat-select formControlName="event_filter" multiple>
              @for (e of eventKinds; track e) {
                <mat-option [value]="e">{{ 'alerts.events.' + e | translate }}</mat-option>
              }
            </mat-select>
            <mat-hint>Leave empty to match all event types.</mat-hint>
          </mat-form-field>

          <mat-form-field>
            <mat-label>{{ 'alerts.rule.remoteFilter' | translate }}</mat-label>
            <mat-select formControlName="remote_filter" multiple>
              @for (r of remotes(); track r.name) {
                <mat-option [value]="r.name">{{ r.name }}</mat-option>
              }
            </mat-select>
            <mat-hint>Leave empty to match all remotes.</mat-hint>
          </mat-form-field>

          <mat-form-field>
            <mat-label>{{ 'alerts.origins.title' | translate }}</mat-label>
            <mat-select formControlName="origin_filter" multiple>
              @for (o of origins; track o) {
                <mat-option [value]="o">{{ 'alerts.origins.' + o | translate }}</mat-option>
              }
            </mat-select>
            <mat-hint>Leave empty to match any origin source.</mat-hint>
          </mat-form-field>
        </div>

        <mat-divider class="my-4"></mat-divider>
        <h3 class="section-title">{{ 'alerts.rule.actions' | translate }}</h3>

        <div class="form-section">
          <mat-form-field>
            <mat-label>{{ 'alerts.actions' | translate }}</mat-label>
            <mat-select formControlName="action_ids" multiple>
              @for (a of actions(); track a.id) {
                <mat-option [value]="a.id">
                  {{ a.name }} ({{ 'alerts.action.' + a.kind | translate }})
                </mat-option>
              }
            </mat-select>
            @if (form.controls.action_ids.hasError('required')) {
              <mat-error>{{ 'common.required' | translate }}</mat-error>
            }
          </mat-form-field>
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
      .editor-content {
        min-width: 500px;
        max-width: 600px;
        padding-top: var(--space-md) !important;
      }

      .editor-form {
        display: flex;
        flex-direction: column;
      }

      .form-section {
        display: flex;
        flex-direction: column;
        gap: var(--space-sm);
        padding-bottom: var(--space-xs);
      }

      .section-title {
        font-size: 0.8rem;
        font-weight: 700;
        color: var(--accent-color);
        margin: 0 0 var(--space-md) 0;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }

      .form-row {
        display: flex;
        gap: var(--space-md);
        align-items: flex-start;

        .flex-1 {
          flex: 1;
        }
      }

      .my-4 {
        margin-top: var(--space-md);
        margin-bottom: var(--space-md);
        opacity: 0.6;
      }

      mat-slide-toggle {
        margin: var(--space-xs) 0;
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AlertRuleEditorComponent {
  private fb = inject(FormBuilder);
  private dialogRef = inject(MatDialogRef<AlertRuleEditorComponent>);
  private alertService = inject(AlertService);
  private remoteFacade = inject(RemoteFacadeService);

  data = inject(MAT_DIALOG_DATA) as AlertRule | undefined;

  remotes = this.remoteFacade.activeRemotes;
  actions = signal<AlertAction[]>([]);

  severities: AlertSeverity[] = ['info', 'warning', 'average', 'high', 'critical'];
  eventKinds: AlertEventKind[] = [
    'any',
    'job_completed',
    'job_started',
    'job_failed',
    'job_stopped',
    'serve_started',
    'serve_failed',
    'serve_stopped',
    'all_serves_stopped',
    'mount_succeeded',
    'mount_failed',
    'unmount_succeeded',
    'all_unmounted',
    'engine_password_required',
    'engine_binary_not_found',
    'engine_connection_failed',
    'engine_restarted',
    'engine_restart_failed',
    'app_update_available',
    'app_update_started',
    'app_update_complete',
    'app_update_failed',
    'app_update_installed',
    'rclone_update_available',
    'rclone_update_started',
    'rclone_update_complete',
    'rclone_update_failed',
    'rclone_update_installed',
    'scheduled_task_started',
    'scheduled_task_completed',
    'scheduled_task_failed',
    'already_running',
    'all_jobs_stopped',
  ];
  origins: Origin[] = ['dashboard', 'scheduler', 'filemanager', 'startup', 'update', 'internal'];

  form = this.fb.nonNullable.group({
    id: [''],
    name: ['', Validators.required],
    enabled: [true],
    severity_min: ['warning' as AlertSeverity, Validators.required],
    cooldown_secs: [0],
    event_filter: [[] as AlertEventKind[]],
    remote_filter: [[] as string[]],
    origin_filter: [[] as Origin[]],
    action_ids: [[] as string[], Validators.required],
    created_at: [new Date().toISOString()],
    fire_count: [0],
  });

  constructor() {
    this.alertService.getAlertActions().subscribe(actions => this.actions.set(actions));
    if (this.data) this.form.patchValue(this.data);
  }

  save() {
    if (this.form.invalid) return;
    this.dialogRef.close(this.form.getRawValue());
  }

  cancel() {
    this.dialogRef.close();
  }
}
