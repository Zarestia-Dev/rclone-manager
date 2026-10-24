import * as pathUtils from 'src/app/shared/utils/path.utils';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { CdkMenuModule } from '@angular/cdk/menu';
import { PathDisplayConfig } from '@app/types';
import { TranslatePipe } from '@ngx-translate/core';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';

interface SourcePathItem {
  path: string;
  isLocal: boolean;
}

@Component({
  selector: 'app-path-display',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, MatButtonModule, CdkMenuModule, TranslatePipe],
  styleUrls: ['./path-display.component.scss'],
  template: `
    <div class="path-section">
      <div class="path-item">
        @if (config().showOpenButtons && config().hasSource) {
          @if (sourceIsMultiPath()) {
            <button
              matIconButton
              class="folder-button active multi-path"
              [cdkMenuTriggerFor]="multiSourceMenu"
            >
              <mat-icon svgIcon="folder"></mat-icon>
              <span class="path-count">{{ sourcePathItems().length }}</span>
            </button>

            <ng-template #multiSourceMenu>
              <div class="material-context-menu" cdkMenu>
                @for (item of sourcePathItems(); track item.path) {
                  <button
                    class="menu-item"
                    cdkMenuItem
                    (cdkMenuItemTriggered)="openPath.emit(item.path)"
                    [attr.title]="item.path"
                  >
                    <mat-icon [svgIcon]="item.isLocal ? 'folder' : 'folder-open'"></mat-icon>
                    <span class="menu-path-text">{{ item.path }}</span>
                  </button>
                }
              </div>
            </ng-template>
          } @else {
            <button
              matIconButton
              class="folder-button active"
              (click)="openPath.emit(sourcePrimaryPath())"
              [attr.title]="'detailShared.pathDisplay.openInExplorer' | translate"
            >
              <mat-icon
                [svgIcon]="sourcePrimaryPathIsLocal() ? 'folder' : 'folder-open'"
              ></mat-icon>
            </button>
          }
        } @else {
          <mat-icon svgIcon="cloud-arrow-up" class="path-icon"></mat-icon>
        }
        <div class="path-label">
          {{ config().sourceLabel || ('detailShared.pathDisplay.source' | translate) }}
        </div>
        <code class="path-value" [attr.title]="sourceTooltip()">{{ sourceDisplay() }}</code>
      </div>

      @if (!config().hideDestination) {
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
              [attr.title]="'detailShared.pathDisplay.openInExplorer' | translate"
            >
              @if (config().actionInProgress === 'open') {
                <mat-icon svgIcon="spinner"></mat-icon>
              } @else {
                <mat-icon [svgIcon]="destinationIsLocal() ? 'folder' : 'folder-open'"></mat-icon>
              }
            </button>
          } @else {
            <mat-icon svgIcon="cloud-arrow-up" class="path-icon"></mat-icon>
          }
          <div class="path-label">
            {{ config().destinationLabel || ('detailShared.pathDisplay.destination' | translate) }}
          </div>
          <code class="path-value" [attr.title]="config().destination">{{
            config().destination
          }}</code>
        </div>
      }
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

  readonly sourceIsMultiPath = computed<boolean>(() => pathUtils.isMultiPath(this.config().source));
  readonly sourcePathItems = computed<SourcePathItem[]>(() =>
    pathUtils.asPathArray(this.config().source).map(p => ({
      path: p,
      isLocal: this.pathService.isLocalPath(p),
    }))
  );
  readonly sourcePrimaryPath = computed<string>(() =>
    pathUtils.getPrimaryPath(this.config().source)
  );
  readonly sourcePrimaryPathIsLocal = computed<boolean>(() =>
    this.pathService.isLocalPath(this.sourcePrimaryPath())
  );
  readonly sourceDisplay = computed<string>(() =>
    pathUtils.formatPathDisplay(this.config().source)
  );
  readonly sourceTooltip = computed<string>(() =>
    pathUtils.formatPathTooltip(this.config().source)
  );
  readonly destinationIsLocal = computed<boolean>(() =>
    this.pathService.isLocalPath(this.config().destination)
  );

  constructor() {
    afterNextRender(() => {
      const handler = (e: MediaQueryListEvent): void => this.isMobile.set(e.matches);
      this.mediaQuery.addEventListener('change', handler);
      this.destroyRef.onDestroy(() => this.mediaQuery.removeEventListener('change', handler));
    });
  }
}
