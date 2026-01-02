import { Injectable, inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { Remote, SyncOperationType } from '@app/types';

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
    if (!remote.mountState?.activeProfiles) return 0;
    return Object.keys(remote.mountState.activeProfiles).length;
  }

  isMounted(remote: Remote): boolean {
    return remote.mountState?.mounted === true;
  }

  getMountTooltip(remote: Remote): string {
    const profiles = remote.mountState?.activeProfiles;
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
    if (remote.syncState?.isOnSync) return 'refresh';
    if (remote.copyState?.isOnCopy) return 'copy';
    if (remote.moveState?.isOnMove) return 'move';
    if (remote.bisyncState?.isOnBisync) return 'right-left';
    return 'sync'; // Default icon
  }

  getSyncOperationsTooltip(remote: Remote): string {
    const activeDetails: string[] = [];

    if (remote.syncState?.activeProfiles) {
      const profiles = Object.keys(remote.syncState.activeProfiles);
      if (profiles.length > 0) {
        activeDetails.push(
          this.translate.instant('sync.syncWithProfile', { profiles: profiles.join(', ') })
        );
      }
    }
    if (remote.copyState?.activeProfiles) {
      const profiles = Object.keys(remote.copyState.activeProfiles);
      if (profiles.length > 0) {
        activeDetails.push(
          this.translate.instant('sync.copyWithProfile', { profiles: profiles.join(', ') })
        );
      }
    }
    if (remote.moveState?.activeProfiles) {
      const profiles = Object.keys(remote.moveState.activeProfiles);
      if (profiles.length > 0) {
        activeDetails.push(
          this.translate.instant('sync.moveWithProfile', { profiles: profiles.join(', ') })
        );
      }
    }
    if (remote.bisyncState?.activeProfiles) {
      const profiles = Object.keys(remote.bisyncState.activeProfiles);
      if (profiles.length > 0) {
        activeDetails.push(
          this.translate.instant('sync.bisyncWithProfile', { profiles: profiles.join(', ') })
        );
      }
    }

    if (activeDetails.length > 0) {
      return activeDetails.join(' • ');
    }

    return this.translate.instant('sync.available');
  }

  getOperationState(
    remote: Remote | undefined | null,
    type: SyncOperationType
  ): Record<string, unknown> | undefined {
    if (!remote) return undefined;
    const stateMap: Record<SyncOperationType, Record<string, unknown> | undefined> = {
      sync: remote.syncState,
      copy: remote.copyState,
      bisync: remote.bisyncState,
      move: remote.moveState,
    };
    return stateMap[type];
  }

  // ============================================================================
  // SERVE STATUS
  // ============================================================================

  getServeProfileCount(remote: Remote): number {
    return remote.serveState?.serves?.length || 0;
  }

  isServing(remote: Remote): boolean {
    return remote.serveState?.isOnServe === true;
  }

  getServeTooltip(remote: Remote): string {
    if (!remote.serveState || !remote.serveState.isOnServe) {
      return this.translate.instant('serve.noActive');
    }

    const serves = remote.serveState.serves || [];

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

    if (this.isAnySyncOperationActive(remote)) {
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
      this.isMounted(remote) || this.isAnySyncOperationActive(remote) || this.isServing(remote)
    );
  }
}
