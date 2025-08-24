import { Component, EventEmitter, Output, OnInit, HostListener, inject } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { LoadingOverlayComponent } from '../../shared/components/loading-overlay/loading-overlay.component';
import { InstallationOptionsComponent } from '../../shared/components/installation-options/installation-options.component';

// Services
import { AnimationsService } from '../../shared/services/animations.service';
import { SystemInfoService } from '@app/services';
import { InstallationService } from '@app/services';
import { EventListenersService } from '@app/services';
import { AppSettingsService } from '@app/services';
import { InstallationOptionsData, InstallationTabOption } from '@app/types';

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
export class OnboardingComponent implements OnInit {
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

  onboardingTabOptions: InstallationTabOption[] = [
    { key: 'default', label: 'Recommended', icon: 'star' },
    { key: 'custom', label: 'Custom', icon: 'folder' },
    { key: 'existing', label: 'Existing', icon: 'file' },
  ];

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

  // Add these methods to your component class
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

  onInstallationOptionsChange(data: InstallationOptionsData): void {
    this.installationData = { ...data };
  }

  onInstallationValidChange(valid: boolean): void {
    this.installationValid = valid;
  }

  completeOnboarding(): void {
    this.completed.emit();
  }
}
