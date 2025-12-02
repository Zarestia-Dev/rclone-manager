import { Component, Input, Output, EventEmitter, HostListener, OnInit } from '@angular/core';

import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { PathDisplayConfig } from '../../types';

@Component({
  selector: 'app-path-display',
  standalone: true,
  imports: [MatIconModule, MatButtonModule, MatProgressSpinnerModule, MatTooltipModule],
  styleUrls: ['./path-display.component.scss'],
  template: `
    <div class="path-section">
      <div class="path-item">
        <div class="path-icon-container">
          @if (config.showOpenButtons && isLocalPath(config.source)) {
            <button
              matIconButton
              class="folder-button"
              (click)="onOpenPath(config.source)"
              matTooltip="Open in file explorer"
            >
              <mat-icon svgIcon="folder"></mat-icon>
            </button>
          } @else {
            <mat-icon svgIcon="cloud-arrow-up" class="path-icon"></mat-icon>
          }
        </div>
        <div class="path-info" [matTooltip]="config.source">
          <div class="path-label">{{ config.sourceLabel || 'Source' }}</div>
          <div class="path-value">{{ config.source }}</div>
        </div>
      </div>

      <div class="path-arrow">
        <mat-icon [svgIcon]="isMobile ? 'arrow-down' : 'right-arrow'" class="arrow-icon"></mat-icon>
      </div>
      <div class="path-item destination-path">
        <div class="path-icon-container">
          @if (config.showOpenButtons && isLocalPath(config.destination)) {
            <button
              matIconButton
              class="folder-button"
              [class.active]="config.isDestinationActive"
              [class.inactive]="!config.isDestinationActive"
              [disabled]="config.actionInProgress === 'open' || !config.isDestinationActive"
              (click)="onOpenPath(config.destination)"
              matTooltip="Open in file explorer"
            >
              @if (config.actionInProgress === 'open') {
                <mat-spinner diameter="20"></mat-spinner>
              } @else {
                <mat-icon svgIcon="folder"></mat-icon>
              }
            </button>
          } @else {
            <mat-icon svgIcon="cloud-arrow-up" class="path-icon"></mat-icon>
          }
        </div>
        <div class="path-info" [matTooltip]="config.destination">
          <div class="path-label">{{ config.destinationLabel || 'Destination' }}</div>
          <div class="path-value">{{ config.destination }}</div>
        </div>
      </div>
    </div>
  `,
})
export class PathDisplayComponent implements OnInit {
  @Input() config!: PathDisplayConfig;
  @Output() openPath = new EventEmitter<string>();
  isMobile = false;

  isLocalPath(path: string): boolean {
    return !!(path && (path.startsWith('/') || path.match(/^[A-Za-z]:\\/)));
  }

  onOpenPath(path: string): void {
    this.openPath.emit(path);
  }

  ngOnInit(): void {
    // Initial mobile detection
    this.isMobile = window.innerWidth <= 768;
  }

  @HostListener('window:resize')
  onResize(): void {
    this.isMobile = window.innerWidth <= 768;
  }
}
