import { Component, EventEmitter, Output, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { trigger, transition, style, animate, state } from '@angular/animations';
import { RcloneService } from '../../../services/rclone.service';
import { BandwidthLimitResponse, MemoryStats, CoreStats } from '../../../shared/components/types';
import { Subject, interval } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { SettingsService } from '../../../services/settings.service';

interface SystemStats {
  rcloneStatus: 'active' | 'inactive' | 'error';
  activeConnections: number;
  backgroundTasks: number;
  dataTransferred: string;
  totalRemotes: number;
  activeJobs: number;
  memoryUsage: string;
  uptime: string;
}

@Component({
  selector: 'app-general-overview',
  standalone: true,
  imports: [
    CommonModule,
    MatCardModule,
    MatIconModule,
    MatButtonModule,
    MatTooltipModule,
    MatProgressSpinnerModule
  ],
  templateUrl: './general-overview.component.html',
  styleUrl: './general-overview.component.scss',
  animations: [
    trigger('slideToggle', [
      state('visible', style({
        opacity: 1,
        transform: 'translateY(0)',
        height: '*'
      })),
      state('hidden', style({
        opacity: 0,
        transform: 'translateY(-20px)',
        height: '0px',
        overflow: 'hidden'
      })),
      transition('visible <=> hidden', [
        animate('300ms cubic-bezier(0.25, 0.46, 0.45, 0.94)')
      ])
    ]),
    trigger('fadeInOut', [
      transition(':enter', [
        style({ opacity: 0, transform: 'translateY(10px)' }),
        animate('300ms ease-out', style({ opacity: 1, transform: 'translateY(0)' }))
      ]),
      transition(':leave', [
        animate('200ms ease-in', style({ opacity: 0, transform: 'translateY(-10px)' }))
      ])
    ])
  ]
})
export class GeneralOverviewComponent implements OnInit, OnDestroy {
  @Output() openQuickAddRemoteModal = new EventEmitter<void>();

  bandwidthLimit: BandwidthLimitResponse | null = null;
  isLoadingBandwidth = false;
  bandwidthError: string | null = null;
  
  // Enhanced system monitoring
  systemStats: SystemStats = {
    rcloneStatus: 'inactive',
    activeConnections: 0,
    backgroundTasks: 0,
    dataTransferred: '0 B',
    totalRemotes: 0,
    activeJobs: 0,
    memoryUsage: '0 MB',
    uptime: '0s'
  };
  isLoadingStats = false;
  
  private destroy$ = new Subject<void>();

  constructor(
    private settingsService: SettingsService,
    private rcloneService: RcloneService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.loadBandwidthLimit();
    this.loadSystemStats();
    
    // Refresh data every 30 seconds for bandwidth, every 5 seconds for system stats
    const bandwidthRefresh$ = interval(30000);
    const statsRefresh$ = interval(5000);
    
    bandwidthRefresh$
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => this.loadBandwidthLimit());
      
    statsRefresh$
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => this.loadSystemStats());
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  async loadBandwidthLimit(): Promise<void> {
    this.isLoadingBandwidth = true;
    this.bandwidthError = null;
    
    try {
      this.bandwidthLimit = await this.rcloneService.getBandwidthLimit() as BandwidthLimitResponse;
      // Reset error state on successful load
      this.bandwidthError = null;
    } catch (error) {
      this.bandwidthError = 'Failed to load bandwidth limit';
      console.error('Error loading bandwidth limit:', error);
      
      // Retry after a delay if this is the first load
      if (!this.bandwidthLimit) {
        setTimeout(() => {
          if (this.bandwidthError) {
            this.loadBandwidthLimit();
          }
        }, 5000);
      }
    } finally {
      this.isLoadingBandwidth = false;
      this.cdr.markForCheck();
    }
  }

  async loadSystemStats(): Promise<void> {
    if (this.isLoadingStats) return;
    
    this.isLoadingStats = true;
    
    try {
      // Fetch system statistics concurrently including memory and core stats
      const [remotes, jobs, rcloneInfo, memoryStats, coreStats] = await Promise.allSettled([
        this.rcloneService.getRemotes(),
        this.rcloneService.getJobs(),
        this.rcloneService.getRcloneInfo(),
        this.rcloneService.getMemoryStats(),
        this.rcloneService.getCoreStats()
      ]);
      
      // Process remotes
      const remotesResult = remotes.status === 'fulfilled' ? remotes.value : [];
      
      // Process jobs
      const jobsResult = jobs.status === 'fulfilled' ? jobs.value : [];
      const activeJobs = jobsResult.filter((job: any) => job.status === 'Running');
      
      // Get memory stats
      const memoryResult = memoryStats.status === 'fulfilled' ? memoryStats.value : null;
      const memoryUsage = this.formatMemoryUsage(memoryResult);
      
      // Get core stats for uptime calculation
      const coreResult = coreStats.status === 'fulfilled' ? coreStats.value : null;
      const uptime = this.formatUptime(coreResult?.elapsedTime || 0);
      
      // Calculate total data transferred from core stats
      const totalBytes = coreResult?.bytes || 0;
      
      // Update system stats with fallback values
      this.systemStats = {
        rcloneStatus: rcloneInfo.status === 'fulfilled' ? 'active' : 'error',
        activeConnections: remotesResult.length || 0,
        backgroundTasks: activeJobs.length,
        dataTransferred: this.formatBytes(totalBytes),
        totalRemotes: remotesResult.length || 0,
        activeJobs: activeJobs.length,
        memoryUsage: memoryUsage || 'Unknown',
        uptime: uptime || '0s'
      };
      
    } catch (error) {
      console.error('Error loading system stats:', error);
      this.systemStats.rcloneStatus = 'error';
    } finally {
      this.isLoadingStats = false;
      this.cdr.markForCheck();
    }
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  private formatMemoryUsage(memoryStats: any): string {
    if (!memoryStats) {
      return 'Unknown';
    }
    
    try {
      // Use HeapAlloc (not Sys or TotalAlloc) - this represents the actual memory currently 
      // in use by RClone. Sys includes unused reserved memory, TotalAlloc is cumulative historical data.
      // HeapAlloc gives us the real active memory footprint that users should see.
      const heapAllocMB = Math.round(memoryStats.HeapAlloc / 1024 / 1024);
      return `${heapAllocMB} MB`;
    } catch (error) {
      console.error('Error formatting memory usage:', error);
      return 'Error';
    }
  }

  private formatUptime(elapsedTimeSeconds: number): string {
    if (!elapsedTimeSeconds) {
      return '0s';
    }
    
    try {
      const totalSeconds = Math.floor(elapsedTimeSeconds);
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      
      if (hours > 0) {
        return `${hours}h ${minutes}m`;
      } else if (minutes > 0) {
        return `${minutes}m ${seconds}s`;
      } else {
        return `${seconds}s`;
      }
    } catch (error) {
      console.error('Error formatting uptime:', error);
      return 'Error';
    }
  }

  get isBandwidthLimited(): boolean {
    return this.bandwidthLimit?.rate !== 'off' && 
           this.bandwidthLimit?.rate !== '' && 
           this.bandwidthLimit?.bytesPerSecond !== -1;
  }

  get formattedBandwidthRate(): string {
    if (!this.bandwidthLimit || !this.isBandwidthLimited) {
      return 'Unlimited';
    }
    
    // Handle asymmetric rates (e.g., "10Ki:1Ki")
    const rate = this.bandwidthLimit.rate;
    if (rate.includes(':')) {
      const [upload, download] = rate.split(':');
      return `↑${this.formatRateValue(upload)} ↓${this.formatRateValue(download)}`;
    }
    
    return this.formatRateValue(rate);
  }

  get bandwidthDisplayValue(): string {
    if (!this.bandwidthLimit) return 'Loading...';
    if (this.bandwidthError) return 'Error loading limit';
    if (!this.isBandwidthLimited) return 'Unlimited';
    
    // For limited bandwidth, show a more descriptive message
    const rate = this.formattedBandwidthRate;
    if (rate.includes('↑') && rate.includes('↓')) {
      return rate; // Already formatted for asymmetric
    } else {
      return `Limited to ${rate}`;
    }
  }

  private formatRateValue(rate: string): string {
    if (!rate || rate === 'off' || rate === '') {
      return 'Unlimited';
    }
    
    // RClone uses Ki, Mi, Gi for binary units
    // Convert to more user-friendly display
    if (rate.endsWith('Ki')) {
      const value = rate.replace('Ki', '');
      return `${value} KB/s`;
    } else if (rate.endsWith('Mi')) {
      const value = rate.replace('Mi', '');
      return `${value} MB/s`;
    } else if (rate.endsWith('Gi')) {
      const value = rate.replace('Gi', '');
      return `${value} GB/s`;
    } else if (rate.endsWith('Ti')) {
      const value = rate.replace('Ti', '');
      return `${value} TB/s`;
    }
    
    // Handle raw numbers (bytes per second)
    const numValue = parseInt(rate);
    if (!isNaN(numValue)) {
      return this.formatBytesPerSecond(numValue);
    }
    
    // Fallback to original value if we can't parse it
    return rate;
  }

  private formatBytesPerSecond(bytes: number): string {
    if (bytes < 0) return 'Unlimited';
    if (bytes === 0) return '0 B/s';
    
    const units = ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s'];
    let size = bytes;
    let unitIndex = 0;
    
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    
    return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
  }

  get formattedUploadRate(): string {
    if (!this.bandwidthLimit || !this.isBandwidthLimited) {
      return 'Unlimited';
    }
    
    if (this.bandwidthLimit.bytesPerSecondTx === -1) {
      return 'Unlimited';
    }
    
    return this.formatBytesPerSecond(this.bandwidthLimit.bytesPerSecondTx);
  }

  get formattedDownloadRate(): string {
    if (!this.bandwidthLimit || !this.isBandwidthLimited) {
      return 'Unlimited';
    }
    
    if (this.bandwidthLimit.bytesPerSecondRx === -1) {
      return 'Unlimited';
    }
    
    return this.formatBytesPerSecond(this.bandwidthLimit.bytesPerSecondRx);
  }

  get formattedTotalRate(): string {
    if (!this.bandwidthLimit || !this.isBandwidthLimited) {
      return 'Unlimited';
    }
    
    if (this.bandwidthLimit.bytesPerSecond === -1) {
      return 'Unlimited';
    }
    
    return this.formatBytesPerSecond(this.bandwidthLimit.bytesPerSecond);
  }

  get systemStatusIcon(): string {
    switch (this.systemStats.rcloneStatus) {
      case 'active': return 'circle-check';
      case 'error': return 'circle-exclamation';
      default: return 'circle-pause';
    }
  }

  get systemStatusColor(): string {
    switch (this.systemStats.rcloneStatus) {
      case 'active': return 'status-active';
      case 'error': return 'status-error';
      default: return 'status-inactive';
    }
  }

  onAddRemoteClick(): void {
    this.openQuickAddRemoteModal.emit();
  }
}
