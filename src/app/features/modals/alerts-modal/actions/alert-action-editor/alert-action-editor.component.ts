import { Component, inject, ChangeDetectionStrategy, signal, HostListener } from '@angular/core';
import { ReactiveFormsModule, FormBuilder, Validators, FormArray } from '@angular/forms';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslateModule } from '@ngx-translate/core';
import { ModalService, AlertService, FileSystemService } from '@app/services';
import { AlertAction, AlertActionKind, ScriptAction, WebhookAction } from '@app/types';

export interface KindOption {
  value: AlertActionKind;
  label: string;
}

@Component({
  selector: 'app-alert-action-editor',
  standalone: true,
  templateUrl: './alert-action-editor.component.html',
  styleUrls: ['./alert-action-editor.component.scss', '../../../../../styles/_shared-modal.scss'],
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
export class AlertActionEditorComponent {
  private readonly fb = inject(FormBuilder);
  private readonly dialogRef = inject(MatDialogRef<AlertActionEditorComponent>);
  private readonly modalService = inject(ModalService);
  public readonly alertService = inject(AlertService);
  private readonly fileSystem = inject(FileSystemService);

  private readonly dialogData = inject(MAT_DIALOG_DATA) as { actionId?: string } | undefined;
  readonly data?: AlertAction;
  templateKeys = signal<string[]>([]);

  readonly kinds: KindOption[] = [
    { value: 'os_toast', label: 'alerts.action.os_toast' },
    { value: 'webhook', label: 'alerts.action.webhook' },
    { value: 'script', label: 'alerts.action.script' },
    { value: 'telegram', label: 'alerts.action.telegram' },
    { value: 'mqtt', label: 'alerts.action.mqtt' },
    { value: 'email', label: 'alerts.action.email' },
  ];

  get selectedKindIcon(): string {
    return this.alertService.getActionIcon(this.form.controls.kind.value);
  }

  form = this.fb.nonNullable.group({
    id: [''],
    name: ['', Validators.required],
    kind: ['webhook' as AlertActionKind, Validators.required],
    enabled: [true],
    // Webhook
    url: [''],
    method: ['POST'],
    body_template: ['{{title}}: {{body}}'],
    timeout_secs: [10],
    tls_verify: [true],
    retry_count: [1],
    headers: this.fb.array<any>([]),
    // Script
    command: [''],
    argsRaw: [''],
    // Telegram
    bot_token: [''],
    chat_id: [''],
    // MQTT
    host: ['localhost'],
    port: [1883],
    use_tls: [false],
    topic: ['rclone/alerts'],
    qos: [0],
    retain: [false],
    // Email
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
    this.data = this.dialogData?.actionId
      ? this.alertService.actions().find(a => a.id === this.dialogData!.actionId)
      : undefined;

    if (this.data) {
      const patch: any = { ...this.data };

      if (this.data.kind === 'script') {
        patch.argsRaw = (this.data as ScriptAction).args.join(' ');
      }

      if (this.data.kind === 'webhook') {
        const webhook = this.data as WebhookAction;
        this.headers.clear();
        if (webhook.headers) {
          Object.entries(webhook.headers).forEach(([key, value]) => {
            this.headers.push(
              this.fb.group({
                key: [key, Validators.required],
                value: [value, Validators.required],
              }) as any
            );
          });
        }
        delete patch.headers;
      }

      // Migrate old MQTT broker_url string
      if (this.data.kind === 'mqtt' && (this.data as any).broker_url) {
        const url = (this.data as any).broker_url as string;
        patch.use_tls = url.startsWith('mqtts://');
        const parts = url.replace(/^mqtts?:\/\//, '').split(':');
        patch.host = parts[0] || 'localhost';
        patch.port = parts[1] ? parseInt(parts[1], 10) : patch.use_tls ? 8883 : 1883;
      }

      this.form.patchValue(patch);
    }

    this.onKindChange();
    this.alertService.getTemplateKeys().then(keys => this.templateKeys.set(keys));
  }

  // ── Kind selection ───────────────────────────────────────────────

  selectKind(value: AlertActionKind): void {
    this.form.controls.kind.setValue(value);
    this.onKindChange();
  }

  onKindChange(): void {
    const all = ['url', 'command', 'bot_token', 'chat_id', 'host', 'topic', 'smtp_server', 'to'];
    all.forEach(f => this.form.get(f)?.clearValidators());

    const kind = this.form.controls.kind.value;
    const required = (fields: string[]) =>
      fields.forEach(f => this.form.get(f)?.setValidators([Validators.required]));

    if (kind === 'webhook') required(['url']);
    else if (kind === 'script') required(['command']);
    else if (kind === 'telegram') required(['bot_token', 'chat_id']);
    else if (kind === 'mqtt') required(['host', 'topic']);
    else if (kind === 'email') required(['smtp_server', 'to']);

    Object.keys(this.form.controls).forEach(k => this.form.get(k)?.updateValueAndValidity());
  }

  // ── Headers ──────────────────────────────────────────────────────

  get headers() {
    return this.form.get('headers') as FormArray;
  }

  addHeader(): void {
    this.headers.push(
      this.fb.group({ key: ['', Validators.required], value: ['', Validators.required] }) as any
    );
  }

  removeHeader(index: number): void {
    this.headers.removeAt(index);
  }

  // ── Script browse ────────────────────────────────────────────────

  async browseScript(): Promise<void> {
    try {
      const path = await this.fileSystem.selectFile();
      if (path) this.form.patchValue({ command: path });
    } catch {
      /* user cancelled */
    }
  }

  // ── Presets ──────────────────────────────────────────────────────

  applyPreset(preset: 'discord' | 'slack'): void {
    const contentType = { key: 'Content-Type', value: 'application/json' };
    const hasContentType = this.headers.value.some(
      (h: any) => h.key?.toLowerCase() === 'content-type'
    );

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
    } else {
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
    }

    if (!hasContentType) {
      this.headers.push(this.fb.group(contentType) as any);
    }
  }

  // ── Save / Cancel ────────────────────────────────────────────────

  save(): void {
    if (this.form.invalid) return;

    const val = this.form.getRawValue();
    const base = { id: val.id || '', name: val.name, kind: val.kind, enabled: val.enabled };
    let action: any = base;

    if (val.kind === 'webhook') {
      const headerMap: Record<string, string> = {};
      this.headers.value.forEach((h: any) => {
        if (h.key && h.value) headerMap[h.key] = h.value;
      });
      action = {
        ...base,
        url: val.url,
        method: val.method,
        headers: headerMap,
        body_template: val.body_template,
        timeout_secs: val.timeout_secs,
        tls_verify: val.tls_verify,
        retry_count: val.retry_count,
      };
    } else if (val.kind === 'script') {
      action = {
        ...base,
        command: val.command,
        args: val.argsRaw ? val.argsRaw.split(' ') : [],
        timeout_secs: val.timeout_secs,
        retry_count: val.retry_count,
        env_vars: this.data?.kind === 'script' ? (this.data as ScriptAction).env_vars : {},
      };
    } else if (val.kind === 'telegram') {
      action = {
        ...base,
        bot_token: val.bot_token,
        chat_id: val.chat_id,
        body_template: val.body_template,
        timeout_secs: val.timeout_secs,
        retry_count: val.retry_count,
      };
    } else if (val.kind === 'mqtt') {
      action = {
        ...base,
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
    } else if (val.kind === 'email') {
      action = {
        ...base,
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

  @HostListener('document:keydown.escape')
  cancel(): void {
    this.modalService.animatedClose(this.dialogRef);
  }
}
