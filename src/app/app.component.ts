import {
  ChangeDetectionStrategy,
  Component,
  inject,
  OnInit,
  signal,
  Injector,
} from '@angular/core';
import { NgComponentOutlet } from '@angular/common';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { Subject, Observable } from 'rxjs';
import { getCurrentWindow } from '@tauri-apps/api/window';

import { TitlebarComponent } from './layout/titlebar/titlebar.component';
import { OnboardingComponent } from './features/onboarding/onboarding.component';
import { HomeComponent } from './home/home.component';
import { TabsButtonsComponent } from './layout/tabs-buttons/tabs-buttons.component';
import { ShortcutHandlerDirective } from '@app/directives';
import { BannerComponent } from './layout/banners/banner.component';
import { NautilusComponent } from './file-browser/nautilus/nautilus.component';

// Services
import {
  AppSettingsService,
  OnboardingStateService,
  NautilusService,
  BackendService,
  IconService,
  DebugService,
  GlobalLoadingService,
} from '@app/services';
import { isHeadlessMode } from './services/infrastructure/platform/api-client.service';
import { SseClientService } from './services/infrastructure/platform/sse-client.service';

class ChildDialogRef<R = any> {
  constructor(public id: string) {}

  close(result?: R): void {
    getCurrentWindow()
      .emit(`dialog-result-${this.id}`, result)
      .then(() => {
        getCurrentWindow().close();
      })
      .catch(err => {
        console.error('Failed to emit dialog result or close window:', err);
        getCurrentWindow().close();
      });
  }

  backdropClick(): Observable<MouseEvent> {
    return new Subject<MouseEvent>().asObservable();
  }

  keydownEvents(): Observable<KeyboardEvent> {
    return new Subject<KeyboardEvent>().asObservable();
  }

  updatePosition(): this {
    return this;
  }

  updateSize(): this {
    return this;
  }
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    TitlebarComponent,
    OnboardingComponent,
    TabsButtonsComponent,
    HomeComponent,
    ShortcutHandlerDirective,
    BannerComponent,
    NautilusComponent,
    NgComponentOutlet,
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent implements OnInit {
  readonly initializing = signal(true);

  protected readonly nautilusService = inject(NautilusService);
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly onboardingStateService = inject(OnboardingStateService);
  private readonly backendService = inject(BackendService);
  private readonly sseClient = inject(SseClientService);
  private readonly loadingService = inject(GlobalLoadingService);
  private readonly parentInjector = inject(Injector);

  readonly completedOnboarding = this.onboardingStateService.isCompleted;

  readonly isDialogStandalone = signal(false);
  readonly dialogComponent = signal<any>(null);
  dialogInjector?: Injector;

  constructor() {
    inject(IconService);
    inject(DebugService);

    const urlParams = new URLSearchParams(window.location.search);
    const isDialog = urlParams.get('standalone') === 'dialog';
    this.isDialogStandalone.set(isDialog);

    this.loadingService.bindToShutdownEvents();
    this.connectSseIfHeadless();
  }

  ngOnInit(): void {
    this.initializeApp().catch(error => {
      console.error('Error during app initialization:', error);
      this.initializing.set(false);
    });
  }

  private async resolveDialogWindow(): Promise<void> {
    const urlParams = new URLSearchParams(window.location.search);
    const dialogType = urlParams.get('dialogType');
    const rawData = urlParams.get('data');

    const componentsMap: Record<string, () => Promise<any>> = {
      'quick-add-remote': () =>
        import('./features/modals/remote-management/quick-add-remote/quick-add-remote.component').then(
          m => m.QuickAddRemoteComponent
        ),
      'remote-config': () =>
        import('./features/modals/remote-management/remote-config-modal/remote-config-modal.component').then(
          m => m.RemoteConfigModalComponent
        ),
      logs: () =>
        import('./features/modals/settings/logs-modal/logs-modal.component').then(
          m => m.LogsModalComponent
        ),
      export: () =>
        import('./features/modals/settings/export-modal/export-modal.component').then(
          m => m.ExportModalComponent
        ),
      backend: () =>
        import('./features/modals/settings/backend-modal/backend-modal.component').then(
          m => m.BackendModalComponent
        ),
      preferences: () =>
        import('./features/modals/settings/preferences-modal/preferences-modal.component').then(
          m => m.PreferencesModalComponent
        ),
      'rclone-flags': () =>
        import('./features/modals/settings/rclone-flags-modal/rclone-flags-modal.component').then(
          m => m.RcloneFlagsModalComponent
        ),
      'job-detail': () =>
        import('./features/modals/job-detail-modal/job-detail-modal.component').then(
          m => m.JobDetailModalComponent
        ),
      properties: () =>
        import('./features/modals/properties/properties-modal.component').then(
          m => m.PropertiesModalComponent
        ),
      'remote-about': () =>
        import('./features/modals/remote/remote-about-modal.component').then(
          m => m.RemoteAboutModalComponent
        ),
      'keyboard-shortcuts': () =>
        import('./features/modals/settings/keyboard-shortcuts-modal/keyboard-shortcuts-modal.component').then(
          m => m.KeyboardShortcutsModalComponent
        ),
      about: () =>
        import('./features/modals/settings/about-modal/about-modal.component').then(
          m => m.AboutModalComponent
        ),
      'restore-preview': () =>
        import('./features/modals/settings/restore-preview-modal/restore-preview-modal.component').then(
          m => m.RestorePreviewModalComponent
        ),
      alerts: () =>
        import('./features/modals/alerts-modal/alerts-modal.component').then(
          m => m.AlertsModalComponent
        ),
      'alert-action-editor': () =>
        import('./features/modals/alerts-modal/actions/alert-action-editor/alert-action-editor.component').then(
          m => m.AlertActionEditorComponent
        ),
      'alert-rule-editor': () =>
        import('./features/modals/alerts-modal/rules/alert-rules-editor/alert-rule-editor.component').then(
          m => m.AlertRuleEditorComponent
        ),
    };

    const loader = dialogType ? componentsMap[dialogType] : null;
    if (!loader) {
      console.error(`[AppComponent] Standalone dialog component not found for type: ${dialogType}`);
      return;
    }

    try {
      const componentClass = await loader();
      this.dialogComponent.set(componentClass);
    } catch (e) {
      console.error('[AppComponent] Failed to load dialog component dynamically:', e);
      return;
    }

    let parsedData: any = null;
    if (rawData) {
      try {
        parsedData = JSON.parse(decodeURIComponent(rawData));
      } catch (e) {
        console.error('[AppComponent] Failed to parse query parameter data:', e);
      }
    }

    const currentWindowLabel = getCurrentWindow().label;
    const mockRef = new ChildDialogRef(currentWindowLabel);

    this.dialogInjector = Injector.create({
      providers: [
        { provide: MAT_DIALOG_DATA, useValue: parsedData },
        { provide: MatDialogRef, useValue: mockRef },
      ],
      parent: this.parentInjector,
    });
  }

  private async initializeApp(): Promise<void> {
    try {
      await this.appSettingsService.loadSettings();
      await this.appSettingsService.applySavedLanguage();
      this.nautilusService.openFromBrowseQueryParam();

      if (this.isDialogStandalone()) {
        await this.resolveDialogWindow();
      } else if (!this.nautilusService.isStandaloneWindow()) {
        this.backendService.runStartupChecks();
      }
    } catch (error) {
      console.error('App initialization failed:', error);
    } finally {
      this.initializing.set(false);
    }
  }

  private connectSseIfHeadless(): void {
    if (isHeadlessMode()) {
      this.sseClient.connect();
    }
  }

  async finishOnboarding(): Promise<void> {
    try {
      await this.onboardingStateService.completeOnboarding();
    } catch (error) {
      console.error('Error saving onboarding status:', error);
      throw error;
    }
  }
}
