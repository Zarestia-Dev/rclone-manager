import { Component, inject, ChangeDetectionStrategy, signal } from '@angular/core';
import {
  ReactiveFormsModule,
  FormBuilder,
  Validators,
  FormArray,
  FormGroup,
  FormControl,
} from '@angular/forms';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { EscapeCloseDirective } from '../../../../../shared/directives/escape-close.directive';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { TranslatePipe } from '@ngx-translate/core';
import { AlertService } from 'src/app/services/alerts/alert.service';
import { FileSystemService } from 'src/app/services/operations/file-system.service';
import { AlertAction, AlertActionKind, ScriptAction, KindOption } from '@app/types';
import { isHeadlessMode } from 'src/app/services/infrastructure/platform/api-client.service';
import { AlertBannerComponent } from 'src/app/shared/components/alert-banner/alert-banner.component';

export type HeaderFormGroup = FormGroup<{
  key: FormControl<string>;
  value: FormControl<string>;
}>;

type ActionFieldKey =
  | 'url'
  | 'command'
  | 'bot_token'
  | 'chat_id'
  | 'phone'
  | 'apikey'
  | 'gateway_url'
  | 'host'
  | 'topic'
  | 'smtp_server'
  | 'to';

@Component({
  selector: 'app-alert-action-editor',
  templateUrl: './alert-action-editor.component.html',
  styleUrls: ['./alert-action-editor.component.scss', '../../../../../styles/_shared-modal.scss'],
  hostDirectives: [EscapeCloseDirective],
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatSlideToggleModule,
    TranslatePipe,
    AlertBannerComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AlertActionEditorComponent {
  private readonly fb = inject(FormBuilder);
  private readonly dialogRef = inject(MatDialogRef<AlertActionEditorComponent>);
  public readonly alertService = inject(AlertService);
  private readonly fileSystem = inject(FileSystemService);

  private readonly dialogData = inject(MAT_DIALOG_DATA) as { actionId?: string } | undefined;
  readonly data?: AlertAction;
  templateKeys = signal<string[]>([]);

  readonly kinds: KindOption[] = [
    ...(isHeadlessMode()
      ? []
      : [{ value: 'os_toast' as AlertActionKind, label: 'alerts.action.os_toast' }]),
    { value: 'webhook', label: 'alerts.action.webhook' },
    { value: 'script', label: 'alerts.action.script' },
    { value: 'telegram', label: 'alerts.action.telegram' },
    { value: 'whatsapp', label: 'alerts.action.whatsapp' },
    { value: 'mqtt', label: 'alerts.action.mqtt' },
    { value: 'email', label: 'alerts.action.email' },
  ];

  get selectedKindIcon(): string {
    return this.alertService.getActionIcon(this.form.controls.kind.value);
  }

  readonly form = this.fb.nonNullable.group({
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
    headers: this.fb.array<HeaderFormGroup>([]),
    // Script
    command: [''],
    argsRaw: [''],
    // Telegram
    telegram_mode: ['bot' as 'bot' | 'botless'],
    bot_token: [''],
    chat_id: [''],
    // WhatsApp
    phone: [''],
    apikey: [''],
    whatsapp_provider: ['callmebot' as 'callmebot' | 'custom_gateway'],
    gateway_url: [''],
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
    const actionId = this.dialogData?.actionId;
    this.data = actionId ? this.alertService.actions().find(a => a.id === actionId) : undefined;

    if (this.data) {
      this.patchFormWithAction(this.data);
    }

    this.onKindChange();
    void this.alertService.getTemplateKeys().then(keys => this.templateKeys.set(keys));
  }

  private patchFormWithAction(action: AlertAction): void {
    this.form.patchValue({
      id: action.id,
      name: action.name,
      kind: action.kind,
      enabled: action.enabled,
    });

    switch (action.kind) {
      case 'webhook': {
        this.headers.clear();
        if (action.headers) {
          Object.entries(action.headers).forEach(([key, value]) => {
            this.headers.push(
              this.fb.nonNullable.group({
                key: [key, Validators.required],
                value: [value, Validators.required],
              })
            );
          });
        }
        this.form.patchValue({
          url: action.url,
          method: action.method,
          body_template: action.body_template,
          timeout_secs: action.timeout_secs,
          tls_verify: action.tls_verify,
          retry_count: action.retry_count,
        });
        break;
      }

      case 'script':
        this.form.patchValue({
          command: action.command,
          argsRaw: action.args.join(' '),
          timeout_secs: action.timeout_secs,
        });
        break;

      case 'telegram':
        this.form.patchValue({
          telegram_mode: action.mode || 'bot',
          bot_token: action.bot_token,
          chat_id: action.chat_id,
          body_template: action.body_template,
          timeout_secs: action.timeout_secs,
          retry_count: action.retry_count,
        });
        break;

      case 'whatsapp':
        this.form.patchValue({
          phone: action.phone,
          apikey: action.apikey,
          whatsapp_provider: action.provider || 'callmebot',
          gateway_url: action.gateway_url || '',
          body_template: action.body_template,
          timeout_secs: action.timeout_secs,
          retry_count: action.retry_count,
        });
        break;

      case 'mqtt': {
        let host = action.host;
        let port = action.port;
        let useTls = action.use_tls;
        // Migrate legacy MQTT broker_url string if present
        if (action.broker_url && !action.host) {
          useTls = action.broker_url.startsWith('mqtts://');
          const parts = action.broker_url.replace(/^mqtts?:\/\//, '').split(':');
          host = parts[0] || 'localhost';
          port = parts[1] ? parseInt(parts[1], 10) : useTls ? 8883 : 1883;
        }
        this.form.patchValue({
          host: host || 'localhost',
          port: port || (useTls ? 8883 : 1883),
          use_tls: useTls ?? false,
          topic: action.topic,
          username: action.username || '',
          password: action.password || '',
          qos: action.qos ?? 0,
          retain: action.retain ?? false,
          body_template: action.body_template,
          timeout_secs: action.timeout_secs,
          retry_count: action.retry_count ?? 0,
        });
        break;
      }

      case 'email':
        this.form.patchValue({
          smtp_server: action.smtp_server,
          smtp_port: action.smtp_port,
          username: action.username || '',
          password: action.password || '',
          from: action.from,
          to: action.to,
          subject_template: action.subject_template,
          body_template: action.body_template,
          encryption: action.encryption,
          timeout_secs: action.timeout_secs,
          retry_count: action.retry_count ?? 1,
        });
        break;

      case 'os_toast':
        break;
    }
  }

  // ── Kind selection ───────────────────────────────────────────────

  selectKind(value: AlertActionKind): void {
    this.form.controls.kind.setValue(value);
    this.onKindChange();
  }

  onKindChange(): void {
    const dynamicFields: ActionFieldKey[] = [
      'url',
      'command',
      'bot_token',
      'chat_id',
      'phone',
      'apikey',
      'gateway_url',
      'host',
      'topic',
      'smtp_server',
      'to',
    ];
    dynamicFields.forEach(f => this.form.controls[f].clearValidators());

    const kind = this.form.controls.kind.value;
    const setRequired = (fields: ActionFieldKey[]): void =>
      fields.forEach(f => this.form.controls[f].setValidators([Validators.required]));

    if (kind === 'webhook') {
      setRequired(['url']);
    } else if (kind === 'script') {
      setRequired(['command']);
    } else if (kind === 'telegram') {
      const mode = this.form.controls.telegram_mode.value;
      if (mode === 'bot') {
        setRequired(['bot_token', 'chat_id']);
      } else {
        setRequired(['chat_id']);
      }
    } else if (kind === 'whatsapp') {
      const provider = this.form.controls.whatsapp_provider.value;
      if (provider === 'callmebot') {
        setRequired(['phone', 'apikey']);
      } else {
        setRequired(['phone', 'gateway_url']);
      }
    } else if (kind === 'mqtt') {
      setRequired(['host', 'topic']);
    } else if (kind === 'email') {
      setRequired(['smtp_server', 'to']);
    }

    dynamicFields.forEach(f => this.form.controls[f].updateValueAndValidity());
  }

  setTelegramMode(mode: 'bot' | 'botless'): void {
    this.form.controls.telegram_mode.setValue(mode);
    this.onKindChange();
  }

  setWhatsappProvider(provider: 'callmebot' | 'custom_gateway'): void {
    this.form.controls.whatsapp_provider.setValue(provider);
    this.onKindChange();
  }

  // ── Headers ──────────────────────────────────────────────────────

  get headers(): FormArray<HeaderFormGroup> {
    return this.form.controls.headers;
  }

  addHeader(): void {
    this.headers.push(
      this.fb.nonNullable.group({
        key: ['', Validators.required],
        value: ['', Validators.required],
      })
    );
  }

  removeHeader(index: number): void {
    this.headers.removeAt(index);
  }

  // ── Script browse ────────────────────────────────────────────────

  async browseScript(): Promise<void> {
    try {
      const path = await this.fileSystem.selectFile();
      if (path) {
        this.form.patchValue({ command: path });
      }
    } catch {
      /* user cancelled */
    }
  }

  // ── Presets ──────────────────────────────────────────────────────

  applyPreset(preset: 'discord' | 'slack'): void {
    const hasContentType = this.headers.controls.some(
      h => h.controls.key.value.toLowerCase() === 'content-type'
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
      this.headers.push(
        this.fb.nonNullable.group({
          key: ['Content-Type', Validators.required],
          value: ['application/json', Validators.required],
        })
      );
    }
  }

  // ── Save / Cancel ────────────────────────────────────────────────

  save(): void {
    if (this.form.invalid) return;

    const val = this.form.getRawValue();
    const base = { id: val.id || '', name: val.name, enabled: val.enabled };
    let action: AlertAction;

    switch (val.kind) {
      case 'webhook': {
        const headerMap: Record<string, string> = {};
        this.headers.controls.forEach(h => {
          const key = h.controls.key.value.trim();
          const value = h.controls.value.value;
          if (key && value) headerMap[key] = value;
        });
        action = {
          ...base,
          kind: 'webhook',
          url: val.url,
          method: val.method,
          headers: headerMap,
          body_template: val.body_template,
          timeout_secs: val.timeout_secs,
          tls_verify: val.tls_verify,
          retry_count: val.retry_count,
        };
        break;
      }

      case 'script':
        action = {
          ...base,
          kind: 'script',
          command: val.command,
          args: val.argsRaw.trim() ? val.argsRaw.trim().split(/\s+/) : [],
          timeout_secs: val.timeout_secs,
          env_vars: this.data?.kind === 'script' ? (this.data as ScriptAction).env_vars : {},
        };
        break;

      case 'telegram':
        action = {
          ...base,
          kind: 'telegram',
          mode: val.telegram_mode,
          bot_token: val.bot_token,
          chat_id: val.chat_id,
          body_template: val.body_template,
          timeout_secs: val.timeout_secs,
          retry_count: val.retry_count,
        };
        break;

      case 'whatsapp':
        action = {
          ...base,
          kind: 'whatsapp',
          phone: val.phone,
          apikey: val.apikey,
          provider: val.whatsapp_provider,
          gateway_url: val.gateway_url || undefined,
          body_template: val.body_template,
          timeout_secs: val.timeout_secs,
          retry_count: val.retry_count,
        };
        break;

      case 'mqtt':
        action = {
          ...base,
          kind: 'mqtt',
          host: val.host,
          port: val.port,
          use_tls: val.use_tls,
          topic: val.topic,
          username: val.username || undefined,
          password: val.password || undefined,
          qos: val.qos,
          retain: val.retain,
          body_template: val.body_template,
          timeout_secs: val.timeout_secs,
          retry_count: val.retry_count,
        };
        break;

      case 'email':
        action = {
          ...base,
          kind: 'email',
          smtp_server: val.smtp_server,
          smtp_port: val.smtp_port,
          username: val.username || undefined,
          password: val.password || undefined,
          from: val.from,
          to: val.to,
          subject_template: val.subject_template,
          body_template: val.body_template,
          encryption: val.encryption as 'none' | 'tls' | 'starttls',
          timeout_secs: val.timeout_secs,
          retry_count: val.retry_count,
        };
        break;

      case 'os_toast':
        action = {
          ...base,
          kind: 'os_toast',
        };
        break;
    }

    this.dialogRef.close(action);
  }

  cancel(): void {
    this.dialogRef.close();
  }
}
