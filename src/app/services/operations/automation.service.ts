import { Injectable, inject, signal } from '@angular/core';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { Automation, CronValidationResponse, AutomationStats } from '@app/types';
import { EventListenersService } from '../infrastructure/system/event-listeners.service';

/**
 * Service for managing automations with cron expressions or realtime watching
 * Handles CRUD operations and cron scheduling
 */
@Injectable({
  providedIn: 'root',
})
export class AutomationService extends TauriBaseService {
  private readonly _automations = signal<Automation[]>([]);
  public readonly automations = this._automations.asReadonly();

  private readonly _stats = signal<AutomationStats | null>(null);
  public readonly stats = this._stats.asReadonly();

  private eventListeners = inject(EventListenersService);

  constructor() {
    super();
    this.initializeEventListeners();
  }

  /**
   * Initialize event listeners for automation events
   */
  private initializeEventListeners(): void {
    // Listen for cache changes
    this.eventListeners.listenToAutomationsCacheChanged().subscribe(_ => {
      this.refreshAutomations();
    });
  }

  /**
   * Get all automations
   */
  async getAutomations(): Promise<Automation[]> {
    const automations = await this.invokeCommand<Automation[]>('get_automations');
    this._automations.set(automations);
    return automations;
  }

  /**
   * Get a single automation by ID
   */
  async getAutomation(automationId: string): Promise<Automation | null> {
    return this.invokeCommand<Automation | null>('get_automation', { automationId });
  }

  /**
   * Get statistics about automations
   */
  async getAutomationStats(): Promise<AutomationStats> {
    const stats = await this.invokeCommand<AutomationStats>('get_automation_stats');
    this._stats.set(stats);
    return stats;
  }

  /**
   * Toggle an automation's enabled/disabled status
   */
  async toggleAutomation(automationId: string): Promise<Automation> {
    const automation = await this.invokeCommand<Automation>('toggle_automation', { automationId });
    await this.refreshAutomations();
    return automation;
  }

  /**
   * Validate a cron expression
   */
  async validateCron(cronExpression: string): Promise<CronValidationResponse> {
    return this.invokeCommand<CronValidationResponse>('validate_cron', { cronExpression });
  }

  /**
   * Reload all automations (useful after app restart)
   */
  async reloadAutomations(): Promise<void> {
    await this.invokeCommand('reload_automations');
    await this.refreshAutomations();
  }

  /**
   * Load automations from remote configs
   * This extracts cron expressions from operation configs and creates automations
   */
  async reloadAutomationsFromConfigs(remoteConfigs: unknown): Promise<number> {
    const loadedCount = await this.invokeCommand<number>('reload_automations_from_configs', {
      remote_configs: remoteConfigs,
    });
    await this.refreshAutomations();
    return loadedCount;
  }

  /**
   * Clear all automations (dangerous!)
   */
  async clearAllAutomations(): Promise<void> {
    await this.invokeCommand('clear_all_automations');
    await this.refreshAutomations();
  }

  /**
   * Refresh the automations cache
   */
  public async refreshAutomations(): Promise<void> {
    try {
      const automations = await this.getAutomations();
      const stats = await this.getAutomationStats();
      this._automations.set(automations);
      this._stats.set(stats);
    } catch (error) {
      console.error('Failed to refresh automations:', error);
    }
  }
}
