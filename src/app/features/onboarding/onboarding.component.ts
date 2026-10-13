import {
  Component,
  HostListener,
  inject,
  signal,
  computed,
  ChangeDetectionStrategy,
  output,
  viewChildren,
  ElementRef,
  afterRenderEffect,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';

import { InstallationOptionsComponent } from '../../shared/components/installation-options/installation-options.component';
import { PasswordManagerComponent } from '../../shared/components/password-manager/password-manager.component';
import { ProvisionProgressComponent } from '../../shared/components/provision-progress/provision-progress.component';

import { InstallationService } from 'src/app/services/settings/installation.service';
import { EventListenersService } from 'src/app/services/infrastructure/system/event-listeners.service';
import { AppSettingsService } from 'src/app/services/settings/app-settings.service';
import { RclonePasswordService } from 'src/app/services/security/rclone-password.service';
import { SystemHealthService } from 'src/app/services/infrastructure/maintenance/system-health.service';
import { BackupRestoreUiService } from 'src/app/services/settings/backup-restore-ui.service';
import { UiStateService } from 'src/app/services/ui/state/ui-state.service';
import { BackendService } from '../../services/infrastructure/system/backend.service';
import {
  type BinaryStatus,
  type InstallationOptionsData,
  type OnboardingAction,
  type OnboardingCard,
  type OnboardingCardKey,
  type MainView,
  DEFAULT_ONBOARDING_IMAGE,
  DEFAULT_INSTALLATION_DATA,
  RCLONE_INSTALL_TAB_OPTIONS,
  ONBOARDING_CONFIG_TAB_OPTIONS,
} from '@app/types';

const MOBILE_BREAKPOINT = 600;
const VIEWPORT_VERTICAL_OFFSET = 152;
const MIN_VIEWPORT_HEIGHT = 200;

const EXISTING_BINARY_BUTTON_LABELS: Readonly<Record<BinaryStatus, string>> = Object.freeze({
  untested: 'onboarding.installButton.testBinary',
  testing: 'onboarding.installButton.testingBinary',
  valid: 'onboarding.installButton.useBinary',
  invalid: 'onboarding.installButton.invalidBinary',
});

interface UiOption {
  value: MainView;
  icon: string;
  colorClass: 'primary' | 'accent' | 'purple';
  titleKey: string;
  descKey: string;
}

interface PrimaryButton {
  labelKey: string | null;
  icon: string | null;
  disabled: boolean;
  titleKey: string | null;
  action: () => void;
}

@Component({
  selector: 'app-onboarding',
  imports: [
    MatButtonModule,
    MatIconModule,
    InstallationOptionsComponent,
    PasswordManagerComponent,
    ProvisionProgressComponent,
    TranslatePipe,
  ],
  templateUrl: './onboarding.component.html',
  styleUrls: ['./onboarding.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OnboardingComponent {
  readonly completed = output<void>();

  // ─── Services ───────────────────────────────────────────────────────────────
  private readonly installationService = inject(InstallationService);
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly eventListenersService = inject(EventListenersService);
  private readonly rclonePasswordService = inject(RclonePasswordService);
  private readonly backendService = inject(BackendService);
  private readonly backupRestoreUiService = inject(BackupRestoreUiService);
  private readonly uiStateService = inject(UiStateService);
  readonly systemHealth = inject(SystemHealthService);

  readonly rcloneProgress = this.installationService.rcloneProgress;
  readonly mountPluginProgress = this.installationService.mountPluginProgress;

  // ─── State ──────────────────────────────────────────────────────────────────
  readonly currentCardIndex = signal(0);
  readonly viewportHeight = signal<number | null>(null);

  private readonly isMobileViewport = signal(
    typeof window !== 'undefined' && window.innerWidth <= MOBILE_BREAKPOINT
  );

  private readonly slideEls = viewChildren<ElementRef<HTMLElement>>('slide');

  readonly installing = signal(false);
  readonly downloadingPlugin = signal(false);

  readonly installationData = signal<InstallationOptionsData>({ ...DEFAULT_INSTALLATION_DATA });
  readonly installationValid = signal(true);

  readonly configData = signal<InstallationOptionsData>({ ...DEFAULT_INSTALLATION_DATA });
  readonly configValid = signal(true);

  readonly configPassword = signal('');
  readonly passwordValidationError = signal<string | null>(null);
  readonly isSubmittingPassword = signal(false);

  readonly selectedMainUi = signal<MainView>('main_menu');

  // ─── Static configuration ───────────────────────────────────────────────────
  readonly defaultImage = DEFAULT_ONBOARDING_IMAGE;
  readonly installTabOptions = RCLONE_INSTALL_TAB_OPTIONS;
  readonly configTabOptions = ONBOARDING_CONFIG_TAB_OPTIONS;

  private static readonly CARD_ACTIONS: Partial<Record<OnboardingCardKey, OnboardingAction>> = {
    installRclone: 'install-rclone',
    installPlugin: 'install-plugin',
    selectConfig: 'config-next',
    passwordRequired: 'unlock',
    ready: 'finish',
  };

  private static readonly ALL_CARD_KEYS: readonly OnboardingCardKey[] = [
    'welcome',
    'features',
    'installRclone',
    'installPlugin',
    'selectConfig',
    'passwordRequired',
    'selectMainUi',
    'ready',
  ];

  readonly uiOptions: readonly UiOption[] = [
    {
      value: 'main_menu',
      icon: 'desktop',
      colorClass: 'primary',
      titleKey: 'onboarding.uiOptions.main_menu.title',
      descKey: 'onboarding.uiOptions.main_menu.description',
    },
    {
      value: 'nautilus',
      icon: 'folder-open',
      colorClass: 'accent',
      titleKey: 'onboarding.uiOptions.nautilus.title',
      descKey: 'onboarding.uiOptions.nautilus.description',
    },
    {
      value: 'flow',
      icon: 'bolt',
      colorClass: 'purple',
      titleKey: 'onboarding.uiOptions.flow.title',
      descKey: 'onboarding.uiOptions.flow.description',
    },
  ];

  // ─── Computed ───────────────────────────────────────────────────────────────
  readonly cards = computed<OnboardingCard[]>(() => {
    const sys = this.systemHealth;
    return OnboardingComponent.ALL_CARD_KEYS.filter(key => {
      switch (key) {
        case 'installRclone':
          return !sys.rcloneInstalled();
        case 'installPlugin':
          return !sys.mountPluginInstalled();
        case 'passwordRequired':
          return sys.passwordRequired();
        default:
          return true;
      }
    }).map(key => ({
      key,
      title: `onboarding.cards.${key}.title`,
      content: `onboarding.cards.${key}.content`,
    }));
  });

  readonly currentCard = computed<OnboardingCard | undefined>(() => {
    const cards = this.cards();
    const index = Math.min(this.currentCardIndex(), cards.length - 1);
    return cards[Math.max(0, index)];
  });

  readonly currentAction = computed<OnboardingAction>(() => {
    const key = this.currentCard()?.key;
    return (key && OnboardingComponent.CARD_ACTIONS[key]) ?? 'next';
  });

  readonly isCancellable = computed(
    () =>
      (this.installing() && this.currentAction() === 'install-rclone') ||
      (this.downloadingPlugin() && this.currentAction() === 'install-plugin')
  );

  private readonly canInstall = computed(() => !this.installing() && this.installationValid());

  private readonly installButtonText = computed(() => {
    if (this.installing()) {
      return this.installationData().installLocation === 'existing'
        ? 'onboarding.installButton.configuring'
        : 'onboarding.installButton.installing';
    }

    const data = this.installationData();
    if (data.installLocation === 'custom' && !data.customPath.trim()) {
      return 'onboarding.installButton.selectPath';
    }
    if (data.installLocation === 'existing') {
      if (!data.existingBinaryPath.trim()) return 'onboarding.installButton.selectBinary';
      return EXISTING_BINARY_BUTTON_LABELS[data.binaryTestResult];
    }
    return 'onboarding.installButton.install';
  });

  readonly primaryButton = computed<PrimaryButton>(() => {
    switch (this.currentAction()) {
      case 'install-rclone': {
        const canInstall = this.canInstall();
        return {
          labelKey: this.installButtonText(),
          icon: this.installing() ? 'spinner' : 'download',
          disabled: !canInstall,
          titleKey: !canInstall ? 'onboarding.validation.completeInstallation' : null,
          action: (): void => {
            void this.installRclone();
          },
        };
      }
      case 'install-plugin': {
        const downloading = this.downloadingPlugin();
        return {
          labelKey: downloading
            ? 'onboarding.actions.installingPlugin'
            : 'onboarding.actions.installPlugin',
          icon: downloading ? 'spinner' : 'download',
          disabled: downloading,
          titleKey: null,
          action: (): void => {
            void this.installMountPlugin();
          },
        };
      }
      case 'config-next': {
        const valid = this.configValid();
        return {
          labelKey: 'common.next',
          icon: 'right-arrow',
          disabled: !valid,
          titleKey: !valid ? 'onboarding.validation.selectConfig' : null,
          action: (): void => {
            void this.onConfigNext();
          },
        };
      }
      case 'unlock': {
        const submitting = this.isSubmittingPassword();
        return {
          labelKey: submitting ? null : 'onboarding.actions.unlock',
          icon: submitting ? 'spinner' : null,
          disabled: !this.configPassword() || submitting,
          titleKey: null,
          action: (): void => {
            void this.submitConfigPassword();
          },
        };
      }
      case 'finish':
        return {
          labelKey: 'onboarding.actions.getStarted',
          icon: 'check-circle',
          disabled: false,
          titleKey: null,
          action: (): void => {
            void this.completeOnboarding();
          },
        };
      default:
        return {
          labelKey: 'common.next',
          icon: 'right-arrow',
          disabled: false,
          titleKey: null,
          action: (): void => {
            this.nextCard();
          },
        };
    }
  });

  // ─── Lifecycle & Viewport Sizing ──────────────────────────────────────────
  constructor() {
    this.eventListenersService
      .listenToRcloneEngineReady()
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.passwordValidationError.set(null));

    afterRenderEffect(onCleanup => {
      const activeSlide = this.slideEls()[this.currentCardIndex()];
      if (this.isMobileViewport() || !activeSlide || typeof ResizeObserver === 'undefined') {
        this.viewportHeight.set(null);
        return;
      }

      const el = activeSlide.nativeElement;
      const contentEl = el.querySelector<HTMLElement>('.card-content');
      this.updateViewportHeight(el);

      if (contentEl) {
        const observer = new ResizeObserver(() => this.updateViewportHeight(el));
        observer.observe(contentEl);
        onCleanup(() => observer.disconnect());
      }
    });

    void this.initialize();
  }

  private updateViewportHeight(el?: HTMLElement | null): void {
    if (this.isMobileViewport() || !el) {
      this.viewportHeight.set(null);
      return;
    }

    const contentEl = el.querySelector<HTMLElement>('.card-content');
    if (!contentEl) {
      this.viewportHeight.set(null);
      return;
    }

    const style = typeof window !== 'undefined' ? window.getComputedStyle(el) : null;
    const padTop = style ? parseFloat(style.paddingTop) || 0 : 0;
    const padBottom = style ? parseFloat(style.paddingBottom) || 0 : 0;
    const naturalHeight = contentEl.scrollHeight + padTop + padBottom;

    if (naturalHeight > 0) {
      const maxAvailable =
        typeof window !== 'undefined'
          ? window.innerHeight - VIEWPORT_VERTICAL_OFFSET
          : naturalHeight;
      this.viewportHeight.set(Math.min(naturalHeight, Math.max(maxAvailable, MIN_VIEWPORT_HEIGHT)));
    }
  }

  private async initialize(): Promise<void> {
    try {
      await this.systemHealth.runAllChecks();
      const defaultView =
        await this.appSettingsService.getSettingValue<string>('general.default_view');
      if (defaultView === 'nautilus' || defaultView === 'flow' || defaultView === 'main_menu') {
        this.selectedMainUi.set(defaultView as MainView);
      }
    } catch (error) {
      console.error('OnboardingComponent: System checks failed', error);
    }
  }

  // ─── Keyboard navigation & Window resize ──────────────────────────────────
  @HostListener('document:keydown', ['$event'])
  handleKeyboardEvent(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      const btn = this.primaryButton();
      if (!btn.disabled) btn.action();
      return;
    }
    if (event.key === 'ArrowRight' && this.currentAction() === 'next') {
      if (!this.primaryButton().disabled) this.nextCard();
    } else if (event.key === 'ArrowLeft' && this.currentCardIndex() > 0) {
      this.previousCard();
    }
  }

  @HostListener('window:resize')
  onWindowResize(): void {
    this.isMobileViewport.set(window.innerWidth <= MOBILE_BREAKPOINT);
    const activeSlide = this.slideEls()[this.currentCardIndex()];
    this.updateViewportHeight(activeSlide?.nativeElement);
  }

  // ─── Navigation ─────────────────────────────────────────────────────────────
  canNavigateToCard(targetIndex: number): boolean {
    const currentIndex = this.currentCardIndex();
    if (targetIndex <= currentIndex) return true;
    if (targetIndex >= this.cards().length || this.primaryButton().disabled) return false;

    return this.cards()
      .slice(currentIndex + 1, targetIndex)
      .every(card => !this.isCardKeyBlocked(card.key));
  }

  private isCardKeyBlocked(key: OnboardingCardKey): boolean {
    switch (key) {
      case 'installRclone':
        return !this.systemHealth.rcloneInstalled();
      case 'installPlugin':
        return !this.systemHealth.mountPluginInstalled();
      case 'selectConfig':
        return !this.configValid();
      case 'passwordRequired':
        return this.systemHealth.passwordRequired();
      default:
        return false;
    }
  }

  nextCard(): void {
    if (!this.primaryButton().disabled) {
      this.currentCardIndex.update(i => Math.min(i + 1, this.cards().length - 1));
    }
  }

  previousCard(): void {
    this.currentCardIndex.update(i => Math.max(i - 1, 0));
  }

  goToCard(targetIndex: number): void {
    if (this.canNavigateToCard(targetIndex)) {
      this.currentCardIndex.set(Math.max(0, Math.min(targetIndex, this.cards().length - 1)));
    }
  }

  selectMainUiOption(view: MainView): void {
    this.selectedMainUi.set(view);
  }

  async completeOnboarding(): Promise<void> {
    try {
      await this.appSettingsService.saveSetting('general', 'default_view', this.selectedMainUi());
      this.uiStateService.setDefaultView(this.selectedMainUi());
    } catch (error) {
      console.error('Error saving default view on completing onboarding:', error);
    }
    this.completed.emit();
  }

  // ─── Actions & Tasks ────────────────────────────────────────────────────────
  async installRclone(): Promise<void> {
    this.installing.set(true);
    try {
      const data = this.installationData();
      if (data.installLocation === 'existing') {
        await this.appSettingsService.saveSetting('core', 'rclone_binary', data.existingBinaryPath);
      } else {
        const installPath = data.installLocation === 'default' ? null : data.customPath;
        await this.installationService.installRclone(installPath);
      }
      this.systemHealth.markRcloneInstalled();
    } catch (error) {
      console.error('RClone installation/configuration failed:', error);
    } finally {
      this.installing.set(false);
    }
  }

  async installMountPlugin(): Promise<void> {
    this.downloadingPlugin.set(true);
    try {
      await this.installationService.installMountPlugin();
      await this.systemHealth.checkMountPlugin();
    } catch (error) {
      console.error('Plugin installation failed:', error);
    } finally {
      this.downloadingPlugin.set(false);
    }
  }

  async cancelActiveTask(): Promise<void> {
    if (this.installing()) {
      await this.installationService.cancelRcloneInstall();
      this.installing.set(false);
    } else if (this.downloadingPlugin()) {
      await this.installationService.cancelMountPluginInstall();
      this.downloadingPlugin.set(false);
    }
  }

  async onConfigNext(): Promise<void> {
    try {
      const data = this.configData();
      if (data.installLocation === 'custom' && data.customPath) {
        await this.backendService.updateLocalBackendConfigPath(data.customPath);
      }
      await this.systemHealth.checkConfigEncryption();
    } catch (error) {
      console.error('Failed to update config selection:', error);
    }
    this.nextCard();
  }

  async submitConfigPassword(): Promise<void> {
    if (!this.configPassword() || this.isSubmittingPassword()) return;

    this.isSubmittingPassword.set(true);
    try {
      const password = this.configPassword();
      await this.rclonePasswordService.validatePassword(password);
      await this.rclonePasswordService.setConfigPasswordEnv(password);
      await this.rclonePasswordService.storePassword(password);
      this.systemHealth.markPasswordUnlocked();
      this.passwordValidationError.set(null);
      this.nextCard();
    } catch (error) {
      console.error('Password validation failed:', error);
      this.passwordValidationError.set('onboarding.validation.wrongPassword');
    } finally {
      this.isSubmittingPassword.set(false);
    }
  }

  importSettings(): void {
    this.backupRestoreUiService.launchRestoreFlow();
  }
}
