import {
  Component,
  EventEmitter,
  Output,
  OnInit,
  OnDestroy,
  HostListener,
  inject,
} from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatRadioModule } from '@angular/material/radio';
import { FormsModule } from '@angular/forms';
import { LoadingOverlayComponent } from '../../shared/components/loading-overlay/loading-overlay.component';
import { InstallationOptionsComponent } from '../../shared/components/installation-options/installation-options.component';
import { Subject } from 'rxjs';
import { takeUntil, take } from 'rxjs/operators';

// Services
import { AnimationsService } from '../../shared/services/animations.service';
import { SystemInfoService } from '@app/services';
import { InstallationService } from '@app/services';
import { EventListenersService } from '@app/services';
import { AppSettingsService } from '@app/services';
import { RclonePasswordService } from '@app/services';
import { FileSystemService } from '@app/services';
import {
  InstallationOptionsData,
  InstallationTabOption,
  RcloneEnginePayload,
  RcloneEngineEvent,
} from '@app/types';

@Component({
  selector: 'app-onboarding',
  standalone: true,
  imports: [
    MatCardModule,
    MatButtonModule,
    MatIconModule,
    MatTooltipModule,
    MatInputModule,
    MatFormFieldModule,
    MatRadioModule,
    FormsModule,
    LoadingOverlayComponent,
    InstallationOptionsComponent,
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
  @Output() completed = new EventEmitter<void>();

  private destroy$ = new Subject<void>();

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

  // Encrypted config state
  configNeedsPassword = false;
  configPassword = '';
  submittingPassword = false;
  passwordError = false;

  // Config file selection state
  configSelectionNeeded = false;
  configFileChoice: 'default' | 'custom' = 'default';
  customConfigPath = '';
  selectingConfigFile = false;

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
  private rclonePasswordService = inject(RclonePasswordService);
  private fileSystemService = inject(FileSystemService);

  onboardingTabOptions: InstallationTabOption[] = [
    { key: 'default', label: 'Recommended', icon: 'star' },
    { key: 'custom', label: 'Custom', icon: 'folder' },
    { key: 'existing', label: 'Existing', icon: 'file' },
  ];

  async ngOnInit(): Promise<void> {
    console.log('OnboardingComponent: ngOnInit started');

    // Setup event listeners for encrypted config detection
    this.setupRcloneEngineListener();

    // Add a small delay for smooth entrance
    setTimeout(async () => {
      console.log('OnboardingComponent: Starting system checks');
      try {
        await this.checkRclone();
        console.log('OnboardingComponent: checkRclone completed');

        await this.checkMountPlugin();
        console.log('OnboardingComponent: checkMountPlugin completed');

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
      } else {
        // RClone is already available, add config selection card
        this.addConfigSelectionCard();
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
      // Listen for installation completion BEFORE starting the installation
      // Use take(1) to ensure we only listen once and automatically unsubscribe
      this.eventListenersService
        .listenToMountPluginInstalled()
        .pipe(
          take(1), // Only take the first event and auto-unsubscribe
          takeUntil(this.destroy$) // Also unsubscribe if component is destroyed
        )
        .subscribe(() => {
          console.log('Mount plugin installation completed successfully');
          this.mountPluginInstalled = true;
          this.downloadingPlugin = false;
          // Move to next card after installation
          this.nextCard();
        });

      const filePath = await this.installationService.installMountPlugin();
      console.log('Downloaded plugin at:', filePath);

      // Note: The event listener above will handle the success case when the backend emits 'mount_plugin_installed'
      // The downloadingPlugin flag will be reset in the subscription or catch block
    } catch (error) {
      console.error('Plugin installation failed:', error);
      this.downloadingPlugin = false;

      // Check if mount plugin is actually installed now (in case the error was just a UI issue)
      try {
        const isInstalled = await this.installationService.isMountPluginInstalled();
        if (isInstalled) {
          console.log('Mount plugin was actually installed despite the error');
          this.mountPluginInstalled = true;
          this.nextCard();
        }
      } catch (checkError) {
        console.error('Failed to check mount plugin status after installation error:', checkError);
      }
    }
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  async installRclone(): Promise<void> {
    this.installing = true;
    try {
      if (this.installationData.installLocation === 'existing') {
        // For existing binary, just save the path to settings
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

      // Add config selection card after rclone installation
      this.addConfigSelectionCard();

      // Move to next card after installation - but check for encrypted config first
      // The engine restart will trigger password detection if needed
      this.nextCard();
    } catch (error) {
      console.error('RClone installation/configuration failed:', error);
    } finally {
      this.installing = false;
    }
  }

  private setupRcloneEngineListener(): void {
    this.eventListenersService
      .listenToRcloneEngine()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: async (event: RcloneEnginePayload) => {
          try {
            console.log('Onboarding: Rclone engine event received:', event);

            if (typeof event === 'object' && event !== null) {
              await this.handleRcloneEngineEvent(event);
            }
          } catch (error) {
            console.error('Error in onboarding Rclone engine event handler:', error);
          }
        },
        error: error => console.error('Onboarding: Rclone engine event subscription error:', error),
      });
  }

  private async handleRcloneEngineEvent(event: RcloneEngineEvent): Promise<void> {
    switch (event.status) {
      case 'password_error':
        console.log('🔑 Password required detected during onboarding');
        this.handlePasswordRequired();
        break;
      case 'ready':
        console.log('Rclone API ready during onboarding');
        this.handleRcloneReady();
        break;
      default:
        // Log unknown events for debugging
        if (event.status) {
          console.log(`Onboarding: Unhandled Rclone event status: ${event.status}`);
        }
        break;
    }
  }

  private handlePasswordRequired(): void {
    if (this.configNeedsPassword) {
      return; // Already handling password
    }

    console.log('Adding encrypted config password card to onboarding');
    this.configNeedsPassword = true;

    // Insert password card before the final card, but only if it doesn't already exist
    const passwordCardExists = this.cards.some(card => card.title === 'Configuration Password');
    if (!passwordCardExists) {
      const finalCardIndex = this.cards.findIndex(card => card.title === 'Ready to Go!');
      if (finalCardIndex !== -1) {
        this.cards.splice(finalCardIndex, 0, {
          image: '../assets/rclone.svg',
          title: 'Configuration Password',
          content:
            'Your RClone configuration is encrypted and requires a password to access your cloud remotes. Please enter your configuration password to continue.',
        });
      }
    }
  }

  private handleRcloneReady(): void {
    this.passwordError = false;
    // If we were on the password card and rclone is ready, move to next card
    if (
      this.configNeedsPassword &&
      this.cards[this.currentCardIndex]?.title === 'Configuration Password'
    ) {
      this.nextCard();
    }
  }

  async submitConfigPassword(): Promise<void> {
    if (!this.configPassword.trim()) {
      return;
    }

    this.submittingPassword = true;
    this.passwordError = false;

    try {
      // Store the password persistently in the credential store AND set it in memory
      await this.rclonePasswordService.storePassword(this.configPassword);
      console.log(
        'Config password stored successfully during onboarding (both memory and keyring)'
      );

      // Wait a moment for the engine to restart and verify the password
      setTimeout(() => {
        // If still on password card after a delay, the password might be wrong
        if (this.cards[this.currentCardIndex]?.title === 'Configuration Password') {
          this.passwordError = true;
        }
        this.submittingPassword = false;
      }, 2000);
    } catch (error) {
      console.error('Error setting config password during onboarding:', error);
      this.passwordError = true;
      this.submittingPassword = false;
    }
  } // Add these methods to your component class
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

  shouldShowConfigPasswordButton(): boolean {
    return (
      this.currentCardIndex === this.cards.findIndex(c => c.title === 'Configuration Password') &&
      this.configNeedsPassword
    );
  }

  shouldShowConfigSelectionButton(): boolean {
    return (
      this.currentCardIndex === this.cards.findIndex(c => c.title === 'Configuration Setup') &&
      this.configSelectionNeeded
    );
  }

  shouldShowActionButton(): boolean {
    return (
      this.shouldShowInstallRcloneButton() ||
      this.shouldShowInstallPluginButton() ||
      this.shouldShowConfigSelectionButton() ||
      this.shouldShowConfigPasswordButton() ||
      this.cards[this.currentCardIndex].title === 'Ready to Go!'
    );
  }

  // Add validation for custom path installation
  canInstallRclone(): boolean {
    if (this.installing) {
      return false;
    }

    // Use the installation validity from shared component
    return this.installationValid;
  }

  // Get dynamic button text based on validation state
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

  canApplyConfigSelection(): boolean {
    if (this.configFileChoice === 'default') {
      return true;
    }
    return this.configFileChoice === 'custom' && this.customConfigPath.trim().length > 0;
  }

  getConfigButtonText(): string {
    if (this.configFileChoice === 'custom' && !this.customConfigPath) {
      return 'Select Config File First';
    }
    return 'Continue';
  }

  onInstallationOptionsChange(data: InstallationOptionsData): void {
    this.installationData = { ...data };
  }

  onInstallationValidChange(valid: boolean): void {
    this.installationValid = valid;
  }

  completeOnboarding(): void {
    this.completed.emit();
  }

  private addConfigSelectionCard(): void {
    // Only add if config selection card doesn't exist
    const configCardExists = this.cards.some(card => card.title === 'Configuration Setup');
    if (!configCardExists) {
      console.log('Adding config selection card to onboarding');
      this.configSelectionNeeded = true;

      // Insert config selection card before password and final cards
      const passwordCardIndex = this.cards.findIndex(
        card => card.title === 'Configuration Password'
      );
      const finalCardIndex = this.cards.findIndex(card => card.title === 'Ready to Go!');

      const insertIndex =
        passwordCardIndex !== -1
          ? passwordCardIndex
          : finalCardIndex !== -1
            ? finalCardIndex
            : this.cards.length;

      this.cards.splice(insertIndex, 0, {
        image: '../assets/rclone.svg',
        title: 'Configuration Setup',
        content:
          'Choose your RClone configuration location. You can use the default location or select an existing configuration file with your cloud remotes.',
      });
    }
  }

  async selectConfigFile(): Promise<void> {
    if (this.selectingConfigFile) return;

    this.selectingConfigFile = true;
    try {
      const filePath = await this.fileSystemService.selectFile();
      if (filePath) {
        this.customConfigPath = filePath;
        console.log('Selected config file:', filePath);
      }
    } catch (error) {
      console.error('Error selecting config file:', error);
    } finally {
      this.selectingConfigFile = false;
    }
  }

  async applyConfigSelection(): Promise<void> {
    try {
      if (this.configFileChoice === 'custom' && this.customConfigPath) {
        // Save the custom config path to settings
        await this.appSettingsService.saveSetting(
          'core',
          'rclone_config_file',
          this.customConfigPath
        );
        console.log('Applied custom config path:', this.customConfigPath);
      } else {
        // Clear any custom config path (use default)
        await this.appSettingsService.saveSetting('core', 'rclone_config_file', '');
        console.log('Using default config location');
      }

      // Move to next card and trigger config validation
      // This will check if the config is encrypted and add password card if needed
      this.nextCard();
    } catch (error) {
      console.error('Error applying config selection:', error);
    }
  }
}
