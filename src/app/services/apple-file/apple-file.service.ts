import { Injectable, signal, computed } from '@angular/core';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';

export interface AppleFileDomain {
  domain_id: string;
  remote_name: string;
  display_name: string;
  root_path: string;
  active: boolean;
  created_at: string;
}

export interface RegisterAppleFileParams {
  remote_name: string;
  display_name?: string;
  root_path?: string;
}

@Injectable({ providedIn: 'root' })
export class AppleFileService extends TauriBaseService {
  private readonly _domains = signal<AppleFileDomain[]>([]);
  readonly domains = this._domains.asReadonly();
  readonly registeredRemotes = computed(() => new Set(this._domains().map((d: AppleFileDomain) => d.remote_name)));

  async registerDomain(params: RegisterAppleFileParams): Promise<AppleFileDomain> {
    const domain = await this.invokeCommand<AppleFileDomain>('register_apple_file_domain', { params });
    this._domains.update((ds: AppleFileDomain[]) => [...ds, domain]);
    return domain;
  }

  async unregisterDomain(remoteName: string): Promise<void> {
    await this.invokeCommand<void>('unregister_apple_file_domain', { remote_name: remoteName });
    this._domains.update((ds: AppleFileDomain[]) => ds.filter((d: AppleFileDomain) => d.remote_name !== remoteName));
  }

  async listDomains(): Promise<AppleFileDomain[]> {
    const domains = await this.invokeCommand<AppleFileDomain[]>('list_apple_file_domains');
    this._domains.set(domains);
    return domains;
  }

  isRegistered(remoteName: string): boolean {
    return this.registeredRemotes().has(remoteName);
  }

  async refreshEndpoint(): Promise<void> {
    await this.invokeCommand<void>('refresh_apple_file_endpoint');
  }

  async signalChange(remoteName: string): Promise<void> {
    await this.invokeCommand<void>('signal_apple_file_change', { remote_name: remoteName });
  }
}
