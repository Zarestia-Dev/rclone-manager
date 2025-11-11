import { CommonModule } from '@angular/common';
import {
  Component,
  EventEmitter,
  Input,
  Output,
  ChangeDetectionStrategy,
  inject,
  OnInit,
  OnDestroy,
  ChangeDetectorRef,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDividerModule } from '@angular/material/divider';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBarModule, MatSnackBar } from '@angular/material/snack-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { Remote, ServeListItem, RemoteSettings, SettingsPanelConfig, RemoteAction } from '@app/types';
import { IconService } from '../../../../shared/services/icon.service';
import { ServeManagementService } from '@app/services';
import { Subject, takeUntil } from 'rxjs';
import { SettingsPanelComponent } from '../../../../shared/detail-shared';
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
    SettingsPanelComponent,
    ServeCardComponent,
  ],
  templateUrl: './serve-detail.component.html',
  styleUrl: './serve-detail.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ServeDetailComponent implements OnInit, OnDestroy {
  readonly iconService = inject(IconService);
  private readonly serveManagementService = inject(ServeManagementService);
  private readonly snackBar = inject(MatSnackBar);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly clipboard = inject(Clipboard);
  private destroy$ = new Subject<void>();

  @Input() selectedRemote!: Remote;
  @Input() remoteSettings: RemoteSettings = {};
  @Input() actionInProgress: RemoteAction = null;
  @Output() startServeClick = new EventEmitter<string>();
  @Output() openRemoteConfigModal = new EventEmitter<{
    editTarget?: string;
    existingConfig?: RemoteSettings;
    initialSection?: string;
  }>();

  remoteServes: ServeListItem[] = [];

  readonly SERVE_SECTIONS: SettingsSection[] = [
    { key: 'serve', title: 'Protocol Options', icon: 'satellite-dish' },
  ];

  readonly ADVANCED_SECTIONS: SettingsSection[] = [
    { key: 'filter', title: 'Filter Options', icon: 'filter', configKey: 'filterConfig' },
    { key: 'vfs', title: 'VFS Options', icon: 'vfs', configKey: 'vfsConfig' },
    { key: 'backend', title: 'Backend Config', icon: 'server', configKey: 'backendConfig' },
  ];

  ngOnInit(): void {
    this.serveManagementService.runningServes$.pipe(takeUntil(this.destroy$)).subscribe(serves => {
      this.remoteServes = this.filterRemoteServes(serves);
      this.cdr.markForCheck();
    });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  private filterRemoteServes(serves: ServeListItem[]): ServeListItem[] {
    return serves.filter(serve => {
      const remoteName = serve.params.fs.split(':')[0];
      return remoteName === this.selectedRemote.remoteSpecs.name;
    });
  }

  private getSettingsForSection(section: SettingsSection): Record<string, unknown> {
    const serveConfig = this.remoteSettings?.['serveConfig'];
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
        serveConfig: this.remoteSettings?.['serveConfig'],
      },
    });
  }

  async stopServe(serve: ServeListItem): Promise<void> {
    try {
      const remoteName = serve.params.fs.split(':')[0];
      await this.serveManagementService.stopServe(serve.id, remoteName);
      this.snackBar.open('Serve stopped successfully', 'Close', { duration: 3000 });
    } catch (error) {
      console.error('Error stopping serve:', error);
      this.snackBar.open('Failed to stop serve', 'Close', { duration: 5000 });
    }
  }

  handleCopyToClipboard(event: { text: string; message: string }): void {
    this.clipboard.copy(event.text);
    this.snackBar.open(event.message, 'Close', { duration: 2000 });
  }

  handleServeCardClick(_serve: ServeListItem): void {
    // In serve-detail view, clicking the card doesn't need to navigate
    // since we're already showing details for this remote
    // Could potentially highlight/focus the specific serve in the future
  }

  onStartServeClick(): void {
    this.startServeClick.emit(this.selectedRemote.remoteSpecs.name);
  }
}
