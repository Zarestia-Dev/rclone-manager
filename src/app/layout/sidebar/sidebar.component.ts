import { CommonModule } from '@angular/common';
import { Component, HostListener, Input, ViewChild, inject } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatSidenavModule } from '@angular/material/sidenav';
import { FormsModule } from '@angular/forms';
import { MatTooltipModule } from '@angular/material/tooltip';
import { SearchContainerComponent } from '../../shared/components/search-container/search-container.component';

// Services
import { AnimationsService } from '../../shared/services/animations.service';
import { Remote } from '@app/types';
import { IconService } from 'src/app/shared/services/icon.service';
import { UiStateService } from '@app/services';

@Component({
  selector: 'app-sidebar',
  imports: [
    CommonModule,
    MatSidenavModule,
    MatCardModule,
    MatIconModule,
    FormsModule,
    MatTooltipModule,
    SearchContainerComponent,
  ],
  animations: [AnimationsService.slideToggle()],
  templateUrl: './sidebar.component.html',
  styleUrl: './sidebar.component.scss',
})
export class SidebarComponent {
  @Input() remotes: Remote[] = [];
  @Input() iconService!: IconService;
  // Previously emitted remoteSelected events here, now selection is managed via UiStateService

  // Expose the selected remote observable directly from UiStateService
  uiStateService = inject(UiStateService);
  selectedRemote$ = this.uiStateService.selectedRemote$;

  searchTerm = '';
  searchVisible = false;
  @ViewChild(SearchContainerComponent)
  searchContainer!: SearchContainerComponent;

  onSearchTextChange(searchText: string): void {
    this.searchTerm = searchText.trim().toLowerCase();
  }

  get filteredRemotes(): Remote[] {
    const term = this.searchTerm.trim().toLowerCase();
    if (!term) return this.remotes;
    return this.remotes.filter(
      remote =>
        remote.remoteSpecs.name.toLowerCase().includes(term) ||
        remote.remoteSpecs.type.toLowerCase().includes(term)
    );
  }

  selectRemote(remote: Remote): void {
    // propagate selection to global UI state so other components can react
    this.uiStateService.setSelectedRemote(remote);
  }

  @HostListener('document:keydown.control.f', ['$event'])
  onControlF(event: KeyboardEvent): void {
    event.preventDefault();
    this.toggleSearch();
    if (this.searchVisible && this.searchContainer) {
      this.searchContainer.focus();
    }
  }

  // No local subscription needed: template uses async pipe on `selectedRemote$`

  toggleSearch(): void {
    this.searchVisible = !this.searchVisible;
    if (!this.searchVisible) {
      this.clearSearch();
    }
  }

  clearSearch(): void {
    this.searchTerm = '';
    if (this.searchContainer) {
      this.searchContainer.clear();
    }
  }

  // Consolidated sync operations methods
  hasSyncOperations(remote: Remote): boolean {
    return !!(remote.syncState || remote.copyState || remote.moveState || remote.bisyncState);
  }

  isAnySyncOperationActive(remote: Remote): boolean {
    return !!(
      remote.syncState?.isOnSync ||
      remote.copyState?.isOnCopy ||
      remote.moveState?.isOnMove ||
      remote.bisyncState?.isOnBisync
    );
  }

  getActiveSyncOperationIcon(remote: Remote): string {
    // Return icon of the currently active operation, or default sync icon
    if (remote.syncState?.isOnSync) return 'refresh';
    if (remote.copyState?.isOnCopy) return 'copy';
    if (remote.moveState?.isOnMove) return 'move';
    if (remote.bisyncState?.isOnBisync) return 'right-left';
    return 'sync'; // Default icon for sync operations
  }

  getSyncOperationsTooltip(remote: Remote): string {
    const activeOperations: string[] = [];

    if (remote.syncState?.isOnSync) activeOperations.push('Syncing');
    if (remote.copyState?.isOnCopy) activeOperations.push('Copying');
    if (remote.moveState?.isOnMove) activeOperations.push('Moving');
    if (remote.bisyncState?.isOnBisync) activeOperations.push('BiSyncing');

    if (activeOperations.length > 0) {
      return activeOperations.join(', ');
    }

    // Show available operations when idle
    const availableOperations: string[] = [];
    if (remote.syncState) availableOperations.push('Sync');
    if (remote.copyState) availableOperations.push('Copy');
    if (remote.moveState) availableOperations.push('Move');
    if (remote.bisyncState) availableOperations.push('BiSync');

    return availableOperations.length > 0
      ? `${availableOperations.join(', ')} Available`
      : 'Sync Operations Available';
  }
}
