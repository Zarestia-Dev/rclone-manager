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

import { LoadingOverlayComponent } from '../../shared/components/loading-overlay/loading-overlay.component';
import { InstallationOptionsComponent } from '../../shared/components/installation-options/installation-options.component';
import { PasswordManagerComponent } from '../../shared/components/password-manager/password-manager.component';
import { ProvisionProgressComponent } from '../../shared/components/provision-progress/provision-progress.component';
import { TranslatePipe } from '@ngx-translate/core';

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

/** Translation keys for the install button when "use existing binary" mode is active. */
const EXISTING_BINARY_BUTTON_LABELS: Readonly<Record<BinaryStatus, string>> = Object.freeze({
  untested: 'onboarding.installButton.testBinary',
  testing: 'onboarding.installButton.testingBinary',
  valid: 'onboarding.installButton.useBinary',
  invalid: 'onboarding.installButton.invalidBinary',
});

interface UiOption {
  value: MainView;
  icon: string;
  colorClass: '' | 'accent' | 'purple';
  badgeKey: string;
  titleKey: string;
  descKey: string;
}

/** View model for the footer's primary action button. */
interface PrimaryButton {
  /** Translation key for the label, or null to render icon-only. */
  labelKey: string | null;
  /** Icon name, or null to render label-only. */
  icon: string | null;
  disabled: boolean;
  /** Translation key for the tooltip, or null for no tooltip. */
  titleKey: string | null;
  action: () => void;
}

@Component({
  selector: 'app-onboarding',
  imports: [
    MatButtonModule,
    MatIconModule,
    LoadingOverlayComponent,
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
  completed = output<void>();

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
    typeof window !== 'undefined' && window.innerWidth <= 600
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
      colorClass: '',
      badgeKey: 'onboarding.uiOptions.main_menu.badge',
      titleKey: 'onboarding.uiOptions.main_menu.title',
      descKey: 'onboarding.uiOptions.main_menu.description',
    },
    {
      value: 'nautilus',
      icon: 'folder-open',
      colorClass: 'accent',
      badgeKey: 'onboarding.uiOptions.nautilus.badge',
      titleKey: 'onboarding.uiOptions.nautilus.title',
      descKey: 'onboarding.uiOptions.nautilus.description',
    },
    {
      value: 'flow',
      icon: 'bolt',
      colorClass: 'purple',
      badgeKey: 'onboarding.uiOptions.flow.badge',
      titleKey: 'onboarding.uiOptions.flow.title',
      descKey: 'onboarding.uiOptions.flow.description',
    },
  ];

  // ─── Computed ───────────────────────────────────────────────────────────────

  readonly isLoading = computed(() => !this.systemHealth.isInitialized());

  readonly cards = computed<OnboardingCard[]>(() => {
    const sys = this.systemHealth;
    return OnboardingComponent.ALL_CARD_KEYS.filter(key => {
      switch (key) {
        case 'installRclone':
          return sys.rcloneInstalled() === false;
        case 'installPlugin':
          return sys.mountPluginInstalled() === false;
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
            if (canInstall) void this.installRclone();
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
            if (!downloading) void this.installMountPlugin();
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
            if (valid) void this.onConfigNext();
          },
        };
      }
      case 'unlock': {
        const submitting = this.isSubmittingPassword();
        const canUnlock = !!this.configPassword() && !submitting;
        return {
          labelKey: submitting ? null : 'onboarding.actions.unlock',
          icon: submitting ? 'spinner' : null,
          disabled: !canUnlock,
          titleKey: null,
          action: (): void => {
            if (canUnlock) void this.submitConfigPassword();
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
      case 'next':
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

  // ─── Constructor ────────────────────────────────────────────────────────────

  constructor() {
    this.eventListenersService
      .listenToRcloneEngineReady()
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.passwordValidationError.set(null));

    afterRenderEffect(onCleanup => {
      const slides = this.slideEls();
      const activeSlide = slides[this.currentCardIndex()];

      if (this.isMobileViewport() || !activeSlide || typeof ResizeObserver === 'undefined') {
        this.viewportHeight.set(null);
        return;
      }

      const el = activeSlide.nativeElement;
      const measure = (): void => {
        const height = el.scrollHeight;
        if (height > 0) this.viewportHeight.set(height);
      };

      measure();
      const observer = new ResizeObserver(measure);
      observer.observe(el);
      onCleanup((): void => {
        observer.disconnect();
      });
    });

    void this.initialize();
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

  // ─── Keyboard navigation ────────────────────────────────────────────────────

  @HostListener('document:keydown', ['$event'])
  handleKeyboardEvent(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      const btn = this.primaryButton();
      if (!btn.disabled) btn.action();
      return;
    }
    if (event.key === 'ArrowRight' && this.currentAction() === 'next') {
      if (!this.primaryButton().disabled) {
        this.nextCard();
      }
    } else if (event.key === 'ArrowLeft' && this.currentCardIndex() > 0) {
      this.previousCard();
    }
  }

  @HostListener('window:resize')
  onWindowResize(): void {
    this.isMobileViewport.set(window.innerWidth <= 600);
  }

  // ─── Navigation ─────────────────────────────────────────────────────────────

  canNavigateToCard(targetIndex: number): boolean {
    const currentIndex = this.currentCardIndex();
    if (targetIndex <= currentIndex) {
      return true;
    }

    const cards = this.cards();
    if (targetIndex >= cards.length) {
      return false;
    }

    if (this.primaryButton().disabled) {
      return false;
    }

    for (let idx = currentIndex; idx < targetIndex; idx++) {
      const card = cards[idx];
      if (!card) return false;

      if (idx > currentIndex && this.isCardKeyBlocked(card.key)) {
        return false;
      }
    }

    return true;
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
    if (this.primaryButton().disabled) {
      return;
    }
    this.currentCardIndex.update(i => Math.min(i + 1, this.cards().length - 1));
  }

  previousCard(): void {
    this.currentCardIndex.update(i => Math.max(i - 1, 0));
  }

  goToCard(targetIndex: number): void {
    if (!this.canNavigateToCard(targetIndex)) {
      return;
    }
    const clamped = Math.max(0, Math.min(targetIndex, this.cards().length - 1));
    this.currentCardIndex.set(clamped);
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

  // ─── Installation / config / password actions ─────────────────────────────

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

  async cancelInstallRclone(): Promise<void> {
    await this.installationService.cancelRcloneInstall();
    this.installing.set(false);
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

  async cancelInstallMountPlugin(): Promise<void> {
    await this.installationService.cancelMountPluginInstall();
    this.downloadingPlugin.set(false);
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
