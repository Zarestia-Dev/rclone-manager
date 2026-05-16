import { Injectable } from '@angular/core';
import { TauriBaseService } from './tauri-base.service';

@Injectable({ providedIn: 'root' })
export class LoggingService extends TauriBaseService {
  getRemoteLogs(remoteName: string): Promise<string[]> {
    return this.invokeCommand<string[]>('get_remote_logs', { remoteName });
  }

  clearRemoteLogs(remoteName: string): Promise<void> {
    return this.invokeCommand('clear_remote_logs', { remoteName });
  }
}
