import {
  Component,
  EventEmitter,
  Output,
  OnInit,
  HostListener,
  inject,
  OnDestroy,
  signal,
  computed,
} from '@angular/core';
import { Subscription } from 'rxjs';
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
  ],
  templateUrl: './onboarding.component.html',
  styleUrls: ['./onboarding.component.scss'],
})
export class OnboardingComponent implements OnInit, OnDestroy {
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

  private rcloneEngineSub: Subscription | null = null;

  // ─── Computed Values ────────────────────────────────────────────────────────

  /** Base cards that are always shown */
  private readonly baseCards: OnboardingCard[] = [
    {
      image: '../assets/rclone.svg',
      title: 'Welcome to RClone Manager',
      content:
        'Your modern cloud storage management solution. RClone Manager provides an intuitive interface to sync, mount, and manage all your cloud remotes effortlessly.',
    },
    {
      image: '../assets/rclone.svg',
      title: 'Powerful Features',
      content:
        'Seamlessly sync files, mount cloud storage as local drives, manage multiple remotes, and monitor transfer operations - all from one beautiful interface.',
    },
  ];

  /** Dynamically computed cards based on system health state */
  readonly cards = computed<OnboardingCard[]>(() => {
    const result: OnboardingCard[] = [...this.baseCards];

    // Only add installation cards when we KNOW they're not installed (false)
    // Don't add when still checking (null)
    if (this.systemHealth.rcloneInstalled() === false) {
      result.push({
        image: '../assets/rclone.svg',
        title: 'Install RClone',
        content:
          "RClone is required for cloud storage operations. Choose your preferred installation location or binary location and we'll handle the setup automatically.",
      });
    }

    // Add mount plugin card only if explicitly not installed
    if (this.systemHealth.mountPluginInstalled() === false) {
      result.push({
        image: '../assets/rclone.svg',
        title: 'Install Mount Plugin',
        content:
          'The mount plugin enables you to mount cloud storage as local drives. This optional component enhances your RClone experience.',
      });
    }

    // Always add config selection card
    result.push({
      image: '../assets/rclone.svg',
      title: 'Select RClone Config',
      content:
        'Choose the RClone configuration file to use: the default location or a custom configuration file.',
    });

    // Add password card if config is encrypted and not unlocked
    if (this.systemHealth.passwordRequired()) {
      result.push({
        image: '../assets/rclone.svg',
        title: 'Configuration Password Required',
        content:
          'Your rclone configuration is encrypted. Please enter the password to unlock it for this session.',
      });
    }

    // Always end with ready card
    result.push({
      image: '../assets/rclone.svg',
      title: 'Ready to Go!',
      content:
        "Everything is set up and ready to use. RClone Manager will help you manage your cloud storage with ease. Click 'Get Started' to begin your journey.",
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

    if (card.title === 'Install RClone' && !this.systemHealth.rcloneInstalled()) {
      return 'install-rclone';
    }
    if (card.title === 'Install Mount Plugin' && !this.systemHealth.mountPluginInstalled()) {
      return 'install-plugin';
    }
    if (card.title === 'Select RClone Config') {
      return 'config-next';
    }
    if (card.title === 'Configuration Password Required') {
      return 'unlock';
    }
    if (card.title === 'Ready to Go!') {
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
      return data.installLocation === 'existing' ? 'Configuring...' : 'Installing...';
    }
    if (data.installLocation === 'custom' && data.customPath.trim().length === 0) {
      return 'Select Path First';
    }
    if (data.installLocation === 'existing') {
      if (data.existingBinaryPath.trim().length === 0) return 'Select Binary First';
      if (data.binaryTestResult === 'invalid') return 'Invalid Binary';
      if (data.binaryTestResult === 'testing') return 'Testing Binary...';
      if (data.binaryTestResult === 'valid') return 'Use This Binary';
      return 'Test Binary First';
    }
    return 'Install RClone';
  });

  // ─── Tab Options ────────────────────────────────────────────────────────────

  readonly onboardingTabOptions: InstallationTabOption[] = [
    { key: 'default', label: 'Recommended', icon: 'star' },
    { key: 'custom', label: 'Custom', icon: 'folder' },
    { key: 'existing', label: 'Existing', icon: 'file' },
  ];

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  async ngOnInit(): Promise<void> {
    // Initial delay for entrance animation
    await new Promise(r => setTimeout(r, 500));

    try {
      await this.systemHealth.runAllChecks();

      // Subscribe to engine events for password handling
      this.rcloneEngineSub = this.eventListenersService
        .listenToRcloneEngineReady()
        .subscribe(() => {
          this.passwordValidationError.set(null);
        });
    } catch (error) {
      console.error('OnboardingComponent: System checks failed', error);
    }

    // Show content with animation delay
    setTimeout(() => this.animationState.set('visible'), 300);
  }

  ngOnDestroy(): void {
    this.rcloneEngineSub?.unsubscribe();
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

      this.eventListenersService.listenToMountPluginInstalled().subscribe(() => {
        // Mark as installed - this will automatically remove the Install card
        // from the computed cards array, showing the next card at the same index
        this.systemHealth.markMountPluginInstalled();
        // Note: Don't call nextCard() here - the cards array shrink already advances us
      });
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
      this.passwordValidationError.set('Wrong password. Please try again.');
    } finally {
      this.isSubmittingPassword.set(false);
    }
  }
}
