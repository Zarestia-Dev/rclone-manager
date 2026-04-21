import {
  Component,
  HostListener,
  inject,
  signal,
  computed,
  ChangeDetectionStrategy,
  output,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

import { LoadingOverlayComponent } from '../../shared/components/loading-overlay/loading-overlay.component';
import { InstallationOptionsComponent } from '../../shared/components/installation-options/installation-options.component';
import { PasswordManagerComponent } from '../../shared/components/password-manager/password-manager.component';
import { TranslateModule } from '@ngx-translate/core';

import {
  InstallationService,
  EventListenersService,
  AppSettingsService,
  FileSystemService,
  RclonePasswordService,
  SystemHealthService,
} from '@app/services';
import { BackendService } from '../../services/infrastructure/system/backend.service';
import { InstallationOptionsData, InstallationTabOption } from '@app/types';

interface OnboardingCard {
  key: string;
  image: string;
  title: string;
  content: string;
}

type OnboardingAction =
  | 'install-rclone'
  | 'install-plugin'
  | 'config-next'
  | 'unlock'
  | 'finish'
  | 'next';

const delay = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

@Component({
  selector: 'app-onboarding',
  standalone: true,
  imports: [
    MatButtonModule,
    MatIconModule,
    MatTooltipModule,
    LoadingOverlayComponent,
    InstallationOptionsComponent,
    MatProgressSpinnerModule,
    PasswordManagerComponent,
    TranslateModule,
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
  private readonly fileSystemService = inject(FileSystemService);
  private readonly rclonePasswordService = inject(RclonePasswordService);
  private readonly backendService = inject(BackendService);
  readonly systemHealth = inject(SystemHealthService);

  // ─── State ──────────────────────────────────────────────────────────────────

  readonly animationState = signal<'loading' | 'visible'>('loading');
  readonly currentCardIndex = signal(0);

  readonly installing = signal(false);
  readonly downloadingPlugin = signal(false);

  readonly installationData = signal<InstallationOptionsData>({
    installLocation: 'default',
    customPath: '',
    existingBinaryPath: '',
    binaryTestResult: 'untested',
  });
  readonly installationValid = signal(true);

  readonly configData = signal<InstallationOptionsData>({
    installLocation: 'default',
    customPath: '',
    existingBinaryPath: '',
    binaryTestResult: 'untested',
  });
  readonly configValid = signal(true);

  readonly configPassword = signal('');
  readonly passwordValidationError = signal<string | null>(null);
  readonly isSubmittingPassword = signal(false);

  // ─── Computed ───────────────────────────────────────────────────────────────

  private readonly baseCards: OnboardingCard[] = [
    {
      key: 'welcome',
      image: '../assets/rclone-manager.svg',
      title: 'onboarding.cards.welcome.title',
      content: 'onboarding.cards.welcome.content',
    },
    {
      key: 'features',
      image: '../assets/rclone-manager.svg',
      title: 'onboarding.cards.features.title',
      content: 'onboarding.cards.features.content',
    },
  ];

  readonly cards = computed<OnboardingCard[]>(() => {
    const result: OnboardingCard[] = [...this.baseCards];

    if (this.systemHealth.rcloneInstalled() === false) {
      result.push({
        key: 'installRclone',
        image: '../assets/rclone-manager.svg',
        title: 'onboarding.cards.installRclone.title',
        content: 'onboarding.cards.installRclone.content',
      });
    }

    if (this.systemHealth.mountPluginInstalled() === false) {
      result.push({
        key: 'installPlugin',
        image: '../assets/rclone-manager.svg',
        title: 'onboarding.cards.installPlugin.title',
        content: 'onboarding.cards.installPlugin.content',
      });
    }

    result.push({
      key: 'selectConfig',
      image: '../assets/rclone-manager.svg',
      title: 'onboarding.cards.selectConfig.title',
      content: 'onboarding.cards.selectConfig.content',
    });

    if (this.systemHealth.passwordRequired()) {
      result.push({
        key: 'passwordRequired',
        image: '../assets/rclone-manager.svg',
        title: 'onboarding.cards.passwordRequired.title',
        content: 'onboarding.cards.passwordRequired.content',
      });
    }

    result.push({
      key: 'ready',
      image: '../assets/rclone-manager.svg',
      title: 'onboarding.cards.ready.title',
      content: 'onboarding.cards.ready.content',
    });

    return result;
  });

  readonly currentCard = computed(() => {
    const cards = this.cards();
    const index = Math.min(this.currentCardIndex(), cards.length - 1);
    return cards[Math.max(0, index)];
  });

  readonly currentAction = computed<OnboardingAction>(() => {
    const card = this.currentCard();
    if (card.key === 'installRclone' && !this.systemHealth.rcloneInstalled())
      return 'install-rclone';
    if (card.key === 'installPlugin' && !this.systemHealth.mountPluginInstalled())
      return 'install-plugin';
    if (card.key === 'selectConfig') return 'config-next';
    if (card.key === 'passwordRequired') return 'unlock';
    if (card.key === 'ready') return 'finish';
    return 'next';
  });

  readonly canInstall = computed(() => !this.installing() && this.installationValid());

  readonly installButtonText = computed(() => {
    const data = this.installationData();

    if (this.installing()) {
      return data.installLocation === 'existing'
        ? 'onboarding.installButton.configuring'
        : 'onboarding.installButton.installing';
    }
    if (data.installLocation === 'custom' && !data.customPath.trim()) {
      return 'onboarding.installButton.selectPath';
    }
    if (data.installLocation === 'existing') {
      if (!data.existingBinaryPath.trim()) return 'onboarding.installButton.selectBinary';
      if (data.binaryTestResult === 'invalid') return 'onboarding.installButton.invalidBinary';
      if (data.binaryTestResult === 'testing') return 'onboarding.installButton.testingBinary';
      if (data.binaryTestResult === 'valid') return 'onboarding.installButton.useBinary';
      return 'onboarding.installButton.testBinary';
    }
    return 'onboarding.installButton.install';
  });

  // ─── Tab Options ────────────────────────────────────────────────────────────

  readonly onboardingTabOptions: InstallationTabOption[] = [
    { key: 'default', label: 'onboarding.options.recommended', icon: 'star' },
    { key: 'custom', label: 'onboarding.options.custom', icon: 'folder' },
    { key: 'existing', label: 'onboarding.options.existing', icon: 'file' },
  ];

  constructor() {
    this.eventListenersService
      .listenToRcloneEngineReady()
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.passwordValidationError.set(null));

    this.initOnboarding();
  }

  // ─── Init ────────────────────────────────────────────────────────────────────

  private async initOnboarding(): Promise<void> {
    await delay(500);
    try {
      await this.systemHealth.runAllChecks();
    } catch (error) {
      console.error('OnboardingComponent: System checks failed', error);
    }
    await delay(300);
    this.animationState.set('visible');
  }

  // ─── Keyboard Navigation ─────────────────────────────────────────────────────

  @HostListener('document:keydown', ['$event'])
  handleKeyboardEvent(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      switch (this.currentAction()) {
        case 'install-rclone':
          if (this.canInstall()) this.installRclone();
          break;
        case 'install-plugin':
          if (!this.downloadingPlugin()) this.installMountPlugin();
          break;
        case 'config-next':
          if (this.configValid()) this.onConfigNext();
          break;
        case 'unlock':
          if (this.configPassword() && !this.isSubmittingPassword()) this.submitConfigPassword();
          break;
        case 'finish':
          this.completeOnboarding();
          break;
        case 'next':
          this.nextCard();
          break;
      }
      return;
    }

    if (event.key === 'ArrowRight' && this.currentAction() === 'next') {
      this.nextCard();
    } else if (event.key === 'ArrowLeft' && this.currentCardIndex() > 0) {
      this.previousCard();
    }
  }

  // ─── Navigation ─────────────────────────────────────────────────────────────

  nextCard(): void {
    if (this.currentCardIndex() < this.cards().length - 1) {
      this.currentCardIndex.update(i => i + 1);
    }
  }

  previousCard(): void {
    if (this.currentCardIndex() > 0) {
      this.currentCardIndex.update(i => i - 1);
    }
  }

  completeOnboarding(): void {
    this.completed.emit();
  }

  // ─── Installation ────────────────────────────────────────────────────────────

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

  // ─── Installation Options Callbacks ──────────────────────────────────────────

  onInstallationOptionsChange(data: InstallationOptionsData): void {
    this.installationData.set(data);
  }

  onInstallationValidChange(valid: boolean): void {
    this.installationValid.set(valid);
  }

  // ─── Config Selection ─────────────────────────────────────────────────────────

  async onConfigNext(): Promise<void> {
    try {
      const data = this.configData();
      if (data.installLocation === 'custom' && data.customPath) {
        // rclone_config_file is now stored as config_path on the Local backend.
        // Ensure backends are loaded (they may not be during onboarding).
        if (this.backendService.backends().length === 0) {
          await this.backendService.loadBackends();
        }
        const localBackend = this.backendService.backends().find(b => b.name === 'Local');
        if (localBackend) {
          await this.backendService.updateBackend({
            name: 'Local',
            host: localBackend.host,
            oauthHost: localBackend.oauthHost,
            port: localBackend.port,
            isLocal: true,
            username: localBackend.username,
            password: localBackend.password,
            configPath: data.customPath,
            oauthPort: localBackend.oauthPort,
          });
        }
      }
      await this.systemHealth.checkConfigEncryption();
    } catch (error) {
      console.error('Failed to update config selection:', error);
    }
    this.nextCard();
  }

  onConfigOptionsChange(data: InstallationOptionsData): void {
    this.configData.set(data);
  }

  onConfigValidChange(valid: boolean): void {
    this.configValid.set(valid);
  }

  // ─── Password ────────────────────────────────────────────────────────────────

  async submitConfigPassword(): Promise<void> {
    if (!this.configPassword() || this.isSubmittingPassword()) return;

    this.isSubmittingPassword.set(true);
    try {
      await this.rclonePasswordService.validatePassword(this.configPassword());
      await this.rclonePasswordService.setConfigPasswordEnv(this.configPassword());
      await this.rclonePasswordService.storePassword(this.configPassword());
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
}
