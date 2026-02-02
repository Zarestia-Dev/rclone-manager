import { Injectable } from '@angular/core';
import { TauriBaseService } from '../core/tauri-base.service';

@Injectable({
  providedIn: 'root',
})
export class ConfigService extends TauriBaseService {
  constructor() {
    super();
  }

  async loadRcloneServeUrl(): Promise<string> {
    try {
      const url = await this.invokeCommand<string>('get_rclone_rc_url');
      if (url) {
        return url;
      } else {
        console.warn('Rclone serve URL from backend is empty, using default.');
        return 'http://127.0.0.1:51901';
      }
    } catch (error) {
      console.error('Failed to load rclone serve URL from backend, using default.', error);
      return 'http://127.0.0.1:51901';
    }
  }
}
