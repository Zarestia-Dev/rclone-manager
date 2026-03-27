import { Injectable, inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { Remote, RemoteStatus, RemoteOperationState, SyncOperationType } from '@app/types';

/**
 * Service for computing remote status information.
 * Consolidates tooltip generation and profile counting logic.
 */
@Injectable({
  providedIn: 'root',
})
export class RemoteStatusService {
  private translate = inject(TranslateService);

  // ============================================================================
  // MOUNT STATUS
  // ============================================================================

  getMountProfileCount(remote: Remote): number {
    if (!remote.status.mount.activeProfiles) return 0;
    return Object.keys(remote.status.mount.activeProfiles).length;
  }

  isMounted(remote: Remote): boolean {
    return remote.status.mount.active === true;
  }

  getMountTooltip(remote: Remote): string {
    const profiles = remote.status.mount.activeProfiles;
    if (!profiles || Object.keys(profiles).length === 0) {
      return this.translate.instant('mount.notMounted');
    }

    const profileNames = Object.keys(profiles);
    if (profileNames.length === 1) {
      return this.translate.instant('mount.mountedWithProfile', {
        profile: profileNames[0],
      });
    }

    return this.translate.instant('mount.mountedMultiple', {
      count: profileNames.length,
      profiles: profileNames.join(', '),
    });
  }

  // ============================================================================
  // SYNC OPERATIONS STATUS
  // ============================================================================

  getSyncProfileCount(remote: Remote): number {
    let count = 0;
    count += Object.keys(remote.status.sync.activeProfiles || {}).length;
    count += Object.keys(remote.status.copy.activeProfiles || {}).length;
    count += Object.keys(remote.status.move.activeProfiles || {}).length;
    count += Object.keys(remote.status.bisync.activeProfiles || {}).length;
    return count;
  }

  getActiveSyncOperationIcon(remote: Remote): string {
    if (remote.status.sync.active) return 'refresh';
    if (remote.status.copy.active) return 'copy';
    if (remote.status.move.active) return 'move';
    if (remote.status.bisync.active) return 'right-left';
    return 'sync'; // Default icon
  }

  getSyncOperationsTooltip(remote: Remote): string {
    const activeDetails: string[] = [];

    const syncProfiles = Object.keys(remote.status.sync.activeProfiles || {});
    if (syncProfiles.length > 0) {
      activeDetails.push(
        this.translate.instant('sync.syncWithProfile', { profiles: syncProfiles.join(', ') })
      );
    }
    const copyProfiles = Object.keys(remote.status.copy.activeProfiles || {});
    if (copyProfiles.length > 0) {
      activeDetails.push(
        this.translate.instant('sync.copyWithProfile', { profiles: copyProfiles.join(', ') })
      );
    }
    const moveProfiles = Object.keys(remote.status.move.activeProfiles || {});
    if (moveProfiles.length > 0) {
      activeDetails.push(
        this.translate.instant('sync.moveWithProfile', { profiles: moveProfiles.join(', ') })
      );
    }
    const bisyncProfiles = Object.keys(remote.status.bisync.activeProfiles || {});
    if (bisyncProfiles.length > 0) {
      activeDetails.push(
        this.translate.instant('sync.bisyncWithProfile', { profiles: bisyncProfiles.join(', ') })
      );
    }

    if (activeDetails.length > 0) {
      return activeDetails.join(' • ');
    }

    return this.translate.instant('sync.available');
  }

  getOperationState(
    remote: Remote | undefined | null,
    type: SyncOperationType
  ): RemoteOperationState | undefined {
    if (!remote) return undefined;
    return remote.status[type as keyof RemoteStatus] as RemoteOperationState;
  }

  getActiveSyncOperationType(remote: Remote): 'sync' | 'copy' | 'move' | 'bisync' | null {
    if (remote.status.sync.active) return 'sync';
    if (remote.status.copy.active) return 'copy';
    if (remote.status.move.active) return 'move';
    if (remote.status.bisync.active) return 'bisync';
    return null;
  }

  // ============================================================================
  // SERVE STATUS
  // ============================================================================

  getServeProfileCount(remote: Remote): number {
    return remote.status.serve.count || 0;
  }

  isServing(remote: Remote): boolean {
    return remote.status.serve.active === true;
  }

  getServeTooltip(remote: Remote): string {
    if (!remote.status.serve.active) {
      return this.translate.instant('serve.noActive');
    }

    const serves = remote.status.serve.serves || [];

    if (serves.length === 0) {
      return this.translate.instant('serve.serving');
    }

    if (serves.length === 1) {
      const serve = serves[0];
      const profileName = serve.profile || 'Default';
      return this.translate.instant('serve.servingWithProfile', {
        profile: profileName,
        type: serve.params.type.toUpperCase(),
        addr: serve.addr,
      });
    }

    // Multiple serves - show profile names
    const serveInfo = serves.map(s => {
      const profile = s.profile || 'Default';
      return this.translate.instant('serve.profileInfo', {
        profile: profile,
        type: s.params.type.toUpperCase(),
      });
    });

    return this.translate.instant('serve.servingMultiple', {
      count: serves.length,
      profiles: serveInfo.join(', '),
    });
  }

  // ============================================================================
  // COMBINED STATUS
  // ============================================================================

  getActiveOperationsSummary(remote: Remote): string[] {
    const summary: string[] = [];

    if (this.isMounted(remote)) {
      summary.push(
        this.translate.instant('mount.mountedMultiple', {
          count: this.getMountProfileCount(remote),
        })
      );
    }

    if (this.getActiveSyncOperationType(remote)) {
      summary.push(
        this.translate.instant('sync.syncSummary', { count: this.getSyncProfileCount(remote) })
      );
    }

    if (this.isServing(remote)) {
      summary.push(
        this.translate.instant('serve.serveSummary', { count: this.getServeProfileCount(remote) })
      );
    }

    return summary;
  }

  hasActiveOperations(remote: Remote): boolean {
    return (
      this.isMounted(remote) || !!this.getActiveSyncOperationType(remote) || this.isServing(remote)
    );
  }
}
