import { Component, inject, computed, ChangeDetectionStrategy } from '@angular/core';
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

import { AlertRule, AlertEventKind, AlertSeverity, Origin } from '@app/types';
import { AlertService, RemoteFacadeService, BackendService } from '@app/services';

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
            <mat-hint>{{ 'alerts.rule.eventFilterHint' | translate }}</mat-hint>
          </mat-form-field>

          <mat-form-field>
            <mat-label>{{ 'alerts.rule.remoteFilter' | translate }}</mat-label>
            <mat-select formControlName="remote_filter" multiple>
              @for (r of remotes(); track r.name) {
                <mat-option [value]="r.name">{{ r.name }}</mat-option>
              }
            </mat-select>
            <mat-hint>{{ 'alerts.rule.remoteFilterHint' | translate }}</mat-hint>
          </mat-form-field>

          <mat-form-field>
            <mat-label>{{ 'alerts.rule.backendFilter' | translate }}</mat-label>
            <mat-select formControlName="backend_filter" multiple>
              @for (b of backends(); track b.name) {
                <mat-option [value]="b.name">{{ b.name }}</mat-option>
              }
            </mat-select>
            <mat-hint>{{ 'alerts.rule.backendFilterHint' | translate }}</mat-hint>
          </mat-form-field>

          <mat-form-field>
            <mat-label>{{ 'alerts.rule.profileFilter' | translate }}</mat-label>
            <mat-select formControlName="profile_filter" multiple>
              @for (p of allProfiles(); track p) {
                <mat-option [value]="p">{{ p }}</mat-option>
              }
            </mat-select>
            <mat-hint>{{ 'alerts.rule.profileFilterHint' | translate }}</mat-hint>
          </mat-form-field>

          <mat-form-field>
            <mat-label>{{ 'alerts.origins.title' | translate }}</mat-label>
            <mat-select formControlName="origin_filter" multiple>
              @for (o of origins; track o) {
                <mat-option [value]="o">{{ 'alerts.origins.' + o | translate }}</mat-option>
              }
            </mat-select>
            <mat-hint>{{ 'alerts.rule.originFilterHint' | translate }}</mat-hint>
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
  private backendService = inject(BackendService);

  data = inject(MAT_DIALOG_DATA) as AlertRule | undefined;

  remotes = this.remoteFacade.activeRemotes;
  backends = this.backendService.backends;
  actions = this.alertService.actions;

  allProfiles = computed(() => {
    const profiles = new Set<string>();
    this.remotes().forEach(r => {
      const s = r.status;
      [s.sync, s.copy, s.bisync, s.move, s.mount, s.serve].forEach(op => {
        op.configuredProfiles?.forEach(p => profiles.add(p));
      });
    });
    return Array.from(profiles).sort();
  });

  severities: AlertSeverity[] = ['info', 'warning', 'average', 'high', 'critical'];
  eventKinds: AlertEventKind[] = [
    'any',
    'job',
    'serve',
    'mount',
    'engine',
    'update',
    'scheduled_task',
    'system',
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
    backend_filter: [[] as string[]],
    profile_filter: [[] as string[]],
    origin_filter: [[] as Origin[]],
    action_ids: [[] as string[], [Validators.required, Validators.minLength(1)]],
    created_at: [new Date().toISOString()],
    last_fired: [undefined as string | undefined],
    fire_count: [0],
  });

  constructor() {
    if (this.data) this.form.patchValue(this.data);
  }

  save(): void {
    if (this.form.invalid) return;
    const val = this.form.getRawValue();
    if (!val.action_ids.length) return;
    this.dialogRef.close(val);
  }

  cancel(): void {
    this.dialogRef.close();
  }
}
