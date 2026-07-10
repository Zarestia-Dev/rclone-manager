import { Injectable, signal, computed, inject, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  AlertAction,
  AlertActionKind,
  AlertHistoryFilter,
  AlertHistoryPage,
  AlertRecord,
  AlertRule,
  AlertSeverity,
  AlertStats,
  SeverityStyle,
  ALERT_FIRED,
  SettingsChangeEvent,
} from '@app/types';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { EventListenersService } from '../infrastructure/system/event-listeners.service';

@Injectable({ providedIn: 'root' })
export class AlertService extends TauriBaseService {
  private readonly destroyRef = inject(DestroyRef);
  private readonly eventListeners = inject(EventListenersService);

  // ── Raw local caches ─────────────────────────────────────────────────────
  private readonly _history = signal<AlertRecord[]>([]);
  private readonly _rules = signal<AlertRule[]>([]);
  private readonly _actions = signal<AlertAction[]>([]);

  // ── Public state ─────────────────────────────────────────────────────────
  readonly stats = signal<AlertStats>({
    total: 0,
    unacknowledged: 0,
    critical: 0,
    high: 0,
    total_fired: 0,
    by_severity: {},
    by_rule: {},
  });
  readonly isLoading = signal(false);

  // Filters
  readonly filter = signal<AlertHistoryFilter>({ limit: 100 });
  readonly searchTerm = signal('');
  readonly rulesSearchTerm = signal('');
  readonly actionsSearchTerm = signal('');

  readonly testingActionIds = signal<Set<string>>(new Set());

  // ── Derived / Filtered views (O(1) updates) ──────────────────────────────
  readonly unacknowledged = computed(() => this.stats().unacknowledged);

  readonly history = computed(() => {
    const s = this.searchTerm().toLowerCase();
    return s
      ? this._history().filter(
          a =>
            a.title.toLowerCase().includes(s) ||
            a.body.toLowerCase().includes(s) ||
            a.remote?.toLowerCase().includes(s) ||
            a.profile?.toLowerCase().includes(s)
        )
      : this._history();
  });

  readonly rules = computed(() => {
    const s = this.rulesSearchTerm().toLowerCase();
    return s ? this._rules().filter(r => r.name.toLowerCase().includes(s)) : this._rules();
  });

  readonly actions = computed(() => {
    const s = this.actionsSearchTerm().toLowerCase();
    return s ? this._actions().filter(a => a.name.toLowerCase().includes(s)) : this._actions();
  });

  readonly actionsMap = computed(() => new Map(this._actions().map(a => [a.id, a])));

  // Shared Severity Styles
  readonly severityStyles: Record<AlertSeverity, SeverityStyle> = {
    critical: {
      color: 'var(--warn-color)',
      bg: 'rgba(var(--warn-color-rgb), 0.1)',
      border: 'rgba(var(--warn-color-rgb), 0.3)',
    },
    high: {
      color: 'var(--orange)',
      bg: 'rgba(var(--orange-rgb), 0.1)',
      border: 'rgba(var(--orange-rgb), 0.3)',
    },
    average: {
      color: 'var(--accent-color)',
      bg: 'rgba(var(--accent-color-rgb), 0.1)',
      border: 'rgba(var(--accent-color-rgb), 0.3)',
    },
    warning: {
      color: 'var(--yellow)',
      bg: 'rgba(var(--yellow-rgb), 0.1)',
      border: 'rgba(var(--yellow-rgb), 0.3)',
    },
    info: {
      color: 'var(--primary-color)',
      bg: 'rgba(var(--primary-color-rgb), 0.1)',
      border: 'rgba(var(--primary-color-rgb), 0.3)',
    },
  };

  // ────────────────────────────────────────────────────────────────────────

  constructor() {
    super();
    this.loadInitialData();
    this.initRealtime();
  }

  // ── Data Loading ────────────────────────────────────────────────────────

  private async loadInitialData(): Promise<void> {
    this.isLoading.set(true);

    try {
      const [rules, actions, stats] = await Promise.all([
        this.invokeCommand<AlertRule[]>('get_alert_rules'),
        this.invokeCommand<AlertAction[]>('get_alert_actions'),
        this.invokeCommand<AlertStats>('get_alert_stats'),
      ]);

      this._rules.set(rules);
      this._actions.set(actions);
      this.stats.set(stats);

      await this.fetchHistory();
    } finally {
      this.isLoading.set(false);
    }
  }

  public async fetchHistory(): Promise<void> {
    this.isLoading.set(true);
    try {
      const page = await this.invokeCommand<AlertHistoryPage>('get_alert_history', {
        filter: this.filter(),
      });
      this._history.set(page.items);
    } finally {
      this.isLoading.set(false);
    }
  }

  private initRealtime(): void {
    this.listenToEvent<AlertRecord>(ALERT_FIRED)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(newAlert => {
        // Update history
        this._history.update(h => {
          const updated = [newAlert, ...h];
          return updated.slice(0, this.filter().limit || 100);
        });

        // Update rule fire counts
        this._rules.update(rules =>
          rules.map(r =>
            r.id === newAlert.rule_id
              ? {
                  ...r,
                  fire_count: (r.fire_count || 0) + 1,
                  last_fired: newAlert.timestamp,
                }
              : r
          )
        );

        // Update stats
        this.stats.update(s => {
          const bySeverity = { ...s.by_severity };
          bySeverity[newAlert.severity] = (bySeverity[newAlert.severity] || 0) + 1;

          const byRule = { ...s.by_rule };
          byRule[newAlert.rule_name] = (byRule[newAlert.rule_name] || 0) + 1;

          return {
            ...s,
            total: s.total + 1,
            total_fired: (s.total_fired || 0) + 1,
            unacknowledged: newAlert.acknowledged ? s.unacknowledged : s.unacknowledged + 1,
            by_severity: bySeverity,
            by_rule: byRule,
          };
        });
      });

    this.eventListeners
      .listenToSystemSettingsChanged()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((payload: SettingsChangeEvent) => {
        if (
          (payload.category === '*' && payload.key === '*') ||
          payload.category.startsWith('alerts')
        ) {
          this.loadInitialData();
        }
      });
  }

  // ── Rules ──────────────────────────────────────────────────────────────

  async saveAlertRule(rule: AlertRule): Promise<AlertRule> {
    const savedRule = await this.invokeCommand<AlertRule>('save_alert_rule', { rule });
    this._rules.update(rules => {
      const idx = rules.findIndex(r => r.id === savedRule.id);
      if (idx > -1) {
        const next = [...rules];
        next[idx] = savedRule;
        return next;
      }
      return [...rules, savedRule];
    });
    return savedRule;
  }

  async deleteAlertRule(id: string): Promise<void> {
    await this.invokeCommand<void>('delete_alert_rule', { id });
    this._rules.update(rules => rules.filter(r => r.id !== id));
  }

  async toggleAlertRule(id: string, enabled: boolean): Promise<AlertRule> {
    const updated = await this.invokeCommand<AlertRule>('toggle_alert_rule', { id, enabled });
    this._rules.update(rules => rules.map(r => (r.id === updated.id ? updated : r)));
    return updated;
  }

  // ── Actions ────────────────────────────────────────────────────────────

  async saveAlertAction(action: AlertAction): Promise<AlertAction> {
    const savedAction = await this.invokeCommand<AlertAction>('save_alert_action', { action });
    this._actions.update(actions => {
      const idx = actions.findIndex(a => a.id === savedAction.id);
      if (idx > -1) {
        const next = [...actions];
        next[idx] = savedAction;
        return next;
      }
      return [...actions, savedAction];
    });
    return savedAction;
  }

  async deleteAlertAction(id: string): Promise<void> {
    await this.invokeCommand<void>('delete_alert_action', { id });
    this._actions.update(actions => actions.filter(a => a.id !== id));
  }

  async testAlertAction(id: string): Promise<boolean> {
    this.testingActionIds.update(set => new Set(set).add(id));
    try {
      return await this.invokeCommand<boolean>('test_alert_action', { id });
    } finally {
      this.testingActionIds.update(set => {
        const next = new Set(set);
        next.delete(id);
        return next;
      });
    }
  }

  // ── History ────────────────────────────────────────────────────────────

  async acknowledgeAlert(id: string): Promise<void> {
    await this.invokeCommand<void>('acknowledge_alert', { id });
    this._history.update(h => h.map(a => (a.id === id ? { ...a, acknowledged: true } : a)));
    this.stats.update(s => ({ ...s, unacknowledged: Math.max(0, s.unacknowledged - 1) }));
  }

  async acknowledgeAllAlerts(): Promise<void> {
    await this.invokeCommand<void>('acknowledge_all_alerts');
    this._history.update(h => h.map(a => ({ ...a, acknowledged: true })));
    this.stats.update(s => ({ ...s, unacknowledged: 0 }));
  }

  async clearAlertHistory(): Promise<void> {
    await this.invokeCommand<void>('clear_alert_history');
    this._history.set([]);
    this.stats.update(s => ({ ...s, unacknowledged: 0, total: 0 }));
  }

  async getTemplateKeys(): Promise<string[]> {
    return this.invokeCommand<string[]>('get_alert_template_keys');
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  getActionIcon(kind: AlertActionKind): string {
    switch (kind) {
      case 'os_toast':
        return 'desktop';
      case 'webhook':
        return 'link';
      case 'script':
        return 'terminal';
      case 'telegram':
        return 'telegram';
      case 'mqtt':
        return 'message';
      case 'email':
        return 'envelope';
      default:
        return 'bolt';
    }
  }

  getSeverityStyle(severity: AlertSeverity | string): SeverityStyle {
    return this.severityStyles[severity as AlertSeverity] || this.severityStyles.info;
  }
}
