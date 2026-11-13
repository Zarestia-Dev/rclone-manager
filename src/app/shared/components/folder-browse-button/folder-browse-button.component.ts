import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { CdkMenuModule } from '@angular/cdk/menu';
import { ConnectedPosition } from '@angular/cdk/overlay';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import { BrowseTarget, PILL_TONE_VAR } from '@app/types';
import { PillDirective } from '../../directives/pill.directive';

/**
 * The "open in files" button of a card: a plain button for one folder, a button with a menu
 * and a count for several. Place it inside the card's `.quick-actions` row.
 */
@Component({
  selector: 'app-folder-browse-button',
  imports: [MatButtonModule, MatIconModule, CdkMenuModule, TranslatePipe, PillDirective],
  templateUrl: './folder-browse-button.component.html',
  styleUrl: './folder-browse-button.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FolderBrowseButtonComponent<T extends BrowseTarget> {
  readonly folders = input.required<readonly T[]>();

  readonly open = output<T>();

  protected readonly menuPosition: ConnectedPosition[] = [
    { originX: 'center', originY: 'top', overlayX: 'center', overlayY: 'bottom', offsetY: -8 },
  ];

  protected readonly isOpening = computed(() => this.folders().some(f => f.isOpening));

  /** Folders of different colours get a gradient trigger instead of one tone. */
  protected readonly blossomStyle = computed(() => {
    const tones = [...new Set(this.folders().map(f => f.tone))];
    if (tones.length <= 1) return null;
    return {
      color: 'var(--accent-fg-color)',
      background: `linear-gradient(135deg, ${tones.map(tone => PILL_TONE_VAR[tone]).join(', ')})`,
    };
  });

  protected choose(folder: T, event: Event): void {
    event.stopPropagation();
    this.open.emit(folder);
    (event.currentTarget as HTMLElement | null)?.blur();
  }
}
