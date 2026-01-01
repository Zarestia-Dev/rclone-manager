import { Remote, SyncOperationType } from '@app/types';

/**
 * Utility class for computing remote status information.
 * Consolidates tooltip generation and profile counting logic
 * that was previously duplicated across multiple components.
 */
export class RemoteStatusHelper {
  // ============================================================================
  // MOUNT STATUS
  // ============================================================================

  /**
   * Get the count of active mount profiles for a remote
   */
  static getMountProfileCount(remote: Remote): number {
    if (!remote.mountState?.activeProfiles) return 0;
    return Object.keys(remote.mountState.activeProfiles).length;
  }

  /**
   * Check if a remote is currently mounted
   */
  static isMounted(remote: Remote): boolean {
    return remote.mountState?.mounted === true;
  }

  /**
   * Generate a tooltip describing the mount status of a remote
   */
  static getMountTooltip(remote: Remote): string {
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
  // SYNC OPERATIONS STATUS
  // ============================================================================

  /**
   * Check if a remote has any sync operation configurations
   */
  static hasSyncOperations(remote: Remote): boolean {
    return !!(remote.syncState || remote.copyState || remote.moveState || remote.bisyncState);
  }

  /**
   * Check if any sync operation is currently active on a remote
   */
  static isAnySyncOperationActive(remote: Remote): boolean {
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

  /**
   * Get total count of active sync profiles across all operation types
   */
  static getSyncProfileCount(remote: Remote): number {
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

  /**
   * Get the icon for the currently active sync operation
   */
  static getActiveSyncOperationIcon(remote: Remote): string {
    if (remote.syncState?.isOnSync) return 'refresh';
    if (remote.copyState?.isOnCopy) return 'copy';
    if (remote.moveState?.isOnMove) return 'move';
    if (remote.bisyncState?.isOnBisync) return 'right-left';
    return 'sync'; // Default icon
  }

  /**
   * Generate a detailed tooltip for sync operations status
   */
  static getSyncOperationsTooltip(remote: Remote): string {
    const activeDetails: string[] = [];

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

  /**
   * Get the operation state for a specific sync operation type
   */
  static getOperationState(
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

  /**
   * Get the count of active serve profiles for a remote
   */
  static getServeProfileCount(remote: Remote): number {
    return remote.serveState?.serves?.length || 0;
  }

  /**
   * Check if a remote is currently serving
   */
  static isServing(remote: Remote): boolean {
    return remote.serveState?.isOnServe === true;
  }

  /**
   * Generate a tooltip describing the serve status of a remote
   */
  static getServeTooltip(remote: Remote): string {
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

  // ============================================================================
  // COMBINED STATUS
  // ============================================================================

  /**
   * Get a summary of all active operations on a remote
   */
  static getActiveOperationsSummary(remote: Remote): string[] {
    const summary: string[] = [];

    if (this.isMounted(remote)) {
      summary.push(`Mounted (${this.getMountProfileCount(remote)})`);
    }

    if (this.isAnySyncOperationActive(remote)) {
      summary.push(`Syncing (${this.getSyncProfileCount(remote)})`);
    }

    if (this.isServing(remote)) {
      summary.push(`Serving (${this.getServeProfileCount(remote)})`);
    }

    return summary;
  }

  /**
   * Check if a remote has any active operations
   */
  static hasActiveOperations(remote: Remote): boolean {
    return (
      this.isMounted(remote) || this.isAnySyncOperationActive(remote) || this.isServing(remote)
    );
  }
}
