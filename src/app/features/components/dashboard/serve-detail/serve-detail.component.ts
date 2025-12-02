import { CommonModule } from '@angular/common';
import { Component, inject, input, output, computed } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDividerModule } from '@angular/material/divider';
import { MatTabsModule } from '@angular/material/tabs';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBarModule } from '@angular/material/snack-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import {
  Remote,
  ServeListItem,
  RemoteSettings,
  SettingsPanelConfig,
  RemoteAction,
} from '@app/types';
import { IconService } from '../../../../shared/services/icon.service';
import { SettingsPanelComponent } from '../../../../shared/detail-shared';
import { VfsControlPanelComponent } from 'src/app/shared/detail-shared/vfs-control/vfs-control-panel.component';
import { Clipboard } from '@angular/cdk/clipboard';
import { ServeCardComponent } from '../../../../shared/components/serve-card/serve-card.component';

interface SettingsSection {
  key: string;
  title: string;
  icon: string;
  configKey?: string;
}

@Component({
  selector: 'app-serve-detail',
  standalone: true,
  imports: [
    CommonModule,
    MatIconModule,
    MatButtonModule,
    MatCardModule,
    MatDividerModule,
    MatTooltipModule,
    MatProgressSpinnerModule,
    MatSnackBarModule,
    MatTabsModule,
    SettingsPanelComponent,
    VfsControlPanelComponent,
    ServeCardComponent,
  ],
  templateUrl: './serve-detail.component.html',
  styleUrl: './serve-detail.component.scss',
})
export class ServeDetailComponent {
  readonly iconService = inject(IconService);
  private readonly clipboard = inject(Clipboard);

  selectedRemote = input.required<Remote>();
  remoteSettings = input<RemoteSettings>({});
  actionInProgress = input<RemoteAction | null>(null);
  runningServes = input.required<ServeListItem[]>();

  startJob = output<{ type: 'serve'; remoteName: string }>();
  stopJob = output<{ type: 'serve'; remoteName: string; serveId: string }>();
  openRemoteConfigModal = output<{
    editTarget?: string;
    existingConfig?: RemoteSettings;
    initialSection?: string;
  }>();

  readonly remoteServes = computed(() => {
    const serves = this.runningServes();
    const remote = this.selectedRemote();
    if (remote) {
      return serves.filter(serve => {
        const remoteName = serve.params.fs.split(':')[0];
        return remoteName === remote.remoteSpecs.name;
      });
    }
    return [];
  });

  readonly SERVE_SECTIONS: SettingsSection[] = [
    { key: 'serve', title: 'Protocol Options', icon: 'satellite-dish' },
  ];

  readonly ADVANCED_SECTIONS: SettingsSection[] = [
    { key: 'filter', title: 'Filter Options', icon: 'filter', configKey: 'filterConfig' },
    { key: 'vfs', title: 'VFS Options', icon: 'vfs', configKey: 'vfsConfig' },
    { key: 'backend', title: 'Backend Config', icon: 'server', configKey: 'backendConfig' },
  ];

  private getSettingsForSection(section: SettingsSection): Record<string, unknown> {
    const serveConfig = this.remoteSettings()?.['serveConfig'];
    if (!serveConfig) return {};
    if (section.key === 'serve') {
      return (serveConfig.options as Record<string, unknown>) || {};
    }
    if (section.configKey) {
      return (serveConfig[section.configKey] as Record<string, unknown>) || {};
    }
    return {};
  }

  getSettingsPanelConfig(section: SettingsSection): SettingsPanelConfig {
    const settings = this.getSettingsForSection(section);
    return {
      section: {
        key: section.key,
        title: section.title,
        icon: section.icon,
      },
      settings,
      hasSettings: Object.keys(settings).length > 0,
      restrictMode: false,
    };
  }

  onEditSettings(event: { section: string }): void {
    this.openRemoteConfigModal.emit({
      editTarget: 'serve',
      initialSection: event.section,
      existingConfig: {
        serveConfig: this.remoteSettings()?.['serveConfig'],
      },
    });
  }

  async stopServe(serve: ServeListItem): Promise<void> {
    const remoteName = serve.params.fs.split(':')[0];
    this.stopJob.emit({ type: 'serve', remoteName, serveId: serve.id });
  }

  handleCopyToClipboard(event: { text: string; message: string }): void {
    this.clipboard.copy(event.text);
  }

  onStartServeClick(): void {
    this.startJob.emit({ type: 'serve', remoteName: this.selectedRemote().remoteSpecs.name });
  }
}
