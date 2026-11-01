import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { TranslatePipe } from '@ngx-translate/core';
import { RcCommandInfo } from '@app/types';
import { SearchContainerComponent } from '../search-container/search-container.component';
import { isDangerousCommand, isReadOnlyCommand } from '../../utils/rc/rc-console.util';

interface TreeGroup {
  module: string;
  commands: RcCommandInfo[];
}

/** The list of every call rclone offers, grouped by module, in the style of the config sidebars. */
@Component({
  selector: 'app-rc-sidebar',
  imports: [MatIconModule, MatListModule, TranslatePipe, SearchContainerComponent],
  templateUrl: './rc-sidebar.component.html',
  styleUrl: './rc-sidebar.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RcSidebarComponent {
  readonly commands = input.required<readonly RcCommandInfo[]>();
  /** The path being typed, so its module opens and the entry is marked. */
  readonly selected = input('');
  /** Marks the calls that read-only mode would block. */
  readonly readOnly = input(false);
  /** The "clear" footer item is for the console; other hosts turn it off. */
  readonly showClear = input(true);
  readonly canClear = input(false);

  readonly pick = output<string>();
  readonly clearRequested = output<void>();

  readonly filter = signal('');
  readonly searchVisible = signal(false);
  private readonly toggled = signal<ReadonlySet<string>>(new Set());

  readonly groups = computed<TreeGroup[]>(() => {
    const needle = this.filter().trim().toLowerCase();
    const byModule = new Map<string, RcCommandInfo[]>();
    for (const command of this.commands()) {
      if (
        needle &&
        !command.Path.toLowerCase().includes(needle) &&
        !command.Title.toLowerCase().includes(needle)
      ) {
        continue;
      }
      const module = command.Path.split('/')[0];
      const group = byModule.get(module);
      if (group) group.push(command);
      else byModule.set(module, [command]);
    }
    return [...byModule].map(([module, commands]) => ({ module, commands }));
  });

  private readonly selectedModule = computed(() => this.selected().split('/')[0]);

  /**
   * A module is open when the filter is searching, or when it holds the typed call. A click on its
   * header flips that, and keeps the flip until the typed call moves to another module.
   */
  isOpen(module: string): boolean {
    if (this.filter().trim()) return true;
    const flipped = this.toggled().has(module);
    return module === this.selectedModule() ? !flipped : flipped;
  }

  /** Hiding the search also drops its text, so the list is never filtered by something unseen. */
  setSearchVisible(visible: boolean): void {
    this.searchVisible.set(visible);
    if (!visible) this.filter.set('');
  }

  toggle(module: string): void {
    this.toggled.update(set => {
      const next = new Set(set);
      if (!next.delete(module)) next.add(module);
      return next;
    });
  }

  name(path: string): string {
    return path.slice(path.indexOf('/') + 1);
  }

  /** The icon for a call that needs care, if it does. */
  flag(path: string): 'shield-xmark' | 'lock' | null {
    if (isDangerousCommand(path)) return 'shield-xmark';
    return this.readOnly() && !isReadOnlyCommand(path) ? 'lock' : null;
  }
}
