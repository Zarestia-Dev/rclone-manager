import { Injectable, inject, signal } from '@angular/core';
import { LocalStorageService } from './local-storage.service';

const STORAGE_KEY = 'overview.originFilters';

export type OverviewPanel = 'mounts' | 'serves' | 'jobs' | 'automations';

/**
 * The origin chip each overview panel was left on. A panel keeps its choice on every screen that
 * shows it (Dashboard, Quick Run) and across restarts.
 */
@Injectable({ providedIn: 'root' })
export class OriginFilterService {
  private readonly localStorage = inject(LocalStorageService);
  private readonly filters = signal(
    this.localStorage.get<Partial<Record<OverviewPanel, string>>>(STORAGE_KEY, {})
  );

  get(panel: OverviewPanel): string {
    return this.filters()[panel] ?? 'all';
  }

  set(panel: OverviewPanel, filter: string): void {
    this.filters.update(filters => ({ ...filters, [panel]: filter }));
    this.localStorage.set(STORAGE_KEY, this.filters());
  }
}
