import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  afterNextRender,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatMenuModule } from '@angular/material/menu';
import { PathDisplayConfig } from '../../types';
import { TranslatePipe } from '@ngx-translate/core';
import { isLocalPath } from 'src/app/services';

@Component({
  selector: 'app-path-display',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatIconModule,
    MatButtonModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    MatMenuModule,
    TranslatePipe,
  ],
  styleUrls: ['./path-display.component.scss'],
  template: `
    <div class="path-section">
      <div class="path-item">
        <div class="path-icon-container">
          @if (config().showOpenButtons && config().hasSource) {
            @if (isMultiPath(config().source)) {
              <button
                matIconButton
                class="folder-button active multi-path"
                [matMenuTriggerFor]="multiSourceMenu"
                [matTooltip]="'Click to view and open specific paths'"
              >
                <mat-icon svgIcon="folder"></mat-icon>
                <span class="path-count">{{ getAsArray(config().source).length }}</span>
              </button>

              <mat-menu #multiSourceMenu="matMenu" class="path-dropdown-menu" xPosition="after">
                <div class="menu-header">
                  {{ config().source.length }} {{ 'Items' | translate }}
                </div>
                @for (p of getAsArray(config().source); track p) {
                  <button
                    mat-menu-item
                    (click)="openPath.emit(p)"
                    [matTooltip]="p"
                    matTooltipPosition="right"
                  >
                    <mat-icon [svgIcon]="isLocalPath(p) ? 'folder' : 'folder-open'"></mat-icon>
                    <span class="menu-path-text">{{ p }}</span>
                  </button>
                }
              </mat-menu>
            } @else {
              <button
                matIconButton
                class="folder-button active"
                (click)="openPath.emit(getPrimaryPath(config().source))"
                [matTooltip]="'detailShared.pathDisplay.openInExplorer' | translate"
              >
                <mat-icon
                  [svgIcon]="
                    isLocalPath(getPrimaryPath(config().source)) ? 'folder' : 'folder-open'
                  "
                ></mat-icon>
              </button>
            }
          } @else {
            <mat-icon svgIcon="cloud-arrow-up" class="path-icon"></mat-icon>
          }
        </div>
        <div class="path-info" [matTooltip]="formatTooltip(config().source)">
          <div class="path-label">
            {{ config().sourceLabel || ('detailShared.pathDisplay.source' | translate) }}
          </div>
          <div class="path-value">
            {{ formatDisplay(config().source) }}
          </div>
        </div>
      </div>

      <div class="path-arrow">
        <mat-icon
          [svgIcon]="isMobile() ? 'arrow-down' : 'right-arrow'"
          class="arrow-icon"
        ></mat-icon>
      </div>

      <div class="path-item">
        <div class="path-icon-container">
          @if (config().showOpenButtons && config().hasDestination) {
            <button
              matIconButton
              class="folder-button"
              [class.active]="config().isDestinationActive"
              [class.inactive]="!config().isDestinationActive"
              [disabled]="config().actionInProgress === 'open' || !config().isDestinationActive"
              (click)="openPath.emit(config().destination)"
              [matTooltip]="'detailShared.pathDisplay.openInExplorer' | translate"
            >
              @if (config().actionInProgress === 'open') {
                <mat-spinner diameter="24"></mat-spinner>
              } @else {
                <mat-icon
                  [svgIcon]="isLocalPath(config().destination) ? 'folder' : 'folder-open'"
                ></mat-icon>
              }
            </button>
          } @else {
            <mat-icon svgIcon="cloud-arrow-up" class="path-icon"></mat-icon>
          }
        </div>
        <div class="path-info" [matTooltip]="config().destination">
          <div class="path-label">
            {{ config().destinationLabel || ('detailShared.pathDisplay.destination' | translate) }}
          </div>
          <div class="path-value">{{ config().destination }}</div>
        </div>
      </div>
    </div>
  `,
})
export class PathDisplayComponent {
  readonly config = input.required<PathDisplayConfig>();
  readonly openPath = output<string>();

  readonly isMobile = signal(false);

  readonly isLocalPath = isLocalPath;

  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    afterNextRender(() => {
      const update = (): void => {
        this.isMobile.set(window.innerWidth <= 768);
      };
      update();
      const observer = new ResizeObserver(update);
      observer.observe(document.body);
      this.destroyRef.onDestroy(() => observer.disconnect());
    });
  }

  isMultiPath(path: string | string[]): boolean {
    return Array.isArray(path) && path.length > 1;
  }

  getAsArray(path: string | string[]): string[] {
    return Array.isArray(path) ? path : [path];
  }

  getPrimaryPath(path: string | string[]): string {
    return Array.isArray(path) ? path[0] || '' : path;
  }

  formatDisplay(path: string | string[]): string {
    if (Array.isArray(path)) {
      if (path.length === 0) return '';
      if (path.length === 1) return path[0];
      return `${path[0]} (+${path.length - 1})`;
    }
    return path;
  }

  formatTooltip(path: string | string[]): string {
    if (Array.isArray(path)) {
      return path.join('\n');
    }
    return path;
  }
}
