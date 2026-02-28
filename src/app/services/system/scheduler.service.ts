import { Injectable, inject, signal } from '@angular/core';
import { TauriBaseService } from '../core/tauri-base.service';
import { ScheduledTask, CronValidationResponse, ScheduledTaskStats } from '@app/types';
import { EventListenersService } from './event-listeners.service';

/**
 * Service for managing scheduled tasks with cron expressions
 * Handles CRUD operations and cron scheduling
 */
@Injectable({
  providedIn: 'root',
})
export class SchedulerService extends TauriBaseService {
  private readonly _scheduledTasks = signal<ScheduledTask[]>([]);
  public readonly scheduledTasks = this._scheduledTasks.asReadonly();

  private readonly _stats = signal<ScheduledTaskStats | null>(null);
  public readonly stats = this._stats.asReadonly();

  private eventListeners = inject(EventListenersService);

  constructor() {
    super();
    this.initializeEventListeners();
  }

  /**
   * Initialize event listeners for scheduled task events
   */
  private initializeEventListeners(): void {
    // Listen for cache changes
    this.eventListeners.listenToScheduledTasksCacheChanged().subscribe(_ => {
      this.refreshScheduledTasks();
    });
  }

  /**
   * Get all scheduled tasks
   */
  async getScheduledTasks(): Promise<ScheduledTask[]> {
    const tasks = await this.invokeCommand<ScheduledTask[]>('get_scheduled_tasks');
    this._scheduledTasks.set(tasks);
    return tasks;
  }

  /**
   * Get a single scheduled task by ID
   */
  async getScheduledTask(taskId: string): Promise<ScheduledTask | null> {
    return this.invokeCommand<ScheduledTask | null>('get_scheduled_task', { taskId });
  }

  /**
   * Get statistics about scheduled tasks
   */
  async getScheduledTasksStats(): Promise<ScheduledTaskStats> {
    const stats = await this.invokeCommand<ScheduledTaskStats>('get_scheduled_tasks_stats');
    this._stats.set(stats);
    return stats;
  }

  /**
   * Toggle a task's enabled/disabled status
   */
  async toggleScheduledTask(taskId: string): Promise<ScheduledTask> {
    const task = await this.invokeCommand<ScheduledTask>('toggle_scheduled_task', { taskId });
    await this.refreshScheduledTasks();
    return task;
  }

  /**
   * Validate a cron expression
   */
  async validateCron(cronExpression: string): Promise<CronValidationResponse> {
    return this.invokeCommand<CronValidationResponse>('validate_cron', { cronExpression });
  }

  /**
   * Reload all scheduled tasks (useful after app restart)
   */
  async reloadScheduledTasks(): Promise<void> {
    await this.invokeCommand('reload_scheduled_tasks');
    await this.refreshScheduledTasks();
  }

  /**
   * Load scheduled tasks from remote configs
   * This extracts cron expressions from operation configs and creates scheduled tasks
   */
  async reloadScheduledTasksFromConfigs(remoteConfigs: unknown): Promise<number> {
    const loadedCount = await this.invokeCommand<number>('reload_scheduled_tasks_from_configs', {
      remote_configs: remoteConfigs,
    });
    await this.refreshScheduledTasks();
    return loadedCount;
  }

  /**
   * Clear all scheduled tasks (dangerous!)
   */
  async clearAllScheduledTasks(): Promise<void> {
    await this.invokeCommand('clear_all_scheduled_tasks');
    await this.refreshScheduledTasks();
  }

  /**
   * Refresh the scheduled tasks cache
   */
  public async refreshScheduledTasks(): Promise<void> {
    try {
      const tasks = await this.getScheduledTasks();
      const stats = await this.getScheduledTasksStats();
      this._scheduledTasks.set(tasks);
      this._stats.set(stats);
    } catch (error) {
      console.error('Failed to refresh scheduled tasks:', error);
    }
  }
}
