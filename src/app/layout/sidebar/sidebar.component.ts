import { TitleCasePipe } from '@angular/common';
import {
  Component,
  computed,
  HostListener,
  input,
  signal,
  viewChild,
  inject,
  ChangeDetectionStrategy,
} from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslateModule } from '@ngx-translate/core';
import { SearchContainerComponent } from '../../shared/components/search-container/search-container.component';

// Services & Utils
import { Remote } from '@app/types';
import { IconService } from '@app/services';
import { UiStateService } from '@app/services';
import { RemoteStatusService } from '@app/services';
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
})
export class SidebarComponent {
  remotes = input.required<Remote[]>();
  readonly iconService = inject(IconService);
  private readonly uiStateService = inject(UiStateService);
  readonly statusService = inject(RemoteStatusService);
  private readonly remoteFacade = inject(RemoteFacadeService);

  readonly hiddenRemotes = this.remoteFacade.hiddenRemoteNames;
  selectedRemote = this.uiStateService.selectedRemote;

  searchTerm = signal('');
  searchVisible = signal(false);
  searchContainer = viewChild(SearchContainerComponent);

  onSearchTextChange(searchText: string): void {
    this.searchTerm.set(searchText);
  }

  filteredRemotes = computed(() => {
    const term = this.searchTerm().trim().toLowerCase();
    if (!term) return this.remotes();
    return this.remotes().filter(
      remote => remote.name.toLowerCase().includes(term) || remote.type.toLowerCase().includes(term)
    );
  });

  selectRemote(remote: Remote): void {
    this.uiStateService.setSelectedRemote(remote);
  }

  @HostListener('document:keydown.control.f', ['$event'])
  onControlF(event: Event): void {
    (event as KeyboardEvent).preventDefault();
    this.toggleSearch();
    if (this.searchVisible()) {
      this.searchContainer()?.focus();
    }
  }

  toggleSearch(): void {
    this.searchVisible.update(v => !v);
    if (!this.searchVisible()) {
      this.clearSearch();
    }
  }

  clearSearch(): void {
    this.searchContainer()?.clear();
  }
}
