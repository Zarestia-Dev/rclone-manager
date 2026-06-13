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
import { CdkMenuModule } from '@angular/cdk/menu';
import { PathDisplayConfig } from '../../types';
import { TranslatePipe } from '@ngx-translate/core';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';

@Component({
  selector: 'app-path-display',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatIconModule,
    MatButtonModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    CdkMenuModule,
    TranslatePipe,
  ],
  styleUrls: ['./path-display.component.scss'],
  template: `
    <div class="path-section">
      <div class="path-item">
        @if (config().showOpenButtons && config().hasSource) {
          @if (isMultiPath(config().source)) {
            <button
              matIconButton
              class="folder-button active multi-path"
              [cdkMenuTriggerFor]="multiSourceMenu"
            >
              <mat-icon svgIcon="folder"></mat-icon>
              <span class="path-count">{{ getAsArray(config().source).length }}</span>
            </button>

            <ng-template #multiSourceMenu>
              <div class="material-context-menu" cdkMenu>
                @for (p of getAsArray(config().source); track p) {
                  <button
                    class="menu-item"
                    cdkMenuItem
                    (cdkMenuItemTriggered)="openPath.emit(p)"
                    [matTooltip]="p"
                    matTooltipPosition="right"
                  >
                    <mat-icon [svgIcon]="isLocal(p) ? 'folder' : 'folder-open'"></mat-icon>
                    <span class="menu-path-text">{{ p }}</span>
                  </button>
                }
              </div>
            </ng-template>
          } @else {
            <button
              matIconButton
              class="folder-button active"
              (click)="openPath.emit(getPrimaryPath(config().source))"
              [matTooltip]="'detailShared.pathDisplay.openInExplorer' | translate"
            >
              <mat-icon
                [svgIcon]="isLocal(getPrimaryPath(config().source)) ? 'folder' : 'folder-open'"
              ></mat-icon>
            </button>
          }
        } @else {
          <mat-icon svgIcon="cloud-arrow-up" class="path-icon"></mat-icon>
        }
        <div class="path-label">
          {{ config().sourceLabel || ('detailShared.pathDisplay.source' | translate) }}
        </div>
        <code class="path-value" [matTooltip]="formatTooltip(config().source)">{{
          formatDisplay(config().source)
        }}</code>
      </div>

      <div class="path-arrow">
        <mat-icon
          [svgIcon]="isMobile() ? 'arrow-down' : 'right-arrow'"
          class="arrow-icon"
        ></mat-icon>
      </div>

      <div class="path-item">
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
                [svgIcon]="isLocal(config().destination) ? 'folder' : 'folder-open'"
              ></mat-icon>
            }
          </button>
        } @else {
          <mat-icon svgIcon="cloud-arrow-up" class="path-icon"></mat-icon>
        }
        <div class="path-label">
          {{ config().destinationLabel || ('detailShared.pathDisplay.destination' | translate) }}
        </div>
        <code class="path-value" [matTooltip]="config().destination">{{
          config().destination
        }}</code>
      </div>
    </div>
  `,
})
export class PathDisplayComponent {
  readonly config = input.required<PathDisplayConfig>();
  readonly openPath = output<string>();

  private readonly pathService = inject(PathService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly mediaQuery = window.matchMedia('(max-width: 768px)');

  readonly isMobile = signal(this.mediaQuery.matches);

  constructor() {
    afterNextRender(() => {
      const handler = (e: MediaQueryListEvent): void => this.isMobile.set(e.matches);
      this.mediaQuery.addEventListener('change', handler);
      this.destroyRef.onDestroy(() => this.mediaQuery.removeEventListener('change', handler));
    });
  }

  isLocal(path: string): boolean {
    return this.pathService.isLocalPath(path);
  }
  isMultiPath(path: string | string[]): boolean {
    return this.pathService.isMultiPath(path);
  }
  getAsArray(path: string | string[]): string[] {
    return this.pathService.asPathArray(path);
  }
  getPrimaryPath(path: string | string[]): string {
    return this.pathService.getPrimaryPath(path);
  }
  formatDisplay(path: string | string[]): string {
    return this.pathService.formatPathDisplay(path);
  }
  formatTooltip(path: string | string[]): string {
    return this.pathService.formatPathTooltip(path);
  }
}
