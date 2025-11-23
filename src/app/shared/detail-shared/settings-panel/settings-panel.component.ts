import { Component, input, output } from '@angular/core';

import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { SENSITIVE_KEYS, SettingsPanelConfig } from '../../types';

@Component({
  selector: 'app-settings-panel',
  standalone: true,
  imports: [MatCardModule, MatIconModule, MatButtonModule, MatTooltipModule],
  styleUrls: ['./settings-panel.component.scss'],
  template: `
    <mat-card>
      <mat-card-header>
        <mat-card-title>
          <mat-icon [svgIcon]="config().section.icon" class="panel-icon"></mat-icon>
          <span>{{ config().section.title }}</span>
        </mat-card-title>
      </mat-card-header>

      <mat-card-content>
        @if (config().hasSettings) {
          <div class="settings-grid">
            @for (setting of getSettingsEntries(); track setting.key) {
              @if (isObjectButNotArray(setting.value)) {
                @for (subSetting of getObjectEntries(setting.value); track subSetting.key) {
                  <div class="setting-item">
                    <div class="setting-key">{{ subSetting.key }}</div>
                    <div
                      class="setting-value"
                      [matTooltip]="getTooltip(subSetting.key, subSetting.value)"
                      [matTooltipHideDelay]="500"
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
                    [matTooltipHideDelay]="500"
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
      </mat-card-content>

      <mat-card-actions>
        <button
          matButton="filled"
          [class]="'edit-settings-button ' + config().buttonColor"
          (click)="onEditSettings()"
        >
          <mat-icon svgIcon="pen"></mat-icon>
          <span>{{ config().buttonLabel || 'Edit Settings' }}</span>
        </button>
      </mat-card-actions>
    </mat-card>
  `,
})
export class SettingsPanelComponent {
  config = input.required<SettingsPanelConfig>();
  editSettings = output<{ section: string; settings: Record<string, unknown> }>();

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
