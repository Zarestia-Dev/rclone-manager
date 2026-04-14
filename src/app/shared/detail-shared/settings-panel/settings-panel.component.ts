import { Component, input, output, inject, computed } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { TranslateService, TranslateModule } from '@ngx-translate/core';
import { map } from 'rxjs';

import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatExpansionModule } from '@angular/material/expansion';
import { AppSettingsService } from '@app/services';
import { SENSITIVE_KEYS, SettingsPanelConfig } from '@app/types';

interface SettingEntry {
  key: string;
  display: string;
  tooltip: string;
}

@Component({
  selector: 'app-settings-panel',
  standalone: true,
  imports: [MatIconModule, MatButtonModule, MatTooltipModule, MatExpansionModule, TranslateModule],
  styleUrls: ['./settings-panel.component.scss'],
  template: `
    @let cfg = config();

    <mat-expansion-panel>
      <mat-expansion-panel-header>
        <mat-panel-title>
          <mat-icon [svgIcon]="cfg.section.icon" style="color: var(--mat-sys-primary);"></mat-icon>
          <span>{{ cfg.section.title | translate }}</span>
        </mat-panel-title>
        <mat-panel-description>
          @if (hasMeaningfulSettings()) {
            <span class="settings-count">{{
              'detailShared.settings.metrics' | translate: { count: settingsEntries().length }
            }}</span>
          } @else {
            <span class="no-settings-hint">{{
              'detailShared.settings.notConfigured' | translate
            }}</span>
          }
        </mat-panel-description>
      </mat-expansion-panel-header>

      <div class="panel-body">
        @if (hasMeaningfulSettings()) {
          <div class="settings-grid">
            @for (entry of settingsEntries(); track entry.key) {
              <div class="setting-item">
                <div class="setting-key">{{ entry.key }}</div>
                <div class="setting-value" [matTooltip]="entry.tooltip" [matTooltipShowDelay]="500">
                  {{ entry.display }}
                </div>
              </div>
            }
          </div>
        } @else {
          <div class="no-settings">
            <mat-icon [svgIcon]="cfg.section.icon" class="no-settings-icon"></mat-icon>
            <span>{{ 'detailShared.settings.noData' | translate }}</span>
          </div>
        }

        <div class="panel-actions">
          <button matButton="filled" (click)="onEditSettings()">
            <mat-icon svgIcon="pen"></mat-icon>
            <span>{{ editButtonLabel() | translate }}</span>
          </button>
        </div>
      </div>
    </mat-expansion-panel>
  `,
})
export class SettingsPanelComponent {
  private readonly translate = inject(TranslateService);
  private readonly appSettingsService = inject(AppSettingsService);

  readonly config = input.required<SettingsPanelConfig>();
  readonly editSettings = output<{ section: string; settings: Record<string, unknown> }>();

  private readonly restrictMode = toSignal(
    this.appSettingsService
      .selectSetting('general.restrict')
      .pipe(map(setting => (setting?.value as boolean) ?? true)),
    { initialValue: true }
  );

  readonly settingsEntries = computed<SettingEntry[]>(() => {
    const rawSettings = this.config().settings ?? {};
    const restrictedLabel = this.translate.instant('detailShared.settings.restricted');

    return Object.entries(rawSettings)
      .filter(([, value]) => value !== null && value !== undefined)
      .flatMap(([key, value]) => {
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          const nested = value as Record<string, unknown>;
          if (Object.keys(nested).length === 0) return [];
          return Object.entries(nested).map(([k, v]) => this.formatEntry(k, v, restrictedLabel));
        }
        return [this.formatEntry(key, value, restrictedLabel)];
      });
  });

  readonly hasMeaningfulSettings = computed(() => this.settingsEntries().length > 0);

  readonly editButtonLabel = computed(
    () => this.config().buttonLabel ?? 'detailShared.settings.edit'
  );

  onEditSettings(): void {
    this.editSettings.emit({
      section: this.config().section.key,
      settings: this.config().settings,
    });
  }

  private formatEntry(key: string, value: unknown, restrictedLabel: string): SettingEntry {
    const isSensitive =
      this.restrictMode() && SENSITIVE_KEYS.some(s => key.toLowerCase().includes(s));
    const valueText = this.valueToString(value);

    return {
      key,
      display: isSensitive ? restrictedLabel : valueText,
      tooltip: isSensitive ? `[${restrictedLabel}]` : valueText,
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
