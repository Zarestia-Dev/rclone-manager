import {
  Component,
  EventEmitter,
  Output,
  OnInit,
  HostListener,
  inject,
  OnDestroy,
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
import { AnimationsService } from '../../shared/services/animations.service';
import { SystemInfoService } from '@app/services';
import { InstallationService } from '@app/services';
import { EventListenersService } from '@app/services';
import { AppSettingsService } from '@app/services';
import { FileSystemService } from '@app/services';
import { RclonePasswordService } from '@app/services';
import { InstallationOptionsData, InstallationTabOption, PasswordLockoutStatus } from '@app/types';

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
  animations: [
    AnimationsService.getAnimations([
      'onboardingEntrance',
      'contentFadeIn',
      'loadingSpinner',
      'slideInOut',
    ]),
  ],
  templateUrl: './onboarding.component.html',
  styleUrls: ['./onboarding.component.scss'],
})
export class OnboardingComponent implements OnInit, OnDestroy {
  // Track lockout status for password attempts
  lockoutStatus: PasswordLockoutStatus | null = null;
  @Output() completed = new EventEmitter<void>();

  // Installation options data from shared component
  installationData: InstallationOptionsData = {
    installLocation: 'default',
    customPath: '',
    existingBinaryPath: '',
    binaryTestResult: 'untested',
  };
  installationValid = true;

  mountPluginInstalled = false;
  downloadingPlugin = false;
  currentCardIndex = 0;
  rcloneInstalled = false;
  installing = false;

  // Add initialization state
  isInitializing = true;
  initializationComplete = false;

  // Base cards that are always shown
  private baseCards = [
    {
      image: 'rclone',
      title: 'Welcome to RClone Manager',
      content:
        'Your modern cloud storage management solution. RClone Manager provides an intuitive interface to sync, mount, and manage all your cloud remotes effortlessly.',
    },
    {
      image: 'rclone',
      title: 'Powerful Features',
      content:
        'Seamlessly sync files, mount cloud storage as local drives, manage multiple remotes, and monitor transfer operations - all from one beautiful interface.',
    },
  ];

  // Dynamic cards that will be added based on conditions
  cards = [...this.baseCards];

  // Inject services using inject() function
  private systemInfoService = inject(SystemInfoService);
  private installationService = inject(InstallationService);
  private appSettingsService = inject(AppSettingsService);
  private eventListenersService = inject(EventListenersService);
  private fileSystemService = inject(FileSystemService);
  private rclonePasswordService = inject(RclonePasswordService);

  // New: rclone config selection and password handling
  configSelection: 'default' | 'custom' = 'default';
  customConfigPath = '';
  configEncrypted: boolean | null = null; // null = unknown
  configPassword = '';
  // validity of the config selector (emitted by installation-options when reused)
  configValid = true;
  // If an attempted password validation failed, show message
  passwordValidationError: string | null = null;
  isSubmittingPassword = false;

  // Only process password_error events when we actually expect a password UI
  private expectingPassword = false;

  // When we change rclone/config paths we may trigger engine restarts; while
  // waiting for the engine to start we should ignore password_error spam.
  private waitingForEngineStart = false;

  private rcloneEngineSub: Subscription | null = null;

  onboardingTabOptions: InstallationTabOption[] = [
    { key: 'default', label: 'Recommended', icon: 'star' },
    { key: 'custom', label: 'Custom', icon: 'folder' },
    { key: 'existing', label: 'Existing', icon: 'file' },
  ];

  // trackBy for ngFor
  trackByIndex(index: number): number {
    return index;
  }

  async ngOnInit(): Promise<void> {
    console.log('OnboardingComponent: ngOnInit started');

    // Add a small delay for smooth entrance
    setTimeout(async () => {
      console.log('OnboardingComponent: Starting system checks');
      try {
        await this.checkRclone();
        console.log('OnboardingComponent: checkRclone completed');

        await this.checkMountPlugin();
        console.log('OnboardingComponent: checkMountPlugin completed');

        // Fetch initial lockout status (in case onboarding starts locked)
        this.lockoutStatus = await this.rclonePasswordService.getLockoutStatus();

        // Subscribe to engine events so we can react to password errors
        this.rcloneEngineSub = this.eventListenersService
          .listenToRcloneEngine()
          .subscribe(payload => {
            try {
              // payload can be a string or an object; guard accordingly
              if (typeof payload !== 'string' && 'status' in (payload || {})) {
                const ev = payload as { status?: string };
                // If engine not yet started due to a recent path/config change,
                // ignore password_error spam until we see a ready event.
                if (ev.status === 'password_error') {
                  if (this.waitingForEngineStart) {
                    console.debug('Ignoring password_error while waiting for engine start');
                    return;
                  }

                  // Only react to password errors when we actually expect a password
                  // (for example, user selected an encrypted config). This avoids
                  // spamming the UI when other parts of the app emit password errors.
                  if (
                    !this.expectingPassword &&
                    !this.cards.some(c => c.title === 'Configuration Password Required')
                  ) {
                    console.debug(
                      'Ignoring unsolicited password_error (no password card expected)'
                    );
                    return;
                  }

                  // Ensure password card present and surface to user
                  this.configEncrypted = true;
                  this.ensurePasswordCardPresent();

                  // Fetch and update lockout status on password error
                  this.updateLockoutStatus();
                }

                if (ev.status === 'ready') {
                  // Engine is healthy: stop waiting and clear transient errors
                  this.waitingForEngineStart = false;
                  this.passwordValidationError = null;

                  // If we were expecting a password (for example after saving config)
                  // ensure the password card is present so user can unlock.
                  if (this.expectingPassword) {
                    this.ensurePasswordCardPresent();
                  }

                  // Fetch and update lockout status on engine ready (may have unlocked)
                  this.updateLockoutStatus();
                }
              }
            } catch (err) {
              console.error('Error handling rclone engine event:', err);
            }
          });

        // Mark initialization as complete
        this.isInitializing = false;

        // Add another small delay for the initialization complete animation
        setTimeout(() => {
          this.initializationComplete = true;
          console.log('OnboardingComponent: Initialization complete');
        }, 300);
      } catch (error) {
        console.error('OnboardingComponent: System checks failed', error);
        this.isInitializing = false;
        this.initializationComplete = true;
      }
    }, 500); // Initial delay for app to settle
  }

  // When config path changes we should clear cached encryption state
  async onConfigPathChanged(): Promise<void> {
    try {
      // Save selection temporarily to settings
      await this.appSettingsService.saveSetting(
        'core',
        'rclone_config_source',
        this.configSelection
      );
      if (this.configSelection === 'custom' && this.customConfigPath) {
        await this.appSettingsService.saveSetting(
          'core',
          'rclone_config_file',
          this.customConfigPath
        );
      }

      // If changing config path we may trigger an engine restart; mark that
      // we're waiting for the engine so we can ignore spammy password_error
      // events until the engine reports ready.
      this.waitingForEngineStart = true;

      // We expect a password only if the config is encrypted; set expecting
      // true early so engine events emitted during restart will be gated.
      this.expectingPassword = true;

      // Clear encryption cache and check if encrypted
      await this.rclonePasswordService.clearEncryptionCache();
      const encrypted = await this.rclonePasswordService.isConfigEncryptedCached();
      this.configEncrypted = !!encrypted;

      if (this.configEncrypted) {
        // If the config is encrypted, try to use stored password automatically
        try {
          const stored = await this.rclonePasswordService.getStoredPassword();
          if (stored) {
            try {
              await this.rclonePasswordService.validatePassword(stored);
              await this.rclonePasswordService.setConfigPasswordEnv(stored);
              this.passwordValidationError = null;
              // Remove any password card since we've unlocked with stored password
              const pwdTitle = 'Configuration Password Required';
              const existingIdx = this.cards.findIndex(c => c.title === pwdTitle);
              if (existingIdx !== -1) {
                this.cards.splice(existingIdx, 1);
              }
              // Successfully unlocked; we're no longer expecting a password
              this.expectingPassword = false;
              this.waitingForEngineStart = false;
              return;
            } catch {
              console.debug('Stored password failed validation, will prompt user');
              this.passwordValidationError = 'Stored password invalid';
            }
          }
        } catch {
          console.debug('Error checking stored password');
        }
      }

      // If encrypted (and auto-unlock didn't succeed), insert password card
      this.ensurePasswordCardPresent();
      // Still waiting for engine; the engine will emit a ready/password_error
      // that we will handle above once it's available.
    } catch (error) {
      console.error('Failed to update config selection:', error);
      this.configEncrypted = null;
    }
  }

  private ensurePasswordCardPresent(): void {
    const pwdTitle = 'Configuration Password Required';
    const existingIdx = this.cards.findIndex(c => c.title === pwdTitle);
    if (this.configEncrypted) {
      if (existingIdx === -1) {
        // insert before the final 'Ready to Go!' card
        const insertPos = Math.max(this.cards.length - 1, 0);
        this.cards.splice(insertPos, 0, {
          image: '../assets/rclone.svg',
          title: pwdTitle,
          content:
            'Your rclone configuration is encrypted. Please enter the password to unlock it for this session.',
        });
      }
    } else {
      if (existingIdx !== -1) {
        this.cards.splice(existingIdx, 1);
      }
    }
  }

  // Called from template to save config selection then advance
  async onConfigNext(): Promise<void> {
    await this.onConfigPathChanged();
    this.nextCard();
  }

  @HostListener('document:keydown', ['$event'])
  handleKeyboardEvent(event: KeyboardEvent): void {
    if (event.key === 'ArrowRight' || event.key === 'Enter') {
      if (this.currentCardIndex < this.cards.length - 1) {
        this.nextCard();
      } else {
        this.completeOnboarding();
      }
    } else if (event.key === 'ArrowLeft') {
      if (this.currentCardIndex > 0) {
        this.previousCard();
      }
    }
  }

  async checkRclone(): Promise<void> {
    try {
      this.rcloneInstalled = await this.systemInfoService.isRcloneAvailable();
      if (!this.rcloneInstalled) {
        this.cards.splice(3, 0, {
          image: '../assets/rclone.svg',
          title: 'Install RClone',
          content:
            "RClone is required for cloud storage operations. Choose your preferred installation location or binary location and we'll handle the setup automatically.",
        });
      }
    } catch (error) {
      console.error('Error checking rclone:', error);
      this.rcloneInstalled = false;
    }
  }

  async checkMountPlugin(): Promise<void> {
    try {
      this.mountPluginInstalled = await this.installationService.isMountPluginInstalled();
      if (!this.mountPluginInstalled) {
        // Add after install rclone card if it exists, otherwise at position 3
        const insertPosition = this.cards.length > 3 ? 4 : 3;
        this.cards.splice(insertPosition, 0, {
          image: '../assets/rclone.svg',
          title: 'Install Mount Plugin',
          content:
            'The mount plugin enables you to mount cloud storage as local drives. This optional component enhances your RClone experience.',
        });
      }
    } catch (error) {
      console.error('Error checking mount plugin:', error);
      this.mountPluginInstalled = false;
    }

    // Always add setup complete as the last card
    if (!this.cards.some(card => card.title === 'Setup Complete')) {
      this.cards.push({
        image: '../assets/rclone.svg',
        title: 'Ready to Go!',
        content:
          "Everything is set up and ready to use. RClone Manager will help you manage your cloud storage with ease. Click 'Get Started' to begin your journey.",
      });
    }

    // Ensure config selection card exists before final ready card
    if (!this.cards.some(card => card.title === 'Select RClone Config')) {
      const insertPos = Math.max(this.cards.length - 1, 0);
      this.cards.splice(insertPos, 0, {
        image: '../assets/rclone.svg',
        title: 'Select RClone Config',
        content:
          'Choose the RClone configuration file to use: the default location or a custom file path.',
      });
    }
  }

  nextCard(): void {
    setTimeout(() => {
      if (this.currentCardIndex < this.cards.length - 1) {
        this.currentCardIndex++;
      }
    });
  }

  previousCard(): void {
    setTimeout(() => {
      if (this.currentCardIndex > 0) {
        this.currentCardIndex--;
      }
    });
  }

  async installMountPlugin(): Promise<void> {
    this.downloadingPlugin = true;
    try {
      const filePath = await this.installationService.installMountPlugin();
      console.log('Downloaded plugin at:', filePath);

      // Listen for installation completion
      this.eventListenersService.listenToMountPluginInstalled().subscribe(() => {
        this.mountPluginInstalled = true;
        // Optionally move to next card after installation
        this.nextCard();
      });
    } catch (error) {
      console.error('Plugin installation failed:', error);
    } finally {
      this.downloadingPlugin = false;
    }
  }

  async installRclone(): Promise<void> {
    this.installing = true;
    try {
      if (this.installationData.installLocation === 'existing') {
        // For existing binary, just save the path to settings
        // We're about to change rclone path which will trigger an engine restart;
        // mark that we're waiting for the engine and may expect password events.
        this.waitingForEngineStart = true;
        this.expectingPassword = true;

        await this.appSettingsService.saveSetting(
          'core',
          'rclone_path',
          this.installationData.existingBinaryPath
        );
        console.log('Configured rclone path:', this.installationData.existingBinaryPath);
      } else {
        // Regular installation
        const installPath =
          this.installationData.installLocation === 'default'
            ? null
            : this.installationData.customPath;
        const result = await this.installationService.installRclone(installPath);
        console.log('Installation result:', result);
      }

      this.rcloneInstalled = true;
      // Move to next card after installation
      this.nextCard();
    } catch (error) {
      console.error('RClone installation/configuration failed:', error);
    } finally {
      this.installing = false;
    }
  }

  // New: pick rclone config file
  async pickConfigFile(): Promise<void> {
    try {
      // Selecting a new config file will cause the engine to restart; mark waiting
      this.waitingForEngineStart = true;
      this.expectingPassword = true;

      const selected = await this.fileSystemService.selectFile();
      if (selected) {
        this.customConfigPath = selected;
        await this.onConfigPathChanged();
      }
    } catch (error) {
      console.error('Failed to pick config file:', error);
    }
  }

  // Submit config password
  async submitConfigPassword(): Promise<void> {
    if (!this.configPassword || this.isSubmittingPassword) return;

    this.isSubmittingPassword = true;
    try {
      // Try validate; if successful, set env var for session
      await this.rclonePasswordService.validatePassword(this.configPassword);
      await this.rclonePasswordService.setConfigPasswordEnv(this.configPassword);
      // Optionally store password securely
      await this.rclonePasswordService.storePassword(this.configPassword);

      // Move to next card
      // Clear expectation since password provided
      this.expectingPassword = false;
      this.waitingForEngineStart = false;
      // Update lockout status (should be reset on success)
      await this.updateLockoutStatus();
      this.passwordValidationError = null;
      this.nextCard();
    } catch (error) {
      console.error('Password validation failed:', error);
      // Update lockout status (may be locked or attempts incremented)
      await this.updateLockoutStatus();
      // Show error message on top
      this.passwordValidationError = 'Wrong password. Please try again.';
      // Keep user on the same card for retry
    } finally {
      this.isSubmittingPassword = false;
    }
  }

  // Helper to update lockout status from service
  private async updateLockoutStatus(): Promise<void> {
    this.lockoutStatus = await this.rclonePasswordService.getLockoutStatus();
  }

  shouldShowInstallRcloneButton(): boolean {
    return (
      this.currentCardIndex === this.cards.findIndex(c => c.title === 'Install RClone') &&
      !this.rcloneInstalled
    );
  }

  shouldShowInstallPluginButton(): boolean {
    return (
      this.currentCardIndex === this.cards.findIndex(c => c.title === 'Install Mount Plugin') &&
      this.mountPluginInstalled === false
    );
  }

  shouldShowActionButton(): boolean {
    return (
      this.shouldShowInstallRcloneButton() ||
      this.shouldShowInstallPluginButton() ||
      this.cards[this.currentCardIndex].title === 'Ready to Go!'
    );
  }

  canInstallRclone(): boolean {
    if (this.installing) {
      return false;
    }
    return this.installationValid;
  }

  getInstallButtonText(): string {
    if (this.installing) {
      return this.installationData.installLocation === 'existing'
        ? 'Configuring...'
        : 'Installing...';
    }
    if (this.installationData.installLocation === 'custom') {
      if (this.installationData.customPath.trim().length === 0) {
        return 'Select Path First';
      }
    }
    if (this.installationData.installLocation === 'existing') {
      if (this.installationData.existingBinaryPath.trim().length === 0) {
        return 'Select Binary First';
      }
      if (this.installationData.binaryTestResult === 'invalid') {
        return 'Invalid Binary';
      }
      if (this.installationData.binaryTestResult === 'testing') {
        return 'Testing Binary...';
      }
      if (this.installationData.binaryTestResult === 'valid') {
        return 'Use This Binary';
      }
      return 'Test Binary First';
    }
    return 'Install RClone';
  }

  onInstallationOptionsChange(data: InstallationOptionsData): void {
    this.installationData = { ...data };
  }

  onInstallationValidChange(valid: boolean): void {
    this.installationValid = valid;
  }

  onConfigOptionsChange(data: InstallationOptionsData): void {
    if (data.installLocation === 'default') {
      this.configSelection = 'default';
      this.customConfigPath = '';
    } else if (data.installLocation === 'custom') {
      this.configSelection = 'custom';
      this.customConfigPath = data.customPath || '';
    }
    this.onConfigPathChanged().catch(err => console.error(err));
  }

  onConfigValidChange(valid: boolean): void {
    this.configValid = valid;
  }

  ngOnDestroy(): void {
    try {
      this.rcloneEngineSub?.unsubscribe();
    } catch (e) {
      console.error('Error during OnboardingComponent destroy:', e);
    }
  }

  completeOnboarding(): void {
    this.completed.emit();
  }
}
