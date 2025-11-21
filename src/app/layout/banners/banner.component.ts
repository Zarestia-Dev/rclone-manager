import { Component, inject, signal, isDevMode } from '@angular/core';
import { MatToolbarModule } from '@angular/material/toolbar';

// Services
import { AnimationsService } from '../../shared/services/animations.service';
import { EventListenersService } from '@app/services';
import { SystemInfoService } from '@app/services';

@Component({
  selector: 'app-banner',
  templateUrl: './banner.component.html',
  imports: [MatToolbarModule],
  styleUrls: ['./banner.component.scss'],
  animations: [AnimationsService.slideToggle()],
})
export class BannerComponent {
  // --- STATE SIGNALS ---
  readonly isMeteredConnection = signal(false);
  readonly showDevelopmentBanner = signal(isDevMode());

  // --- INJECTED DEPENDENCIES ---
  private readonly eventListenersService = inject(EventListenersService);
  private readonly systemInfoService = inject(SystemInfoService);

  constructor() {
    this.initializeComponent();
  }

  private async initializeComponent(): Promise<void> {
    await this.checkMeteredConnection();
    this.eventListenersService.listenToNetworkStatusChanged().subscribe({
      next: payload => {
        this.isMeteredConnection.set(!!payload?.isMetered);
      },
    });
  }

  private async checkMeteredConnection(): Promise<void> {
    try {
      const isMetered = await this.systemInfoService.isNetworkMetered();
      this.isMeteredConnection.set(!!isMetered);
      console.log('Metered connection status:', this.isMeteredConnection());
    } catch (e) {
      console.error('Failed to check metered connection:', e);
      this.isMeteredConnection.set(false);
    }
  }
}
