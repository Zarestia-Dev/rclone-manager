import { Component, input, output, inject, computed } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { TranslateService, TranslateModule } from '@ngx-translate/core';
import { map } from 'rxjs';

import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatExpansionModule } from '@angular/material/expansion';
import { AppSettingsService } from '@app/services';
import { SENSITIVE_KEYS, SettingsPanelConfig } from '@app/types';

@Component({
  selector: 'app-settings-panel',
  standalone: true,
  imports: [
    MatCardModule,
    MatIconModule,
    MatButtonModule,
    MatTooltipModule,
    MatExpansionModule,
    TranslateModule,
  ],
  styleUrls: ['./settings-panel.component.scss'],
  template: `
    <mat-expansion-panel class="settings-expansion-panel">
      <mat-expansion-panel-header>
        <mat-panel-title>
          <mat-icon [svgIcon]="config().section.icon" class="panel-icon"></mat-icon>
          <span>{{ config().section.title | translate }}</span>
        </mat-panel-title>
        <mat-panel-description>
          @if (hasMeaningfulSettings()) {
            <span class="settings-count">{{
              'detailShared.settings.metrics' | translate: { count: settingsCount() }
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
            <mat-icon [svgIcon]="config().section.icon" class="no-settings-icon"></mat-icon>
            <span>{{ 'detailShared.settings.noData' | translate }}</span>
          </div>
        }

        <div class="panel-actions">
          <button
            matButton="filled"
            [class]="'edit-settings-button ' + config().buttonColor"
            (click)="onEditSettings()"
          >
            <mat-icon svgIcon="pen"></mat-icon>
            <span>{{ config().buttonLabel || 'detailShared.settings.edit' | translate }}</span>
          </button>
        </div>
      </div>
    </mat-expansion-panel>
  `,
})
export class SettingsPanelComponent {
  private readonly translate = inject(TranslateService);
  private readonly appSettingsService = inject(AppSettingsService);

  // Inputs
  config = input.required<SettingsPanelConfig>();

  // Outputs
  editSettings = output<{ section: string; settings: Record<string, unknown> }>();

  // Reactive restriction mode from settings
  readonly restrictMode = toSignal(
    this.appSettingsService
      .selectSetting('general.restrict')
      .pipe(map(setting => (setting?.value as boolean) ?? true)),
    { initialValue: true }
  );

  // Derived State
  readonly settingsEntries = computed(() => {
    const rawSettings = this.config().settings || {};
    const entries: { key: string; value: unknown; display: string; tooltip: string }[] = [];

    Object.entries(rawSettings).forEach(([key, value]) => {
      if (this.isObjectButNotArray(value)) {
        Object.entries(value as Record<string, unknown>).forEach(([subKey, subValue]) => {
          entries.push(this.formatEntry(subKey, subValue));
        });
      } else {
        entries.push(this.formatEntry(key, value));
      }
    });

    return entries;
  });

  readonly hasMeaningfulSettings = computed(() => {
    const settings = this.config().settings;
    if (!settings || Object.keys(settings).length === 0) return false;

    return Object.values(settings).some(value => {
      if (value === null || value === undefined) return false;
      if (typeof value === 'object' && !Array.isArray(value)) {
        return Object.keys(value as Record<string, unknown>).length > 0;
      }
      return true;
    });
  });

  readonly settingsCount = computed(() => this.settingsEntries().length);

  private formatEntry(
    key: string,
    value: unknown
  ): {
    key: string;
    value: unknown;
    display: string;
    tooltip: string;
  } {
    const isSensitive = this.isSensitiveKey(key);
    const restrictedLabel = this.translate.instant('detailShared.settings.restricted');

    return {
      key,
      value,
      display: isSensitive ? restrictedLabel : this.truncateValue(value, 15),
      tooltip: isSensitive ? `[${restrictedLabel}]` : this.generateTooltip(value),
    };
  }

  private isObjectButNotArray(value: unknown): boolean {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  private isSensitiveKey(key: string): boolean {
    if (!this.restrictMode()) return false;
    return SENSITIVE_KEYS.some(sensitive => key.toLowerCase().includes(sensitive));
  }

  private generateTooltip(value: unknown): string {
    try {
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
    } catch {
      return this.translate.instant('detailShared.settings.invalidJson');
    }
  }

  private truncateValue(value: unknown, length: number): string {
    if (value === null || value === undefined) return '';

    if (typeof value === 'object') {
      try {
        const jsonString = JSON.stringify(value);
        return jsonString.length > length ? `${jsonString.slice(0, length)}...` : jsonString;
      } catch {
        return this.translate.instant('detailShared.settings.invalidJson');
      }
    }

    const stringValue = String(value);
    return stringValue.length > length ? `${stringValue.slice(0, length)}...` : stringValue;
  }

  onEditSettings(): void {
    this.editSettings.emit({
      section: this.config().section.key,
      settings: this.config().settings,
    });
  }
}
