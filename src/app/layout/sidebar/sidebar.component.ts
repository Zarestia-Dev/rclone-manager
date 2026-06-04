import { TitleCasePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslateModule } from '@ngx-translate/core';
import { SearchContainerComponent } from '../../shared/components/search-container/search-container.component';

import { Remote } from '@app/types';

import { IconService, UiStateService, RemoteStatusService } from '@app/services';
import { RemoteFacadeService } from '../../services/facade/remote-facade.service';

@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [
    TitleCasePipe,
    MatCardModule,
    MatIconModule,
    MatTooltipModule,
    TranslateModule,
    SearchContainerComponent,
  ],
  templateUrl: './sidebar.component.html',
  styleUrl: './sidebar.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:keydown.control.f)': 'onCtrlF($event)',
  },
})
export class SidebarComponent {
  readonly remotes = input.required<Remote[]>();

  readonly iconService = inject(IconService);
  readonly statusService = inject(RemoteStatusService);
  private readonly uiStateService = inject(UiStateService);
  private readonly remoteFacade = inject(RemoteFacadeService);

  readonly selectedRemote = this.uiStateService.selectedRemote;
  readonly hiddenRemotes = this.remoteFacade.hiddenRemoteNames;

  readonly searchTerm = signal('');
  readonly searchVisible = signal(false);
  private readonly searchContainer = viewChild(SearchContainerComponent);

  readonly filteredRemotes = computed(() => {
    const term = this.searchTerm().trim().toLowerCase();
    if (!term) return this.remotes();
    return this.remotes().filter(
      r => r.name.toLowerCase().includes(term) || r.type.toLowerCase().includes(term)
    );
  });

  selectRemote(remote: Remote): void {
    this.uiStateService.setSelectedRemote(remote);
  }

  onSearchTextChange(text: string): void {
    this.searchTerm.set(text);
  }

  toggleSearch(): void {
    this.searchVisible.update(v => !v);
    if (!this.searchVisible()) {
      this.clearSearch();
    }
  }

  clearSearch(): void {
    this.searchTerm.set('');
    this.searchContainer()?.clear();
  }

  onCtrlF(event: Event): void {
    (event as KeyboardEvent).preventDefault();
    if (!this.searchVisible()) {
      this.toggleSearch();
    } else {
      this.searchContainer()?.focus();
    }
  }
}
