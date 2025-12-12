import { Component, input, output } from '@angular/core';

import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatExpansionModule } from '@angular/material/expansion';
import { SENSITIVE_KEYS, SettingsPanelConfig } from '@app/types';

@Component({
  selector: 'app-settings-panel',
  standalone: true,
  imports: [MatCardModule, MatIconModule, MatButtonModule, MatTooltipModule, MatExpansionModule],
  styleUrls: ['./settings-panel.component.scss'],
  template: `
    <mat-expansion-panel class="settings-expansion-panel">
      <mat-expansion-panel-header>
        <mat-panel-title>
          <mat-icon [svgIcon]="config().section.icon" class="panel-icon"></mat-icon>
          <span>{{ config().section.title }}</span>
        </mat-panel-title>
        <mat-panel-description>
          @if (hasMeaningfulSettings()) {
            <span class="settings-count">{{ getSettingsCount() }} settings</span>
          } @else {
            <span class="no-settings-hint">Not configured</span>
          }
        </mat-panel-description>
      </mat-expansion-panel-header>

      <div class="panel-body">
        @if (hasMeaningfulSettings()) {
          <div class="settings-grid">
            @for (setting of getSettingsEntries(); track setting.key) {
              @if (isObjectButNotArray(setting.value)) {
                @for (subSetting of getObjectEntries(setting.value); track subSetting.key) {
                  <div class="setting-item">
                    <div class="setting-key">{{ subSetting.key }}</div>
                    <div
                      class="setting-value"
                      [matTooltip]="getTooltip(subSetting.key, subSetting.value)"
                      [matTooltipShowDelay]="500"
                    >
                      {{ getDisplayValue(subSetting.key, subSetting.value) }}
                    </div>
                  </div>
                }
              } @else {
                <div class="setting-item">
                  <div class="setting-key">{{ setting.key }}</div>
                  <div
                    class="setting-value"
                    [matTooltip]="getTooltip(setting.key, setting.value)"
                    [matTooltipShowDelay]="500"
                  >
                    {{ getDisplayValue(setting.key, setting.value) }}
                  </div>
                </div>
              }
            }
          </div>
        } @else {
          <div class="no-settings">
            <mat-icon [svgIcon]="config().section.icon" class="no-settings-icon"></mat-icon>
            <span>No configuration data available</span>
          </div>
        }

        <div class="panel-actions">
          <button
            matButton="filled"
            [class]="'edit-settings-button ' + config().buttonColor"
            (click)="onEditSettings()"
          >
            <mat-icon svgIcon="pen"></mat-icon>
            <span>{{ config().buttonLabel || 'Edit Settings' }}</span>
          </button>
        </div>
      </div>
    </mat-expansion-panel>
  `,
})
export class SettingsPanelComponent {
  config = input.required<SettingsPanelConfig>();
  editSettings = output<{ section: string; settings: Record<string, unknown> }>();

  hasMeaningfulSettings(): boolean {
    const settings = this.config().settings;
    if (!settings || Object.keys(settings).length === 0) {
      return false;
    }

    // Check if all values are empty objects or null/undefined
    return Object.values(settings).some(value => {
      if (value === null || value === undefined) {
        return false;
      }
      if (typeof value === 'object' && !Array.isArray(value)) {
        return Object.keys(value as Record<string, unknown>).length > 0;
      }
      return true;
    });
  }

  getSettingsCount(): number {
    const entries = this.getSettingsEntries();
    let count = 0;
    for (const entry of entries) {
      if (this.isObjectButNotArray(entry.value)) {
        count += Object.keys(entry.value as Record<string, unknown>).length;
      } else {
        count++;
      }
    }
    return count;
  }

  getSettingsEntries(): { key: string; value: unknown }[] {
    return Object.entries(this.config().settings || {}).map(([key, value]) => ({
      key,
      value,
    }));
  }

  getObjectEntries(obj: unknown): { key: string; value: unknown }[] {
    return Object.entries((obj as Record<string, unknown>) || {}).map(([key, value]) => ({
      key,
      value,
    }));
  }

  isObjectButNotArray(value: unknown): boolean {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  isSensitiveKey(key: string): boolean {
    const sensitiveKeys = SENSITIVE_KEYS;
    return (
      sensitiveKeys.some(sensitive => key.toLowerCase().includes(sensitive)) &&
      this.config().restrictMode
    );
  }

  getDisplayValue(key: string, value: unknown): string {
    if (this.isSensitiveKey(key)) {
      return 'RESTRICTED';
    }
    return this.truncateValue(value, 15);
  }

  getTooltip(key: string, value: unknown): string {
    if (this.isSensitiveKey(key)) {
      return '[RESTRICTED]';
    }
    try {
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
    } catch {
      return '[Invalid JSON]';
    }
  }

  private truncateValue(value: unknown, length: number): string {
    if (value === null || value === undefined) return '';

    if (typeof value === 'object') {
      try {
        const jsonString = JSON.stringify(value);
        return jsonString.length > length ? `${jsonString.slice(0, length)}...` : jsonString;
      } catch {
        return '[Invalid JSON]';
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
