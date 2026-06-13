import { Component, inject, computed, ChangeDetectionStrategy, HostListener } from '@angular/core';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslateModule } from '@ngx-translate/core';

import { AlertRule, AlertEventKind, AlertSeverity, Origin } from '@app/types';
import { AlertService } from 'src/app/services/alerts/alert.service';
import { RemoteFacadeService } from 'src/app/services/facade/remote-facade.service';
import { BackendService } from 'src/app/services/infrastructure/system/backend.service';

@Component({
  selector: 'app-alert-rule-editor',
  standalone: true,
  templateUrl: './alert-rule-editor.component.html',
  styleUrls: ['./alert-rule-editor.component.scss', '../../../../../styles/_shared-modal.scss'],
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatSlideToggleModule,
    MatTooltipModule,
    TranslateModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AlertRuleEditorComponent {
  private readonly fb = inject(FormBuilder);
  private readonly dialogRef = inject(MatDialogRef<AlertRuleEditorComponent>);
  private readonly alertService = inject(AlertService);
  private readonly remoteFacade = inject(RemoteFacadeService);
  private readonly backendService = inject(BackendService);

  private readonly dialogData = inject(MAT_DIALOG_DATA) as { ruleId?: string } | undefined;
  readonly data?: AlertRule;
  readonly remotes = this.remoteFacade.activeRemotes;
  readonly backends = this.backendService.backends;
  readonly actions = this.alertService.actions;

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

  readonly severities: AlertSeverity[] = ['info', 'warning', 'average', 'high', 'critical'];

  readonly severityColors: Record<AlertSeverity, string> = {
    info: 'var(--primary-color)',
    warning: 'var(--warn-color)',
    average: 'var(--accent-color)',
    high: 'var(--yellow)',
    critical: 'var(--orange)',
  };

  readonly eventKinds: AlertEventKind[] = [
    'job',
    'serve',
    'mount',
    'engine',
    'update',
    'automation',
    'system',
  ];

  readonly origins: Origin[] = [
    'dashboard',
    'automation',
    'filemanager',
    'startup',
    'update',
    'internal',
  ];

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
    this.data = this.dialogData?.ruleId
      ? this.alertService.rules().find(r => r.id === this.dialogData!.ruleId)
      : undefined;

    if (this.data) this.form.patchValue(this.data);
  }

  save(): void {
    if (this.form.invalid) return;
    const val = this.form.getRawValue();
    if (!val.action_ids.length) return;
    this.dialogRef.close(val);
  }

  @HostListener('document:keydown.escape')
  cancel(): void {
    this.dialogRef.close();
  }
}
