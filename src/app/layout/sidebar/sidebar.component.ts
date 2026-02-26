import { TitleCasePipe } from '@angular/common';
import { Component, computed, HostListener, input, signal, viewChild, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslateModule } from '@ngx-translate/core';
import { SearchContainerComponent } from '../../shared/components/search-container/search-container.component';

// Services & Utils
import { Remote } from '@app/types';
import { IconService } from '@app/services';
import { UiStateService } from '@app/services';
import { RemoteStatusService } from '../../shared/utils/remote-status.service';

@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [
    TitleCasePipe,
    MatSidenavModule,
    MatCardModule,
    MatIconModule,
    MatTooltipModule,
    TranslateModule,
    SearchContainerComponent,
  ],
  templateUrl: './sidebar.component.html',
  styleUrl: './sidebar.component.scss',
})
export class SidebarComponent {
  remotes = input.required<Remote[]>();
  iconService = inject(IconService);
  uiStateService = inject(UiStateService);

  // Inject the i18n-aware service
  readonly statusService = inject(RemoteStatusService);

  selectedRemote = toSignal(this.uiStateService.selectedRemote$);

  searchTerm = signal('');
  searchVisible = signal(false);
  searchContainer = viewChild(SearchContainerComponent);

  onSearchTextChange(searchText: string): void {
    this.searchTerm.set(searchText.trim().toLowerCase());
  }

  filteredRemotes = computed(() => {
    const term = this.searchTerm().trim().toLowerCase();
    if (!term) return this.remotes();
    return this.remotes().filter(
      remote =>
        remote.remoteSpecs.name.toLowerCase().includes(term) ||
        remote.remoteSpecs.type.toLowerCase().includes(term)
    );
  });

  selectRemote(remote: Remote): void {
    this.uiStateService.setSelectedRemote(remote);
  }

  @HostListener('document:keydown.control.f', ['$event'])
  onControlF(event: Event): void {
    const keyboardEvent = event as KeyboardEvent;
    keyboardEvent.preventDefault();
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
    this.searchTerm.set('');
    this.searchContainer()?.clear();
  }
}
