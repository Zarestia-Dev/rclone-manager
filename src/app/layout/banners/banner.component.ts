import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  inject,
  isDevMode,
  OnDestroy,
  OnInit,
} from '@angular/core';
import { MatToolbarModule } from '@angular/material/toolbar';
import { invoke } from '@tauri-apps/api/core';
import { listen, Event } from '@tauri-apps/api/event';
interface NetworkStatusPayload {
  isMetered: boolean;
}
import { Subject } from 'rxjs';
import { AnimationsService } from '../../services/core/animations.service';

@Component({
  selector: 'app-banner',
  templateUrl: './banner.component.html',
  imports: [MatToolbarModule],
  styleUrls: ['./banner.component.scss'],
  animations: [AnimationsService.slideToggle()],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BannerComponent implements OnInit, OnDestroy {
  isMeteredConnection = false;
  showDevelopmentBanner = isDevMode();
  private cdr = inject(ChangeDetectorRef);
  private destroy$ = new Subject<void>();
  private unlistenNetworkStatus: (() => void) | null = null;

  async ngOnInit(): Promise<void> {
    await this.checkMeteredConnection();
    await this.listenForNetworkStatus();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    if (this.unlistenNetworkStatus) {
      this.unlistenNetworkStatus();
      this.unlistenNetworkStatus = null;
    }
  }

  private async checkMeteredConnection(): Promise<void> {
    try {
      const isMetered = await invoke('is_network_metered');
      this.isMeteredConnection = !!isMetered;
      console.log('Metered connection status:', this.isMeteredConnection);
      this.cdr.markForCheck();
    } catch (e) {
      console.error('Failed to check metered connection:', e);
      this.isMeteredConnection = false;
    }
  }

  private async listenForNetworkStatus(): Promise<void> {
    this.unlistenNetworkStatus = await listen<NetworkStatusPayload>(
      'network-status-changed',
      (event: Event<NetworkStatusPayload>) => {
        const isMetered = event.payload?.isMetered;
        this.isMeteredConnection = !!isMetered;
        this.cdr.markForCheck();
      }
    );
  }
}
