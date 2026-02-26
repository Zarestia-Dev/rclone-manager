import {
  Component,
  EventEmitter,
  Output,
  OnInit,
  HostListener,
  inject,
  signal,
  computed,
  ChangeDetectionStrategy,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { FormsModule } from '@angular/forms';

import { LoadingOverlayComponent } from '../../shared/components/loading-overlay/loading-overlay.component';
import { InstallationOptionsComponent } from '../../shared/components/installation-options/installation-options.component';
import { PasswordManagerComponent } from '../../shared/components/password-manager/password-manager.component';
import { TranslateModule } from '@ngx-translate/core';

// Services
import { InstallationService } from '@app/services';
import { EventListenersService } from '@app/services';
import { AppSettingsService } from '@app/services';
import { FileSystemService } from '@app/services';
import { RclonePasswordService } from '@app/services';
import { SystemHealthService } from '@app/services';
import { InstallationOptionsData, InstallationTabOption } from '@app/types';

/** Card definition for onboarding wizard */
interface OnboardingCard {
  key: string;
  image: string;
  title: string;
  content: string;
}

/** Action types for footer button */
type OnboardingAction =
  | 'install-rclone'
  | 'install-plugin'
  | 'config-next'
  | 'unlock'
  | 'finish'
  | 'next';

@Component({
  selector: 'app-onboarding',
  standalone: true,
  imports: [
    MatCardModule,
    MatButtonModule,
    MatIconModule,
    MatTooltipModule,
    LoadingOverlayComponent,
    InstallationOptionsComponent,
    MatButtonToggleModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressSpinnerModule,
    FormsModule,
    PasswordManagerComponent,
    TranslateModule,
  ],
  templateUrl: './onboarding.component.html',
  styleUrls: ['./onboarding.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OnboardingComponent implements OnInit {
  @Output() completed = new EventEmitter<void>();

  // ─── Services ───────────────────────────────────────────────────────────────

  private readonly installationService = inject(InstallationService);
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly eventListenersService = inject(EventListenersService);
  private readonly fileSystemService = inject(FileSystemService);
  private readonly rclonePasswordService = inject(RclonePasswordService);
  readonly systemHealth = inject(SystemHealthService);

  // ─── Local State Signals ────────────────────────────────────────────────────

  readonly animationState = signal<'loading' | 'visible'>('loading');
  readonly currentCardIndex = signal(0);

  // Installation state
  readonly installing = signal(false);
  readonly downloadingPlugin = signal(false);

  // Installation options data from shared component
  readonly installationData = signal<InstallationOptionsData>({
    installLocation: 'default',
    customPath: '',
    existingBinaryPath: '',
    binaryTestResult: 'untested',
  });
  readonly installationValid = signal(true);

  // Config state
  readonly configSelection = signal<'default' | 'custom'>('default');
  readonly customConfigPath = signal('');
  readonly configValid = signal(true);

  // Password state
  readonly configPassword = signal('');
  readonly passwordValidationError = signal<string | null>(null);
  readonly isSubmittingPassword = signal(false);

  // ─── Computed Values ────────────────────────────────────────────────────────

  /** Base cards that are always shown */
  private readonly baseCards: OnboardingCard[] = [
    {
      key: 'welcome',
      image: '../assets/rclone.svg',
      title: 'onboarding.cards.welcome.title',
      content: 'onboarding.cards.welcome.content',
    },
    {
      key: 'features',
      image: '../assets/rclone.svg',
      title: 'onboarding.cards.features.title',
      content: 'onboarding.cards.features.content',
    },
  ];

  /** Dynamically computed cards based on system health state */
  readonly cards = computed<OnboardingCard[]>(() => {
    const result: OnboardingCard[] = [...this.baseCards];

    // Only add installation cards when we KNOW they're not installed (false)
    // Don't add when still checking (null)
    if (this.systemHealth.rcloneInstalled() === false) {
      result.push({
        key: 'installRclone',
        image: '../assets/rclone.svg',
        title: 'onboarding.cards.installRclone.title',
        content: 'onboarding.cards.installRclone.content',
      });
    }

    // Add mount plugin card only if explicitly not installed
    if (this.systemHealth.mountPluginInstalled() === false) {
      result.push({
        key: 'installPlugin',
        image: '../assets/rclone.svg',
        title: 'onboarding.cards.installPlugin.title',
        content: 'onboarding.cards.installPlugin.content',
      });
    }

    // Always add config selection card
    result.push({
      key: 'selectConfig',
      image: '../assets/rclone.svg',
      title: 'onboarding.cards.selectConfig.title',
      content: 'onboarding.cards.selectConfig.content',
    });

    // Add password card if config is encrypted and not unlocked
    if (this.systemHealth.passwordRequired()) {
      result.push({
        key: 'passwordRequired',
        image: '../assets/rclone.svg',
        title: 'onboarding.cards.passwordRequired.title',
        content: 'onboarding.cards.passwordRequired.content',
      });
    }

    // Always end with ready card
    result.push({
      key: 'ready',
      image: '../assets/rclone.svg',
      title: 'onboarding.cards.ready.title',
      content: 'onboarding.cards.ready.content',
    });

    return result;
  });

  /** Currently displayed card - with bounds checking */
  readonly currentCard = computed(() => {
    const cards = this.cards();
    const index = Math.min(this.currentCardIndex(), cards.length - 1);
    return cards[Math.max(0, index)];
  });

  /** Determines which action button to show in footer */
  readonly currentAction = computed<OnboardingAction>(() => {
    const card = this.currentCard();

    if (card.key === 'installRclone' && !this.systemHealth.rcloneInstalled()) {
      return 'install-rclone';
    }
    if (card.key === 'installPlugin' && !this.systemHealth.mountPluginInstalled()) {
      return 'install-plugin';
    }
    if (card.key === 'selectConfig') {
      return 'config-next';
    }
    if (card.key === 'passwordRequired') {
      return 'unlock';
    }
    if (card.key === 'ready') {
      return 'finish';
    }
    return 'next';
  });

  /** Whether install rclone button should be enabled */
  readonly canInstall = computed(() => {
    if (this.installing()) return false;
    return this.installationValid();
  });

  /** Dynamic install button text */
  readonly installButtonText = computed(() => {
    const data = this.installationData();

    if (this.installing()) {
      return data.installLocation === 'existing'
        ? 'onboarding.installButton.configuring'
        : 'onboarding.installButton.installing';
    }
    if (data.installLocation === 'custom' && data.customPath.trim().length === 0) {
      return 'onboarding.installButton.selectPath';
    }
    if (data.installLocation === 'existing') {
      if (data.existingBinaryPath.trim().length === 0)
        return 'onboarding.installButton.selectBinary';
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
    this.setupRcloneEngineListener();
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  async ngOnInit(): Promise<void> {
    // Initial delay for entrance animation
    await new Promise(r => setTimeout(r, 500));

    try {
      await this.systemHealth.runAllChecks();
    } catch (error) {
      console.error('OnboardingComponent: System checks failed', error);
    }

    // Show content with animation delay
    setTimeout(() => this.animationState.set('visible'), 300);
  }

  private setupRcloneEngineListener(): void {
    this.eventListenersService
      .listenToRcloneEngineReady()
      .pipe(takeUntilDestroyed())
      .subscribe(() => {
        this.passwordValidationError.set(null);
      });
  }

  // ─── Navigation ─────────────────────────────────────────────────────────────

  @HostListener('document:keydown', ['$event'])
  handleKeyboardEvent(event: KeyboardEvent): void {
    // Handle Enter key based on current action
    if (event.key === 'Enter') {
      const action = this.currentAction();
      switch (action) {
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

    // Arrow keys for simple navigation (only between intro cards)
    if (event.key === 'ArrowRight' && this.currentAction() === 'next') {
      this.nextCard();
    } else if (event.key === 'ArrowLeft' && this.currentCardIndex() > 0) {
      this.previousCard();
    }
  }

  nextCard(): void {
    const maxIndex = this.cards().length - 1;
    if (this.currentCardIndex() < maxIndex) {
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

  trackByIndex(index: number): number {
    return index;
  }

  // ─── Installation ───────────────────────────────────────────────────────────

  async installRclone(): Promise<void> {
    this.installing.set(true);
    try {
      const data = this.installationData();

      if (data.installLocation === 'existing') {
        await this.appSettingsService.saveSetting('core', 'rclone_path', data.existingBinaryPath);
      } else {
        const installPath = data.installLocation === 'default' ? null : data.customPath;
        await this.installationService.installRclone(installPath);
      }

      // Mark as installed - this will automatically remove the Install card
      // from the computed cards array, showing the next card at the same index
      this.systemHealth.markRcloneInstalled();
      // Note: Don't call nextCard() here - the cards array shrink already advances us
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

      // Re-check mount plugin status after installation
      // The backend verifies installation before returning success
      await this.systemHealth.checkMountPlugin();
    } catch (error) {
      console.error('Plugin installation failed:', error);
    } finally {
      this.downloadingPlugin.set(false);
    }
  }

  // ─── Installation Options Callbacks ─────────────────────────────────────────

  onInstallationOptionsChange(data: InstallationOptionsData): void {
    this.installationData.set({ ...data });
  }

  onInstallationValidChange(valid: boolean): void {
    this.installationValid.set(valid);
  }

  // ─── Config Selection ───────────────────────────────────────────────────────

  async onConfigNext(): Promise<void> {
    await this.onConfigPathChanged();
    this.nextCard();
  }

  async onConfigPathChanged(): Promise<void> {
    try {
      if (this.configSelection() === 'custom' && this.customConfigPath()) {
        await this.appSettingsService.saveSetting(
          'core',
          'rclone_config_file',
          this.customConfigPath()
        );
      }

      // Re-check encryption after config change
      await this.systemHealth.checkConfigEncryption();
    } catch (error) {
      console.error('Failed to update config selection:', error);
    }
  }

  onConfigOptionsChange(data: InstallationOptionsData): void {
    if (data.installLocation === 'default') {
      this.configSelection.set('default');
      this.customConfigPath.set('');
    } else if (data.installLocation === 'custom') {
      this.configSelection.set('custom');
      this.customConfigPath.set(data.customPath || '');
    }
    this.onConfigPathChanged().catch(err => console.error(err));
  }

  onConfigValidChange(valid: boolean): void {
    this.configValid.set(valid);
  }

  async pickConfigFile(): Promise<void> {
    try {
      const selected = await this.fileSystemService.selectFile();
      if (selected) {
        this.customConfigPath.set(selected);
        await this.onConfigPathChanged();
      }
    } catch (error) {
      console.error('Failed to pick config file:', error);
    }
  }

  // ─── Password Handling ──────────────────────────────────────────────────────

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
