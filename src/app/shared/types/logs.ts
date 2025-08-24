export interface LogContext {
  job_id?: number;
  response?: string;
  [key: string]: unknown;
}

export interface RemoteLogEntry {
  timestamp: string;
  remote_name?: string;
  level: string;
  message: string;
  context?: LogContext | null;
}
