import { CommonModule } from '@angular/common';
import { Component, computed, HostListener, input, signal, ViewChild, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatTooltipModule } from '@angular/material/tooltip';
import { SearchContainerComponent } from '../../shared/components/search-container/search-container.component';

// Services
import { Remote } from '@app/types';
import { IconService } from 'src/app/shared/services/icon.service';
import { UiStateService } from '@app/services';

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

  getServeTooltip(remote: Remote): string {
    if (!remote.serveState || !remote.serveState.hasActiveServes) {
      return 'No active serves';
    }

    const count = remote.serveState.serveCount || 0;
    const serves = remote.serveState.serves || [];

    if (count === 1 && serves.length > 0) {
      const serve = serves[0];
      return `Serving via ${serve.params.type.toUpperCase()} on ${serve.addr}`;
    }

    return `${count} active serve${count !== 1 ? 's' : ''}`;
  }
}
