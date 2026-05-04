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
import { MatTooltipModule } from '@angular/material/tooltip';
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
        <div class="form-section panel">
          <mat-form-field appearance="fill">
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

          <div class="toggle-container">
            <mat-slide-toggle formControlName="enabled" color="primary">
              {{ 'alerts.enabled' | translate }}
            </mat-slide-toggle>

            <mat-slide-toggle
              formControlName="auto_acknowledge"
              color="primary"
              [matTooltip]="'alerts.rule.autoAcknowledgeHint' | translate"
            >
              {{ 'alerts.rule.autoAcknowledge' | translate }}
            </mat-slide-toggle>
          </div>
        </div>

        <h3 class="section-title mt-md">
          <mat-icon svgIcon="bell" class="sm-icon"></mat-icon>
          {{ 'alerts.rule.actions' | translate }}
        </h3>

        <div class="form-section panel">
          <mat-form-field appearance="fill">
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

        <h3 class="section-title mt-md">
          <mat-icon svgIcon="filter" class="sm-icon"></mat-icon>
          {{ 'alerts.rule.filters' | translate }}
        </h3>

        <div class="form-section panel no-wrapper">
          <div class="form-row">
            <mat-form-field appearance="fill" class="flex-1">
              <mat-label>{{ 'alerts.rule.severityMin' | translate }}</mat-label>
              <mat-select formControlName="severity_min">
                @for (s of severities; track s) {
                  <mat-option [value]="s">
                    <div class="severity-option">
                      <div class="severity-indicator" [class]="s"></div>
                      {{ 'alerts.severityLevels.' + s | translate }}
                    </div>
                  </mat-option>
                }
              </mat-select>
            </mat-form-field>

            <mat-form-field appearance="fill" class="flex-1">
              <mat-label>{{ 'alerts.rule.cooldown' | translate }}</mat-label>
              <input matInput type="number" formControlName="cooldown_secs" min="0" />
              <span matSuffix class="suffix-text">sec</span>
            </mat-form-field>
          </div>

          <div class="form-row">
            <mat-form-field appearance="fill" class="flex-1">
              <mat-label>{{ 'alerts.rule.eventFilter' | translate }}</mat-label>
              <mat-icon
                matPrefix
                svgIcon="circle-info"
                [matTooltip]="'alerts.rule.eventFilterHint' | translate"
              ></mat-icon>
              <mat-select formControlName="event_filter" multiple>
                @for (e of eventKinds; track e) {
                  <mat-option [value]="e">{{ 'alerts.events.' + e | translate }}</mat-option>
                }
              </mat-select>
            </mat-form-field>

            <mat-form-field appearance="fill" class="flex-1">
              <mat-label>{{ 'alerts.rule.remoteFilter' | translate }}</mat-label>
              <mat-icon
                matPrefix
                svgIcon="circle-info"
                [matTooltip]="'alerts.rule.remoteFilterHint' | translate"
              ></mat-icon>
              <mat-select formControlName="remote_filter" multiple>
                @for (r of remotes(); track r.name) {
                  <mat-option [value]="r.name">{{ r.name }}</mat-option>
                }
              </mat-select>
            </mat-form-field>
          </div>

          <div class="form-row">
            <mat-form-field appearance="fill" class="flex-1">
              <mat-label>{{ 'alerts.rule.backendFilter' | translate }}</mat-label>
              <mat-icon
                matPrefix
                svgIcon="circle-info"
                [matTooltip]="'alerts.rule.backendFilterHint' | translate"
              ></mat-icon>
              <mat-select formControlName="backend_filter" multiple>
                @for (b of backends(); track b.name) {
                  <mat-option [value]="b.name">{{ b.name }}</mat-option>
                }
              </mat-select>
            </mat-form-field>

            <mat-form-field appearance="fill" class="flex-1">
              <mat-label>{{ 'alerts.rule.profileFilter' | translate }}</mat-label>
              <mat-icon
                matPrefix
                svgIcon="circle-info"
                [matTooltip]="'alerts.rule.profileFilterHint' | translate"
              ></mat-icon>
              <mat-select formControlName="profile_filter" multiple>
                @for (p of allProfiles(); track p) {
                  <mat-option [value]="p">{{ p }}</mat-option>
                }
              </mat-select>
            </mat-form-field>
          </div>

          <mat-form-field appearance="fill">
            <mat-label>{{ 'alerts.origins.title' | translate }}</mat-label>
            <mat-icon
              matPrefix
              svgIcon="circle-info"
              [matTooltip]="'alerts.rule.originFilterHint' | translate"
            ></mat-icon>
            <mat-select formControlName="origin_filter" multiple>
              @for (o of origins; track o) {
                <mat-option [value]="o">{{ 'alerts.origins.' + o | translate }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
        </div>
      </form>
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button mat-button (click)="cancel()" type="button">{{ 'common.cancel' | translate }}</button>
      <button
        mat-flat-button
        color="primary"
        type="submit"
        [disabled]="form.invalid"
        (click)="save()"
      >
        {{ 'common.save' | translate }}
      </button>
    </mat-dialog-actions>
  `,
  styles: [
    `
      .editor-form {
        display: flex;
        flex-direction: column;
      }

      .panel {
        background: var(--bg-elevated);
        box-shadow: 0 0 0 1px var(--border-color);
        border-radius: var(--card-border-radius);
        padding: var(--space-md);
        margin-block: var(--space-xs) var(--space-md);
      }

      .section-title {
        font-size: 0.85rem;
        font-weight: 600;
        color: var(--text-muted);
        margin: 0;
        display: flex;
        align-items: center;
        gap: var(--space-xxs);
      }

      .form-section {
        display: flex;
        flex-direction: column;
      }

      .form-row {
        display: flex;
        gap: var(--space-md);
        align-items: flex-start;
      }

      .no-wrapper {
        display: flex;
        flex-direction: column;
        gap: var(--space-sm);

        mat-form-field {
          ::ng-deep .mat-mdc-form-field-subscript-wrapper {
            display: none;
          }
        }
      }

      .toggle-container {
        padding: var(--space-xs) 0;
        display: flex;
        gap: var(--space-lg);
        justify-content: space-between;
      }

      .suffix-text {
        color: var(--text-muted);
        margin-right: 4px;
        font-size: 0.9em;
      }

      .severity-option {
        display: flex;
        align-items: center;
        gap: var(--space-sm);
      }

      .severity-indicator {
        width: 10px;
        height: 10px;
        border-radius: 50%;

        &.info {
          background: var(--primary-color);
        }
        &.warning {
          background: var(--warn-color);
        }
        &.average {
          background: var(--accent-color);
        }
        &.high {
          background: var(--yellow);
        }
        &.critical {
          background: var(--orange);
        }
      }
    `,
  ],
  styleUrl: '../../../../styles/_shared-modal.scss',

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
    auto_acknowledge: [false],
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
