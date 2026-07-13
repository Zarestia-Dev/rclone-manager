import type { Origin } from './origin';

export type AlertSeverity = 'critical' | 'high' | 'average' | 'warning' | 'info';

export interface SeverityStyle {
  color: string;
  bg: string;
  border: string;
}

export type AlertEventKind =
  'job' | 'serve' | 'mount' | 'engine' | 'update' | 'automation' | 'system';

export interface AlertRule {
  id: string;
  name: string;
  enabled: boolean;
  event_filter: AlertEventKind[];
  severity_min: AlertSeverity;
  remote_filter: string[];
  backend_filter: string[];
  profile_filter: string[];
  origin_filter: Origin[];
  action_ids: string[];
  cooldown_secs: number;
  created_at?: string;
  last_fired?: string;
  fire_count?: number;
  auto_acknowledge?: boolean;
}

export type AlertActionKind =
  'webhook' | 'script' | 'os_toast' | 'telegram' | 'whatsapp' | 'mqtt' | 'email';

export interface BaseAlertAction {
  id: string;
  name: string;
  enabled: boolean;
}

export interface WebhookAction extends BaseAlertAction {
  kind: 'webhook';
  url: string;
  method: string;
  headers: Record<string, string>;
  body_template: string;
  timeout_secs: number;
  tls_verify: boolean;
  retry_count: number;
}

export interface ScriptAction extends BaseAlertAction {
  kind: 'script';
  command: string;
  args: string[];
  timeout_secs: number;
  env_vars: Record<string, string>;
}

export interface OsToastAction extends BaseAlertAction {
  kind: 'os_toast';
}

export interface TelegramAction extends BaseAlertAction {
  kind: 'telegram';
  mode?: 'bot' | 'botless';
  bot_token: string;
  chat_id: string;
  body_template: string;
  timeout_secs: number;
  retry_count: number;
}

export interface WhatsappAction extends BaseAlertAction {
  kind: 'whatsapp';
  phone: string;
  apikey: string;
  provider?: 'callmebot' | 'custom_gateway';
  gateway_url?: string;
  body_template: string;
  timeout_secs: number;
  retry_count: number;
}

export interface MqttAction extends BaseAlertAction {
  kind: 'mqtt';
  broker_url: string;
  topic: string;
  username?: string;
  password?: string;
  qos: number;
  retain: boolean;
  body_template: string;
  timeout_secs: number;
  retry_count: number;
}

export interface EmailAction extends BaseAlertAction {
  kind: 'email';
  smtp_server: string;
  smtp_port: number;
  username?: string;
  password?: string;
  from: string;
  to: string;
  subject_template: string;
  body_template: string;
  encryption: 'none' | 'tls' | 'starttls';
  timeout_secs: number;
}

export type AlertAction =
  | WebhookAction
  | ScriptAction
  | OsToastAction
  | TelegramAction
  | WhatsappAction
  | MqttAction
  | EmailAction;

export interface ActionResult {
  action_id: string;
  action_name: string;
  action_kind: AlertActionKind;
  success: boolean;
  error?: string;
  duration_ms: number;
}

export interface AlertRecord {
  id: string;
  rule_id: string;
  rule_name: string;
  event_kind: AlertEventKind;
  severity: AlertSeverity;
  severity_code?: number;
  title: string;
  body: string;
  remote?: string;
  profile?: string;
  backend?: string;
  operation?: string;
  origin?: Origin;
  timestamp: string;
  action_results: ActionResult[];
  acknowledged: boolean;
  ack_at?: string;
}

export interface AlertStats {
  total: number;
  critical: number;
  high: number;
  total_fired: number;
  unacknowledged: number;
  by_severity: Record<string, number>;
  by_rule: Record<string, number>;
}

export interface AlertHistoryFilter {
  limit?: number;
  offset?: number;
  severity?: AlertSeverity;
  event_kind?: AlertEventKind;
  remote?: string;
  profile?: string;
  backend?: string;
  acknowledged?: boolean;
  rule_id?: string;
  origins?: Origin[];
}

export interface AlertHistoryPage {
  items: AlertRecord[];
  total: number;
  offset: number;
  limit: number;
}

export interface KindOption {
  value: AlertActionKind;
  label: string;
}
