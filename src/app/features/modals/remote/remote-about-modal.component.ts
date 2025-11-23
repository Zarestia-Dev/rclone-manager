import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import { MatDialogRef, MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTabsModule } from '@angular/material/tabs';
import { MatChipsModule } from '@angular/material/chips';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatTooltipModule } from '@angular/material/tooltip';
import { RemoteManagementService } from 'src/app/services';

interface RemoteAboutData {
  remote: { name: string; type?: string };
  about: Record<string, unknown>;
  size: { count: number; bytes: number };
  diskUsage: { total?: number; used?: number; free?: number };
}

@Component({
  selector: 'app-remote-about-modal',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatDividerModule,
    MatIconModule,
    MatButtonModule,
    MatTabsModule,
    MatChipsModule,
    MatExpansionModule,
    MatTooltipModule,
    MatProgressSpinnerModule,
  ],
  template: `
    <div class="modal-container">
      <div class="modal-header">
        <div class="header-content">
          <mat-icon svgIcon="folder" class="header-icon"></mat-icon>
          <div>
            <h2 class="title">{{ getRemoteName() }}</h2>
            <p class="subtitle">{{ getString() }}</p>
          </div>
        </div>
        <button mat-icon-button (click)="close()"><mat-icon svgIcon="close"></mat-icon></button>
      </div>

      <div class="modal-body">
        <div *ngIf="isLoading" class="loading-spinner">
          <mat-spinner diameter="50"></mat-spinner>
        </div>
        <div *ngIf="errorMessage" class="error-message">
          {{ errorMessage }}
        </div>
        <!-- Removed 'dynamicHeight' to allow accordion expansion to resize the container -->
        <mat-tab-group animationDuration="0ms">
          <mat-tab label="Overview">
            <div class="tab-content">
              <div *ngIf="hasUsageData()" class="usage-card">
                <div class="usage-item">
                  <span class="label">Files</span>
                  <span class="value">{{ getFileCount() }}</span>
                </div>
                <div class="usage-item">
                  <span class="label">Total</span>
                  <span class="value">{{ getTotal() }}</span>
                </div>
                <div class="usage-item">
                  <span class="label">Used</span>
                  <span class="value">{{ getUsed() }}</span>
                </div>
                <div class="usage-item">
                  <span class="label">Free</span>
                  <span class="value">{{ getFree() }}</span>
                </div>
              </div>

              <div class="info-grid">
                <div class="info-row">
                  <span class="info-label">Remote Type</span>
                  <span class="info-value">{{ data.remote.type || 'Unknown' }}</span>
                </div>
                <div class="info-row">
                  <span class="info-label">Root Path</span>
                  <span class="info-value code-font">{{ getRoot() }}</span>
                </div>
                <div class="info-row">
                  <span class="info-label">Time Precision</span>
                  <span class="info-value">{{ getPrecisionFormatted() }}</span>
                </div>
              </div>

              <div class="section-header">Supported Hashes</div>
              <mat-chip-set>
                <mat-chip *ngFor="let hash of getHashes(); trackBy: trackByHash" class="hash-chip">
                  {{ hash }}
                </mat-chip>
                <span *ngIf="getHashes().length === 0" class="empty-text">None</span>
              </mat-chip-set>
            </div>
          </mat-tab>

          <mat-tab label="Features">
            <div class="tab-content">
              <div class="features-grid">
                <div
                  *ngFor="let feat of getFeatures(); trackBy: trackByFeature"
                  class="feature-item"
                  [class.supported]="feat.value === true"
                  [class.unsupported]="feat.value === false"
                >
                  <mat-icon
                    class="feature-icon"
                    [svgIcon]="feat.value === true ? 'circle-check' : 'circle-xmark'"
                  ></mat-icon>
                  <span class="feature-name">{{ feat.key }}</span>
                </div>
              </div>
            </div>
          </mat-tab>

          <mat-tab label="Metadata Specs">
            <div class="tab-content no-pad">
              <mat-accordion multi>
                <ng-container *ngFor="let group of getMetadataGroups(); trackBy: trackByGroup">
                  <div class="group-header" *ngIf="group.items.length > 0">{{ group.name }}</div>

                  <mat-expansion-panel *ngFor="let item of group.items; trackBy: trackByItem">
                    <mat-expansion-panel-header>
                      <mat-panel-title class="meta-title">
                        {{ item.key }}
                      </mat-panel-title>
                      <mat-panel-description>
                        {{ item.data['Type'] || 'Unknown' }}
                      </mat-panel-description>
                    </mat-expansion-panel-header>

                    <div class="meta-details">
                      <p class="meta-help">{{ item.data['Help'] }}</p>
                      <div class="meta-props">
                        <div *ngIf="item.data['Example']">
                          <strong>Example:</strong>
                          <span class="code-bg">{{ item.data['Example'] }}</span>
                        </div>
                        <div>
                          <strong>Read Only:</strong> {{ item.data['ReadOnly'] ? 'Yes' : 'No' }}
                        </div>
                      </div>
                    </div>
                  </mat-expansion-panel>
                </ng-container>

                <div *ngIf="getMetadataGroups().length === 0" class="empty-state">
                  No metadata specifications available.
                </div>
              </mat-accordion>
            </div>
          </mat-tab>
        </mat-tab-group>
      </div>

      <div class="modal-footer">
        <button mat-stroked-button (click)="close()">Close</button>
      </div>
    </div>
  `,
  styles: [
    `
      /* Encapsulation: None is often easier for Modal styles, 
       but let's stick to Emulated with specific classes */
      .modal-container {
        display: flex;
        flex-direction: column;
        max-height: 85vh;
        width: 600px; /* Wider for tabs */
        color: var(--app-text-color);
      }

      .modal-header {
        padding: 20px 24px;
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
      }

      .header-content {
        display: flex;
        gap: 16px;
        align-items: center;
      }

      .header-icon {
        transform: scale(1.5);
        color: var(--primary-color);
      }

      .title {
        margin: 0;
        font-size: 20px;
        font-weight: 500;
      }

      .subtitle {
        margin: 4px 0 0 0;
        font-size: 13px;
        color: var(--secondary-text-color);
        line-height: 1.4;
      }

      .modal-body {
        flex: 1;
        overflow-y: auto;
        /* Remove default padding because Tabs handle it */
        padding: 0;
      }

      .tab-content {
        padding: 20px 24px;
      }

      .tab-content.no-pad {
        padding: 0;
      }

      .loading-spinner {
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100%;
      }

      .error-message {
        padding: 20px;
        text-align: center;
        color: var(--error-color);
      }

      /* --- Overview Tab --- */
      .usage-card {
        display: flex;
        background: var(--secondary-background, #f5f5f5);
        border-radius: 12px;
        padding: 16px;
        margin-bottom: 24px;
        border: 1px solid var(--border-color, #e0e0e0);
      }

      .usage-item {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 4px;
      }

      .usage-item:not(:last-child) {
        border-right: 1px solid var(--border-color, #ddd);
      }

      .usage-item .label {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--secondary-text-color);
      }

      .usage-item .value {
        font-size: 16px;
        font-weight: 600;
      }

      .info-grid {
        display: flex;
        flex-direction: column;
        gap: 12px;
        margin-bottom: 24px;
      }

      .info-row {
        display: flex;
        justify-content: space-between;
        border-bottom: 1px solid var(--border-color, #eee);
        padding-bottom: 8px;
      }

      .info-label {
        color: var(--secondary-text-color);
        font-weight: 500;
      }

      .code-font {
        font-family: monospace;
        background: rgba(0, 0, 0, 0.05);
        padding: 2px 6px;
        border-radius: 4px;
      }

      .section-header {
        font-size: 13px;
        font-weight: 600;
        color: var(--secondary-text-color);
        margin-bottom: 12px;
        text-transform: uppercase;
      }

      /* --- Features Tab --- */
      .features-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr); /* 2 Columns */
        gap: 8px 16px;
      }

      .feature-item {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 13px;
        padding: 4px 0;
      }

      .feature-icon {
        font-size: 18px;
        width: 18px;
        height: 18px;
      }

      .feature-item.supported .feature-icon {
        color: #4caf50;
      }
      .feature-item.unsupported .feature-icon {
        color: var(--secondary-text-color);
        opacity: 0.3;
      }
      .feature-item.unsupported .feature-name {
        color: var(--secondary-text-color);
      }

      /* --- Metadata Tab --- */
      .group-header {
        padding: 12px 24px;
        background: var(--secondary-background, #fafafa);
        font-weight: 600;
        font-size: 12px;
        text-transform: uppercase;
        color: var(--secondary-text-color);
        border-bottom: 1px solid var(--border-color, #eee);
      }

      .meta-title {
        font-family: monospace;
        font-weight: 600;
      }

      .meta-details {
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding-top: 8px; /* Added padding for better spacing */
      }

      .meta-help {
        margin: 0;
        font-size: 14px;
        line-height: 1.5;
        color: var(--secondary-text-color);
      }

      .meta-props {
        display: flex;
        gap: 16px;
        font-size: 12px;
      }

      .code-bg {
        background: rgba(0, 0, 0, 0.06);
        padding: 2px 4px;
        border-radius: 4px;
        font-family: monospace;
      }

      .empty-state {
        padding: 24px;
        text-align: center;
        color: var(--secondary-text-color);
        font-style: italic;
      }

      .modal-footer {
        padding: 16px 24px;
        border-top: 1px solid var(--border-color, #e0e0e0);
        display: flex;
        justify-content: flex-end;
      }
    `,
  ],
})
export class RemoteAboutModalComponent {
  private dialogRef = inject(MatDialogRef<RemoteAboutModalComponent>);
  private remoteManagementService = inject(RemoteManagementService);

  // Inject data
  public data: RemoteAboutData = inject(MAT_DIALOG_DATA);

  public isLoading = true;
  public errorMessage = '';

  constructor() {
    this.loadData();
  }

  async loadData(): Promise<void> {
    this.isLoading = true;
    this.errorMessage = '';
    const remoteParam = this.data.remote.name === 'Local' ? '' : this.data.remote.name;
    try {
      const [about, size, diskUsage] = await Promise.all([
        this.remoteManagementService.getFsInfo(remoteParam),
        this.remoteManagementService.getSize(remoteParam),
        this.remoteManagementService.getDiskUsage(remoteParam),
      ]);
      this.data.about = about as Record<string, unknown>;
      this.data.size = size;
      this.data.diskUsage = diskUsage;
    } catch (err) {
      this.errorMessage = 'Failed to load remote info.';
      console.error(err);
    } finally {
      this.isLoading = false;
    }
  }

  // --- Helpers ---
  private getAbout(): Record<string, unknown> {
    return this.data?.about || {};
  }

  getRemoteName(): string {
    return this.data.remote?.name || (this.getAbout()['Name'] as string) || 'Remote';
  }

  getString(): string {
    return (this.getAbout()['String'] as string) || '';
  }

  getRoot(): string {
    return (this.getAbout()['Root'] as string) || '/';
  }

  // --- Usage Stats ---
  getTotal(): number {
    return this.data?.diskUsage?.total || 0;
  }
  getUsed(): number {
    return this.data?.diskUsage?.used || 0;
  }
  getFree(): number {
    return this.data?.diskUsage?.free || 0;
  }

  getFileCount(): number {
    return this.data?.size?.count || 0;
  }

  hasUsageData(): boolean {
    return this.getTotal() !== null || this.getUsed() !== null || this.getFileCount() > 0;
  }

  private parseNum(val: string | number | null | undefined): number | null {
    if (typeof val === 'number') return val;
    if (typeof val === 'string') {
      const parsed = parseInt(val, 10);
      return isNaN(parsed) ? null : parsed;
    }
    return null;
  }

  // --- Precision ---
  getPrecisionFormatted(): string {
    const ns = this.getAbout()['Precision'] as number;
    if (!ns) return '-';

    // Convert Nanoseconds to readable
    if (ns >= 1000000000) return ns / 1000000000 + ' s';
    if (ns >= 1000000) return ns / 1000000 + ' ms';
    if (ns >= 1000) return ns / 1000 + ' µs';
    return ns + ' ns';
  }

  // --- Hashes ---
  getHashes(): string[] {
    const h = this.getAbout()['Hashes'];
    return Array.isArray(h) ? h : [];
  }

  // --- Features ---
  getFeatures(): { key: string; value: boolean }[] {
    const features = this.getAbout()['Features'];
    if (!features) return [];

    // Convert object to sorted array
    return Object.entries(features)
      .map(([key, value]) => ({ key, value: !!value }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  // --- Metadata Specs ---
  // Grouping 'System' metadata vs User metadata (properties directly on MetadataInfo)
  getMetadataGroups(): {
    name: string;
    items: { key: string; data: Record<string, unknown> }[];
  }[] {
    const info = this.getAbout()['MetadataInfo'] as Record<string, unknown>;
    if (!info) return [];

    const groups = [];

    // 1. System Metadata
    if (info['System']) {
      const sysItems = Object.entries(info['System'] as Record<string, unknown>)
        .map(([key, data]) => ({ key, data: data as Record<string, unknown> }))
        .sort((a, b) => a.key.localeCompare(b.key));

      if (sysItems.length) {
        groups.push({ name: 'System Metadata', items: sysItems });
      }
    }

    // 2. User/Other Metadata (keys that are Objects but not "System" or "Help")
    const otherItems = Object.entries(info)
      .filter(([key, val]) => key !== 'System' && typeof val === 'object' && val !== null)
      .map(([key, data]) => ({ key, data: data as Record<string, unknown> }))
      .sort((a, b) => a.key.localeCompare(b.key));

    if (otherItems.length) {
      groups.push({ name: 'Standard Metadata', items: otherItems });
    }

    return groups;
  }

  // --- TrackBy Functions ---
  trackByHash(index: number, hash: string): string {
    return hash;
  }

  trackByFeature(index: number, feat: { key: string; value: boolean }): string {
    return feat.key;
  }

  trackByGroup(index: number, group: { name: string }): string {
    return group.name;
  }

  trackByItem(index: number, item: { key: string }): string {
    return item.key;
  }

  close(): void {
    this.dialogRef.close();
  }
}
