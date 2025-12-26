import { Injectable, signal } from '@angular/core';
import { TauriBaseService } from '../core/tauri-base.service';

@Injectable({
  providedIn: 'root',
})
export class ConfigService extends TauriBaseService {
  rcloneServeUrl = signal('http://127.0.0.1:51901');

  constructor() {
    super();
    this.loadRcloneServeUrl();
  }

  private async loadRcloneServeUrl(): Promise<void> {
    try {
      const url = await this.invokeCommand<string>('get_rclone_rc_url');
      if (url) {
        this.rcloneServeUrl.set(url);
      } else {
        console.warn('Rclone serve URL from backend is empty, using default.');
      }
    } catch (error) {
      console.error('Failed to load rclone serve URL from backend, using default.', error);
    }
  }
}
