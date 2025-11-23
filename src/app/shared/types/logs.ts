export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export const LOG_LEVELS: { value: LogLevel; label: string }[] = [
  { value: 'info', label: 'Info' },
  { value: 'warn', label: 'Warning' },
  { value: 'error', label: 'Error' },
  { value: 'debug', label: 'Debug' },
];

export interface LogContext {
  job_id?: number;
  response?: string;
  [key: string]: unknown;
}

export interface RemoteLogEntry {
  timestamp: string;
  remote_name?: string;
  level: LogLevel;
  message: string;
  context?: LogContext | null;
}
