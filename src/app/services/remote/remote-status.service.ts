import { Injectable, inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import {
  Remote,
  RemoteStatus,
  RemoteOperationState,
  SyncOperationType,
  SYNC_TYPES,
  OPERATION_ICONS,
} from '@app/types';

@Injectable({ providedIn: 'root' })
export class RemoteStatusService {
  private readonly translate = inject(TranslateService);

  getMountProfileCount(remote: Remote): number {
    return remote.status.mount.activeProfiles
      ? Object.keys(remote.status.mount.activeProfiles).length
      : 0;
  }

  isMounted(remote: Remote): boolean {
    return remote.status.mount.active === true;
  }

  getMountTooltip(remote: Remote): string {
    const p = remote.status.mount.activeProfiles;
    if (!p) return this.translate.instant('mount.notMounted');
    const names = Object.keys(p);
    if (names.length === 0) return this.translate.instant('mount.notMounted');
    if (names.length === 1)
      return this.translate.instant('mount.mountedWithProfile', { profile: names[0] });
    return this.translate.instant('mount.mountedMultiple', {
      count: names.length,
      profiles: names.join(', '),
    });
  }

  getSyncProfileCount(remote: Remote): number {
    return SYNC_TYPES.reduce((count, type) => {
      const state = remote.status[type as keyof RemoteStatus] as RemoteOperationState | undefined;
      return count + Object.keys(state?.activeProfiles || {}).length;
    }, 0);
  }

  getActiveSyncOperationIcon(remote: Remote): string {
    for (const type of SYNC_TYPES) {
      const state = remote.status[type as keyof RemoteStatus] as RemoteOperationState | undefined;
      if (state?.active) {
        return OPERATION_ICONS[type] || 'sync';
      }
    }
    return 'sync';
  }

  getSyncOperationsTooltip(remote: Remote): string {
    const details: string[] = [];
    for (const type of SYNC_TYPES) {
      const state = remote.status[type as keyof RemoteStatus] as RemoteOperationState | undefined;
      const profiles = Object.keys(state?.activeProfiles || {});
      if (profiles.length) {
        details.push(
          this.translate.instant(`operations.${type}WithProfile`, { profiles: profiles.join(', ') })
        );
      }
    }
    return details.length ? details.join(' • ') : this.translate.instant('operations.available');
  }

  getOperationState(
    remote: Remote | undefined | null,
    type: SyncOperationType
  ): RemoteOperationState | undefined {
    return remote?.status[type as keyof RemoteStatus] as RemoteOperationState;
  }

  getActiveSyncOperationType(remote: Remote): SyncOperationType | null {
    for (const type of SYNC_TYPES) {
      const state = remote.status[type as keyof RemoteStatus] as RemoteOperationState | undefined;
      if (state?.active) {
        return type;
      }
    }
    return null;
  }

  getServeProfileCount(remote: Remote): number {
    return remote.status.serve.count || 0;
  }
  isServing(remote: Remote): boolean {
    return remote.status.serve.active === true;
  }

  getServeTooltip(remote: Remote): string {
    if (!remote.status.serve.active) return this.translate.instant('serve.noActive');
    const serves = remote.status.serve.serves || [];
    if (serves.length === 0) return this.translate.instant('serve.serving');
    if (serves.length === 1)
      return this.translate.instant('serve.servingWithProfile', {
        profile: serves[0].profile || 'Default',
        type: serves[0].params.type.toUpperCase(),
        addr: serves[0].addr,
      });
    return this.translate.instant('serve.servingMultiple', {
      count: serves.length,
      profiles: serves
        .map(s =>
          this.translate.instant('serve.profileInfo', {
            profile: s.profile || 'Default',
            type: s.params.type.toUpperCase(),
          })
        )
        .join(', '),
    });
  }

  getActiveOperationsSummary(remote: Remote): string[] {
    const summary: string[] = [];
    if (this.isMounted(remote))
      summary.push(
        this.translate.instant('mount.mountedMultiple', {
          count: this.getMountProfileCount(remote),
        })
      );
    if (this.getActiveSyncOperationType(remote))
      summary.push(
        this.translate.instant('operations.syncSummary', {
          count: this.getSyncProfileCount(remote),
        })
      );
    if (this.isServing(remote))
      summary.push(
        this.translate.instant('serve.serveSummary', { count: this.getServeProfileCount(remote) })
      );
    return summary;
  }

  hasActiveOperations(remote: Remote): boolean {
    return (
      this.isMounted(remote) ||
      this.isServing(remote) ||
      SYNC_TYPES.some(type => {
        const state = remote.status[type as keyof RemoteStatus] as RemoteOperationState | undefined;
        return !!state?.active;
      })
    );
  }
}
