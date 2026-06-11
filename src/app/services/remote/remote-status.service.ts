import { Injectable, inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { Remote, RemoteStatus, RemoteOperationState, SyncOperationType } from '@app/types';

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
    const s = remote.status;
    return (
      Object.keys(s.sync.activeProfiles || {}).length +
      Object.keys(s.copy.activeProfiles || {}).length +
      Object.keys(s.move.activeProfiles || {}).length +
      Object.keys(s.bisync.activeProfiles || {}).length
    );
  }

  getActiveSyncOperationIcon(remote: Remote): string {
    const s = remote.status;
    return s.sync.active
      ? 'refresh'
      : s.copy.active
        ? 'copy'
        : s.move.active
          ? 'move'
          : s.bisync.active
            ? 'right-left'
            : 'sync';
  }

  getSyncOperationsTooltip(remote: Remote): string {
    const s = remote.status,
      details: string[] = [];
    const sy = Object.keys(s.sync.activeProfiles || {});
    if (sy.length)
      details.push(this.translate.instant('sync.syncWithProfile', { profiles: sy.join(', ') }));
    const cp = Object.keys(s.copy.activeProfiles || {});
    if (cp.length)
      details.push(this.translate.instant('sync.copyWithProfile', { profiles: cp.join(', ') }));
    const mv = Object.keys(s.move.activeProfiles || {});
    if (mv.length)
      details.push(this.translate.instant('sync.moveWithProfile', { profiles: mv.join(', ') }));
    const bi = Object.keys(s.bisync.activeProfiles || {});
    if (bi.length)
      details.push(this.translate.instant('sync.bisyncWithProfile', { profiles: bi.join(', ') }));
    return details.length ? details.join(' • ') : this.translate.instant('sync.available');
  }

  getOperationState(
    remote: Remote | undefined | null,
    type: SyncOperationType
  ): RemoteOperationState | undefined {
    return remote?.status[type as keyof RemoteStatus] as RemoteOperationState;
  }

  getActiveSyncOperationType(remote: Remote): 'sync' | 'copy' | 'move' | 'bisync' | null {
    const s = remote.status;
    return s.sync.active
      ? 'sync'
      : s.copy.active
        ? 'copy'
        : s.move.active
          ? 'move'
          : s.bisync.active
            ? 'bisync'
            : null;
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
        this.translate.instant('sync.syncSummary', { count: this.getSyncProfileCount(remote) })
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
      remote.status.sync.active ||
      remote.status.copy.active ||
      remote.status.move.active ||
      remote.status.bisync.active ||
      this.isServing(remote)
    );
  }
}
