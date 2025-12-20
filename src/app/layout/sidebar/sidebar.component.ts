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

  // ============================================================================
  // Mount Profile Methods
  // ============================================================================

  getMountProfileCount(remote: Remote): number {
    if (!remote.mountState?.activeProfiles) return 0;
    return Object.keys(remote.mountState.activeProfiles).length;
  }

  getMountTooltip(remote: Remote): string {
    const profiles = remote.mountState?.activeProfiles;
    if (!profiles || Object.keys(profiles).length === 0) {
      return 'Not Mounted';
    }

    const profileNames = Object.keys(profiles);
    if (profileNames.length === 1) {
      return `Mounted: ${profileNames[0]}`;
    }

    return `Mounted (${profileNames.length}): ${profileNames.join(', ')}`;
  }

  // ============================================================================
  // Sync Operations Methods
  // ============================================================================

  hasSyncOperations(remote: Remote): boolean {
    return !!(remote.syncState || remote.copyState || remote.moveState || remote.bisyncState);
  }

  isAnySyncOperationActive(remote: Remote): boolean {
    return !!(
      (remote.syncState?.activeProfiles &&
        Object.keys(remote.syncState.activeProfiles).length > 0) ||
      (remote.copyState?.activeProfiles &&
        Object.keys(remote.copyState.activeProfiles).length > 0) ||
      (remote.moveState?.activeProfiles &&
        Object.keys(remote.moveState.activeProfiles).length > 0) ||
      (remote.bisyncState?.activeProfiles &&
        Object.keys(remote.bisyncState.activeProfiles).length > 0)
    );
  }

  getSyncProfileCount(remote: Remote): number {
    let count = 0;
    if (remote.syncState?.activeProfiles)
      count += Object.keys(remote.syncState.activeProfiles).length;
    if (remote.copyState?.activeProfiles)
      count += Object.keys(remote.copyState.activeProfiles).length;
    if (remote.moveState?.activeProfiles)
      count += Object.keys(remote.moveState.activeProfiles).length;
    if (remote.bisyncState?.activeProfiles)
      count += Object.keys(remote.bisyncState.activeProfiles).length;
    return count;
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
    const activeDetails: string[] = [];

    // Build detailed profile info for each active operation
    if (remote.syncState?.activeProfiles) {
      const profiles = Object.keys(remote.syncState.activeProfiles);
      if (profiles.length > 0) {
        activeDetails.push(`Sync: ${profiles.join(', ')}`);
      }
    }
    if (remote.copyState?.activeProfiles) {
      const profiles = Object.keys(remote.copyState.activeProfiles);
      if (profiles.length > 0) {
        activeDetails.push(`Copy: ${profiles.join(', ')}`);
      }
    }
    if (remote.moveState?.activeProfiles) {
      const profiles = Object.keys(remote.moveState.activeProfiles);
      if (profiles.length > 0) {
        activeDetails.push(`Move: ${profiles.join(', ')}`);
      }
    }
    if (remote.bisyncState?.activeProfiles) {
      const profiles = Object.keys(remote.bisyncState.activeProfiles);
      if (profiles.length > 0) {
        activeDetails.push(`BiSync: ${profiles.join(', ')}`);
      }
    }

    if (activeDetails.length > 0) {
      return activeDetails.join(' • ');
    }

    return 'Sync Operations Available';
  }

  getServeProfileCount(remote: Remote): number {
    return remote.serveState?.serves?.length || 0;
  }

  getServeTooltip(remote: Remote): string {
    if (!remote.serveState || !remote.serveState.isOnServe) {
      return 'No active serves';
    }

    const serves = remote.serveState.serves || [];

    if (serves.length === 0) {
      return 'Serving';
    }

    if (serves.length === 1) {
      const serve = serves[0];
      const profileName = serve.profile || 'Default';
      return `Serving (${profileName}): ${serve.params.type.toUpperCase()} on ${serve.addr}`;
    }

    // Multiple serves - show profile names
    const serveInfo = serves.map(s => {
      const profile = s.profile || 'Default';
      return `${profile} (${s.params.type.toUpperCase()})`;
    });
    return `Serves (${serves.length}): ${serveInfo.join(', ')}`;
  }
}
