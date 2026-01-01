import { CommonModule } from '@angular/common';
import { Component, computed, HostListener, input, signal, ViewChild, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatTooltipModule } from '@angular/material/tooltip';
import { SearchContainerComponent } from '../../shared/components/search-container/search-container.component';

// Services & Utils
import { Remote } from '@app/types';
import { IconService } from '@app/services';
import { UiStateService } from '@app/services';
import { RemoteStatusHelper } from '../../shared/utils/remote-status.helper';

@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [
    CommonModule,
    MatSidenavModule,
    MatCardModule,
    MatIconModule,
    MatTooltipModule,
    SearchContainerComponent,
  ],
  templateUrl: './sidebar.component.html',
  styleUrl: './sidebar.component.scss',
})
export class SidebarComponent {
  remotes = input.required<Remote[]>();
  iconService = inject(IconService);

  uiStateService = inject(UiStateService);
  selectedRemote = toSignal(this.uiStateService.selectedRemote$);

  searchTerm = signal('');
  searchVisible = signal(false);
  @ViewChild(SearchContainerComponent)
  searchContainer!: SearchContainerComponent;

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
    // propagate selection to global UI state so other components can react
    this.uiStateService.setSelectedRemote(remote);
  }

  @HostListener('document:keydown.control.f', ['$event'])
  onControlF(event: Event): void {
    const keyboardEvent = event as KeyboardEvent;
    keyboardEvent.preventDefault();
    this.toggleSearch();
    if (this.searchVisible() && this.searchContainer) {
      this.searchContainer.focus();
    }
  }

  // No local subscription needed: template uses async pipe on `selectedRemote$`

  toggleSearch(): void {
    this.searchVisible.update(v => !v);
    if (!this.searchVisible()) {
      this.clearSearch();
    }
  }

  clearSearch(): void {
    this.searchTerm.set('');
    if (this.searchContainer) {
      this.searchContainer.clear();
    }
  }

  // ============================================================================
  // Mount Profile Methods - Delegated to RemoteStatusHelper
  // ============================================================================

  getMountProfileCount(remote: Remote): number {
    return RemoteStatusHelper.getMountProfileCount(remote);
  }

  getMountTooltip(remote: Remote): string {
    return RemoteStatusHelper.getMountTooltip(remote);
  }

  // ============================================================================
  // Sync Operations Methods - Delegated to RemoteStatusHelper
  // ============================================================================

  hasSyncOperations(remote: Remote): boolean {
    return RemoteStatusHelper.hasSyncOperations(remote);
  }

  isAnySyncOperationActive(remote: Remote): boolean {
    return RemoteStatusHelper.isAnySyncOperationActive(remote);
  }

  getSyncProfileCount(remote: Remote): number {
    return RemoteStatusHelper.getSyncProfileCount(remote);
  }

  getActiveSyncOperationIcon(remote: Remote): string {
    return RemoteStatusHelper.getActiveSyncOperationIcon(remote);
  }

  getSyncOperationsTooltip(remote: Remote): string {
    return RemoteStatusHelper.getSyncOperationsTooltip(remote);
  }

  // ============================================================================
  // Serve Methods - Delegated to RemoteStatusHelper
  // ============================================================================

  getServeProfileCount(remote: Remote): number {
    return RemoteStatusHelper.getServeProfileCount(remote);
  }

  getServeTooltip(remote: Remote): string {
    return RemoteStatusHelper.getServeTooltip(remote);
  }
}
