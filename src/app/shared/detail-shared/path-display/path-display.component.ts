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
import { TranslateModule } from '@ngx-translate/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { PathDisplayConfig } from '../../types';
import { isLocalPath } from 'src/app/services/remote/utils/remote-config.utils';

@Component({
  selector: 'app-path-display',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatIconModule,
    MatButtonModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    TranslateModule,
  ],
  styleUrls: ['./path-display.component.scss'],
  template: `
    <div class="path-section">
      <div class="path-item">
        <div class="path-icon-container">
          @if (config().showOpenButtons && config().hasSource) {
            <button
              matIconButton
              class="folder-button active"
              (click)="openPath.emit(config().source)"
              [matTooltip]="'detailShared.pathDisplay.openInExplorer' | translate"
            >
              <mat-icon
                [svgIcon]="isLocalPath(config().source) ? 'folder' : 'folder-open'"
              ></mat-icon>
            </button>
          } @else {
            <mat-icon svgIcon="cloud-arrow-up" class="path-icon"></mat-icon>
          }
        </div>
        <div class="path-info" [matTooltip]="config().source">
          <div class="path-label">
            {{ config().sourceLabel || ('detailShared.pathDisplay.source' | translate) }}
          </div>
          <div class="path-value">{{ config().source }}</div>
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
}
