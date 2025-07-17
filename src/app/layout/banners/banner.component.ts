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
import { EventListenersService } from '../../services/system/event-listeners.service';
import { SystemInfoService } from '../../services/system/system-info.service';
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
  private eventListenersService = inject(EventListenersService);

  async ngOnInit(): Promise<void> {
    await this.checkMeteredConnection();
    this.eventListenersService.listenToNetworkStatusChanged().subscribe({
      next: payload => {
        this.isMeteredConnection = !!payload?.isMetered;
        this.cdr.markForCheck();
      },
    });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  private systemInfoService = inject(SystemInfoService);

  private async checkMeteredConnection(): Promise<void> {
    try {
      const isMetered = await this.systemInfoService.isNetworkMetered();
      this.isMeteredConnection = !!isMetered;
      console.log('Metered connection status:', this.isMeteredConnection);
      this.cdr.markForCheck();
    } catch (e) {
      console.error('Failed to check metered connection:', e);
      this.isMeteredConnection = false;
    }
  }
}
