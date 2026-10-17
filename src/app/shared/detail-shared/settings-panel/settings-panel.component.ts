import {
  Component,
  input,
  output,
  inject,
  computed,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { TranslateService, TranslatePipe } from '@ngx-translate/core';
import { map } from 'rxjs';

import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatExpansionModule } from '@angular/material/expansion';
import { AppSettingsService } from 'src/app/services/settings/app-settings.service';
import { SENSITIVE_KEYS, SettingsPanelConfig, SettingEntry, GroupedSettings } from '@app/types';

@Component({
  selector: 'app-settings-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, MatButtonModule, MatExpansionModule, TranslatePipe],
  styleUrls: ['./settings-panel.component.scss', '../../../styles/_panel-actions.scss'],
  templateUrl: './settings-panel.component.html',
})
export class SettingsPanelComponent {
  private readonly translate = inject(TranslateService);
  private readonly appSettingsService = inject(AppSettingsService);

  readonly config = input.required<SettingsPanelConfig>();
  readonly editSettings = output<{ section: string; settings: Record<string, unknown> }>();

  readonly isExpanded = signal(false);

  private readonly expandedKeys = signal<ReadonlySet<string>>(new Set());

  private readonly restrictMode = toSignal(
    this.appSettingsService
      .selectSetting('general.restrict')
      .pipe(map(setting => (setting?.value as boolean) ?? true)),
    { initialValue: true }
  );

  readonly groupedSettings = computed<GroupedSettings[]>(() => {
    const rawSettings = this.config().settings ?? {};
    const restrictedLabel = this.translate.instant('detailShared.settings.restricted');

    const hasApp =
      'app' in rawSettings && rawSettings['app'] !== null && typeof rawSettings['app'] === 'object';
    const hasRclone =
      'rclone' in rawSettings &&
      rawSettings['rclone'] !== null &&
      typeof rawSettings['rclone'] === 'object';

    if (hasApp || hasRclone) {
      const groups: GroupedSettings[] = [];

      if (hasApp) {
        let appEntries = this.flattenSettings('app', rawSettings['app'], restrictedLabel);
        if (!this.appSettingsService.isTrayAvailable()) {
          appEntries = appEntries.filter(e => e.key !== 'showOnTray');
        }
        if (appEntries.length > 0) {
          groups.push({
            category: 'detailShared.settings.categories.app',
            entries: appEntries,
          });
        }
      }

      if (hasRclone) {
        const rcloneEntries = this.flattenSettings(
          'rclone',
          rawSettings['rclone'],
          restrictedLabel
        );
        if (rcloneEntries.length > 0) {
          groups.push({
            category: 'detailShared.settings.categories.rclone',
            entries: rcloneEntries,
          });
        }
      }

      return groups;
    }

    // Flat settings (like filter, backend, vfs etc.)
    let flatEntries = Object.entries(rawSettings)
      .filter(([, value]) => value !== null && value !== undefined)
      .flatMap(([key, value]) => this.flattenSettings(key, value, restrictedLabel));

    if (!this.appSettingsService.isTrayAvailable()) {
      flatEntries = flatEntries.filter(e => e.key !== 'showOnTray' && e.key !== 'app.showOnTray');
    }

    return flatEntries.length > 0 ? [{ category: '', entries: flatEntries }] : [];
  });

  readonly settingsEntriesCount = computed(() =>
    this.groupedSettings().reduce((sum, g) => sum + g.entries.length, 0)
  );

  readonly hasMeaningfulSettings = computed(() => this.settingsEntriesCount() > 0);

  readonly editButtonLabel = computed(
    () => this.config().buttonLabel ?? 'detailShared.settings.edit'
  );

  onEditSettings(): void {
    this.editSettings.emit({
      section: this.config().section.key,
      settings: this.config().settings,
    });
  }

  toggleEntryExpand(key: string): void {
    const current = new Set(this.expandedKeys());
    if (current.has(key)) {
      current.delete(key);
    } else {
      current.add(key);
    }
    this.expandedKeys.set(current);
  }

  isEntryExpanded(key: string): boolean {
    return this.expandedKeys().has(key);
  }

  private flattenSettings(key: string, value: unknown, restrictedLabel: string): SettingEntry[] {
    if (value === null || value === undefined) return [];

    if (typeof value === 'object' && !Array.isArray(value)) {
      const nested = value as Record<string, unknown>;
      const entries = Object.entries(nested);
      if (entries.length === 0) return [];

      return entries.flatMap(([k, v]) => {
        const displayKey = key === 'app' || key === 'rclone' ? k : `${key}.${k}`;
        return this.flattenSettings(displayKey, v, restrictedLabel);
      });
    }

    return [this.formatEntry(key, value, restrictedLabel)];
  }

  private formatEntry(key: string, value: unknown, restrictedLabel: string): SettingEntry {
    const isSensitive =
      this.restrictMode() && SENSITIVE_KEYS.some(s => key.toLowerCase().includes(s));
    const valueText = this.valueToString(value);

    return {
      key,
      display: isSensitive ? restrictedLabel : valueText,
      tooltip: isSensitive ? `[${restrictedLabel}]` : valueText,
      isSensitive,
    };
  }

  private valueToString(value: unknown): string {
    if (value === null || value === undefined) return '';
    try {
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
    } catch {
      return this.translate.instant('detailShared.settings.invalidJson');
    }
  }
}
