import type { Origin } from './origin';

export type AlertSeverity = 'critical' | 'high' | 'average' | 'warning' | 'info';

export type AlertEventKind =
  | 'any'
  | 'job_completed'
  | 'job_started'
  | 'job_failed'
  | 'job_stopped'
  | 'serve_started'
  | 'serve_failed'
  | 'serve_stopped'
  | 'all_serves_stopped'
  | 'mount_succeeded'
  | 'mount_failed'
  | 'unmount_succeeded'
  | 'all_unmounted'
  | 'engine_password_required'
  | 'engine_binary_not_found'
  | 'engine_connection_failed'
  | 'engine_restarted'
  | 'engine_restart_failed'
  | 'app_update_available'
  | 'app_update_started'
  | 'app_update_complete'
  | 'app_update_failed'
  | 'app_update_installed'
  | 'rclone_update_available'
  | 'rclone_update_started'
  | 'rclone_update_complete'
  | 'rclone_update_failed'
  | 'rclone_update_installed'
  | 'scheduled_task_started'
  | 'scheduled_task_completed'
  | 'scheduled_task_failed'
  | 'already_running'
  | 'all_jobs_stopped';

export interface AlertRule {
  id: string;
  name: string;
  enabled: boolean;
  event_filter: AlertEventKind[];
  severity_min: AlertSeverity;
  remote_filter: string[];
  origin_filter: Origin[];
  action_ids: string[];
  cooldown_secs: number;
  created_at?: string;
  last_fired?: string;
  fire_count?: number;
}

export type AlertActionKind = 'webhook' | 'script' | 'os_toast';

export interface WebhookAction {
  id: string;
  name: string;
  enabled: boolean;
  kind: 'webhook';
  url: string;
  method: string;
  headers: Record<string, string>;
  body_template: string;
  timeout_secs: number;
  tls_verify: boolean;
  retry_count: number;
}

export interface ScriptAction {
  id: string;
  name: string;
  enabled: boolean;
  kind: 'script';
  command: string;
  args: string[];
  timeout_secs: number;
  env_vars: Record<string, string>;
}

export interface OsToastAction {
  id: string;
  name: string;
  enabled: boolean;
  kind: 'os_toast';
}

export type AlertAction = WebhookAction | ScriptAction | OsToastAction;

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
  title: string;
  body: string;
  remote?: string;
  origin?: Origin;
  timestamp: string;
  action_results: ActionResult[];
  acknowledged: boolean;
  ack_at?: string;
}

export interface AlertStats {
  total_fired: number;
  unacknowledged: number;
  by_severity: Record<string, number>;
  by_rule: Record<string, number>;
}

export interface AlertHistoryFilter {
  limit?: number;
  offset?: number;
  severity_min?: AlertSeverity;
  event_kind?: AlertEventKind;
  remote?: string;
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
