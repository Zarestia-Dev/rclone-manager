import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { TranslatePipe } from '@ngx-translate/core';
import { FileBrowserItem } from '@app/types';
import { IconService } from 'src/app/services/ui/icon.service';

/** A tab as the overview shows it: its title and the first entries of its folder. */
export interface TabPreview {
  id: number;
  title: string;
  files: FileBrowserItem[];
}

/**
 * The open tabs of a narrow file browser as cards, like the tab overview of GNOME Files on a
 * phone. Each card lists the first entries of its tab's folder.
 */
@Component({
  selector: 'app-nautilus-tab-overview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, MatButtonModule, TranslatePipe],
  templateUrl: './nautilus-tab-overview.component.html',
  styleUrl: './nautilus-tab-overview.component.scss',
  host: {
    '(keydown.escape)': 'closeOverview.emit()',
  },
})
export class NautilusTabOverviewComponent {
  public readonly tabs = input.required<TabPreview[]>();
  public readonly activeTabIndex = input.required<number>();

  public readonly switchTab = output<number>();
  public readonly closeTab = output<number>();
  public readonly newTab = output<void>();
  public readonly closeOverview = output<void>();

  protected readonly iconService = inject(IconService);
}
