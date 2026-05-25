import { Injectable, signal, inject, computed } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import {
  SharedProfileType,
  DEFAULT_PROFILE_NAME,
  REMOTE_CONFIG_KEYS,
  FLAG_TYPES,
} from '@app/types';
import { DialogData } from './remote-config-state.service';
import { JobManagementService } from '../operations/job-management.service';
import { MountManagementService } from '../operations/mount-management.service';
import { ServeManagementService } from '../operations/serve-management.service';
import { NotificationService } from '../ui/notification.service';

export type ProfileData = Record<string, unknown>;
export type ProfilesMap = Record<string, ProfileData>;

export interface StepConfig {
  readonly label: string;
  readonly icon: string;
  readonly type: string;
}

export const PROFILE_TYPES: SharedProfileType[] = [...FLAG_TYPES, 'runtimeRemote'];
export const LINKED_PROFILE_TYPES = new Set<string>([
  'mount',
  'serve',
  'sync',
  'copy',
  'move',
  'bisync',
]);
const JOB_TYPES = new Set<SharedProfileType>(['sync', 'copy', 'move', 'bisync']);

function profileRecord<T>(factory: () => T): Record<SharedProfileType, T> {
  return Object.fromEntries(PROFILE_TYPES.map(t => [t, factory()])) as Record<SharedProfileType, T>;
}

@Injectable()
export class RemoteConfigProfileManagerService {
  private readonly jobManagementService = inject(JobManagementService);
  private readonly mountManagementService = inject(MountManagementService);
  private readonly serveManagementService = inject(ServeManagementService);
  private readonly notificationService = inject(NotificationService);
  private readonly translate = inject(TranslateService);

  // ── Profile states ──
  readonly profileState = signal<
    Record<SharedProfileType, { mode: 'view' | 'edit' | 'add'; tempName: string }>
  >(profileRecord(() => ({ mode: 'view' as const, tempName: '' })));

  readonly profiles = signal<Record<SharedProfileType, ProfilesMap>>(
    profileRecord(() => ({}) as ProfilesMap)
  );

  readonly selectedProfileName = signal<Record<SharedProfileType, string>>(
    profileRecord(() => DEFAULT_PROFILE_NAME)
  );

  readonly highlightedFields = signal<
    { controlKey: string; flagType: SharedProfileType; profileName: string }[]
  >([]);

  readonly profileOptions = computed(() => {
    const p = this.profiles();
    const runtimeNames = Object.keys(p['runtimeRemote'] ?? {});
    return {
      vfs: Object.keys(p['vfs'] ?? {}),
      filter: Object.keys(p['filter'] ?? {}),
      backend: Object.keys(p['backend'] ?? {}),
      runtimeRemote: runtimeNames.length > 0 ? runtimeNames : [DEFAULT_PROFILE_NAME],
    };
  });

  readonly profileLists = computed(
    (): Record<SharedProfileType, { name: string; [key: string]: unknown }[]> =>
      Object.fromEntries(
        PROFILE_TYPES.map(t => [
          t,
          Object.entries(this.profiles()[t] ?? {}).map(([name, data]) => ({
            name,
            ...(data as object),
          })),
        ])
      ) as Record<SharedProfileType, { name: string; [key: string]: unknown }[]>
  );

  readonly profileNamesMap = computed(
    (): Record<SharedProfileType, string[]> =>
      Object.fromEntries(
        PROFILE_TYPES.map(t => [t, Object.keys(this.profiles()[t] ?? {})])
      ) as Record<SharedProfileType, string[]>
  );

  readonly highlightedFieldsForActiveProfiles = computed(() => {
    const activeHighlights = new Set<string>();
    const selectedProfiles = this.selectedProfileName();

    this.highlightedFields().forEach(h => {
      if (selectedProfiles[h.flagType] === h.profileName) {
        activeHighlights.add(h.controlKey);
      }
    });

    return activeHighlights;
  });

  initProfiles(
    dialogData: DialogData,
    autoAddProfile?: boolean,
    editTarget?: SharedProfileType
  ): void {
    const newProfiles = { ...this.profiles() };
    const newSelectedNames = { ...this.selectedProfileName() };

    PROFILE_TYPES.forEach(type => {
      const multiKey = REMOTE_CONFIG_KEYS[type as keyof typeof REMOTE_CONFIG_KEYS];
      const multiVal = dialogData?.existingConfig?.[multiKey] as
        | Record<string, unknown>
        | undefined;

      newProfiles[type] =
        multiVal && Object.keys(multiVal).length > 0
          ? ({ ...multiVal } as ProfilesMap)
          : { [DEFAULT_PROFILE_NAME]: {} };

      const profileNames = Object.keys(newProfiles[type]);
      const targetProfile = dialogData?.targetProfile;
      newSelectedNames[type] =
        targetProfile && profileNames.includes(targetProfile)
          ? targetProfile
          : (profileNames[0] ?? DEFAULT_PROFILE_NAME);
    });

    this.profiles.set(newProfiles);
    this.selectedProfileName.set(newSelectedNames);

    if (autoAddProfile && editTarget) {
      if (PROFILE_TYPES.includes(editTarget)) {
        this.startAddProfile(editTarget);
      }
    }
  }

  isRenameProfileDisabled(type: string, profileName: string, currentRemoteName: string): boolean {
    const t = type as SharedProfileType;
    if (!profileName || profileName.toLowerCase() === DEFAULT_PROFILE_NAME) return true;
    if (!JOB_TYPES.has(t)) return false;

    if (!currentRemoteName) return false;

    return this.getProfileUsage(t, currentRemoteName, profileName).inUse;
  }

  isDeleteProfileDisabled(type: string, profileName: string, currentRemoteName: string): boolean {
    const t = type as SharedProfileType;
    const profileList = this.profileLists()[t] ?? [];

    if (!profileName || profileName.toLowerCase() === DEFAULT_PROFILE_NAME) return true;
    if (profileList.length <= 1) return true;

    if (!JOB_TYPES.has(t) && t !== 'mount' && t !== 'serve') return false;

    if (!currentRemoteName) return false;

    return this.getProfileUsage(t, currentRemoteName, profileName).inUse;
  }

  getRenameProfileDisabledReason(
    type: string,
    profileName: string,
    currentRemoteName: string
  ): string {
    const t = type as SharedProfileType;

    if (!profileName || profileName.toLowerCase() === DEFAULT_PROFILE_NAME) {
      return this.translate.instant('modals.remoteConfig.profile.disabledReason.defaultProtected');
    }

    if (!JOB_TYPES.has(t)) return '';

    if (!currentRemoteName) return '';

    const usage = this.getProfileUsage(t, currentRemoteName, profileName);
    if (!usage.inUse) return '';

    return this.translate.instant('modals.remoteConfig.profile.disabledReason.inUse', {
      operation: this.getProfileUsageOperationLabel(t),
    });
  }

  getDeleteProfileDisabledReason(
    type: string,
    profileName: string,
    currentRemoteName: string
  ): string {
    const t = type as SharedProfileType;
    const profileList = this.profileLists()[t] ?? [];

    if (!profileName || profileName.toLowerCase() === DEFAULT_PROFILE_NAME) {
      return this.translate.instant('modals.remoteConfig.profile.disabledReason.defaultProtected');
    }

    if (profileList.length <= 1) {
      return this.translate.instant('modals.remoteConfig.profile.disabledReason.lastProfile');
    }

    if (!JOB_TYPES.has(t) && t !== 'mount' && t !== 'serve') return '';

    if (!currentRemoteName) return '';

    const usage = this.getProfileUsage(t, currentRemoteName, profileName);
    if (!usage.inUse) return '';

    return this.translate.instant('modals.remoteConfig.profile.disabledReason.inUse', {
      operation: this.getProfileUsageOperationLabel(t),
    });
  }

  getProfileUsage(
    type: SharedProfileType,
    remoteName: string,
    profileName: string
  ): { inUse: boolean; count: number; opType: string } {
    if (JOB_TYPES.has(type)) {
      const activeJobs = this.jobManagementService.getActiveJobsForRemote(remoteName, profileName);
      return { inUse: activeJobs.length > 0, count: activeJobs.length, opType: 'job' };
    }
    if (type === 'mount') {
      const activeMounts = this.mountManagementService.getMountsForRemoteProfile(
        remoteName,
        profileName
      );
      return { inUse: activeMounts.length > 0, count: activeMounts.length, opType: 'mount' };
    }
    if (type === 'serve') {
      const activeServes = this.serveManagementService.getServesForRemoteProfile(
        remoteName,
        profileName
      );
      return { inUse: activeServes.length > 0, count: activeServes.length, opType: 'serve' };
    }
    return { inUse: false, count: 0, opType: '' };
  }

  private getProfileUsageOperationLabel(type: SharedProfileType): string {
    if (JOB_TYPES.has(type)) return `${type} job`;
    if (type === 'mount') return 'mount';
    if (type === 'serve') return 'serve';
    return type;
  }

  startAddProfile(type: string): void {
    const t = type as SharedProfileType;
    const existingNames = Object.keys(this.profiles()[t] ?? {});
    let counter = 1;
    while (existingNames.includes(`profile-${counter}`)) counter++;
    this.setProfileMode(t, 'add', `profile-${counter}`);
  }

  startEditProfile(type: string): void {
    const t = type as SharedProfileType;
    const currentName = this.selectedProfileName()[t];
    if (!currentName || currentName.toLowerCase() === DEFAULT_PROFILE_NAME) return;
    this.setProfileMode(t, 'edit', currentName);
  }

  cancelProfileEdit(type: string): void {
    this.setProfileMode(type as SharedProfileType, 'view');
  }

  saveProfile(
    type: string,
    currentRemoteName: string,
    selectProfileFn: (type: SharedProfileType, name: string) => void
  ): void {
    const t = type as SharedProfileType;
    const state = this.profileState()[t];
    const newName = state.tempName.trim();
    if (!newName) return;

    if (state.mode === 'add') {
      this.profiles.update(p => ({ ...p, [t]: { ...p[t], [newName]: {} } }));
      selectProfileFn(t, newName);
    } else if (state.mode === 'edit') {
      const oldName = this.selectedProfileName()[t];
      if (oldName === newName) {
        this.cancelProfileEdit(t);
        return;
      }
      if (this.profiles()[t][newName] !== undefined) return;

      const profileData = this.profiles()[t][oldName];
      this.profiles.update(p => {
        const updated = { ...p, [t]: { ...p[t], [newName]: profileData } };
        delete updated[t][oldName];
        return updated;
      });
      this.selectedProfileName.update(s => ({ ...s, [t]: newName }));
      this.cascadeProfileRename(t, oldName, newName, currentRemoteName);
    }
    this.setProfileMode(t, 'view');
  }

  deleteProfile(
    type: string,
    name: string,
    currentRemoteName: string,
    selectProfileFn: (type: SharedProfileType, name: string) => void
  ): void {
    const t = type as SharedProfileType;
    if (name.toLowerCase() === DEFAULT_PROFILE_NAME) return;

    if (currentRemoteName) {
      const usage = this.getProfileUsage(t, currentRemoteName, name);
      if (usage.inUse) {
        this.notificationService.showWarning(
          this.translate.instant('modals.remoteConfig.profile.inUseWarning', {
            name,
            count: usage.count,
            type: usage.opType,
          })
        );
        return;
      }
    }

    this.profiles.update(p => {
      const rest = { ...p[t] };
      delete rest[name];
      return { ...p, [t]: rest };
    });

    if (this.selectedProfileName()[t] === name) {
      const remaining = Object.keys(this.profiles()[t] ?? {});
      if (remaining.length > 0) {
        selectProfileFn(t, remaining[0]);
      } else {
        this.profiles.update(p => ({ ...p, [t]: { [DEFAULT_PROFILE_NAME]: {} } }));
        selectProfileFn(t, DEFAULT_PROFILE_NAME);
      }
    }
  }

  setProfileTempName(type: string, name: string): void {
    this.profileState.update(prev => ({
      ...prev,
      [type]: { ...prev[type as SharedProfileType], tempName: name },
    }));
  }

  setProfileMode(type: SharedProfileType, mode: 'view' | 'edit' | 'add', tempName = ''): void {
    this.profileState.update(prev => ({
      ...prev,
      [type]: { mode, tempName },
    }));
  }

  private cascadeProfileRename(
    type: SharedProfileType,
    oldName: string,
    newName: string,
    currentRemoteName: string
  ): void {
    if (!currentRemoteName) return;

    const onResult = (n: number): void => {
      if (n > 0) console.debug(`Updated ${n} ${type}(s) with new profile name: ${newName}`);
    };
    const onError = (err: unknown): void =>
      console.warn(`Failed to update ${type}s with new profile name:`, err);

    const handlers: Partial<Record<string, () => Promise<number>>> = {
      mount: () =>
        this.mountManagementService.renameProfileInMountCache(currentRemoteName, oldName, newName),
      serve: () =>
        this.serveManagementService.renameProfileInServeCache(currentRemoteName, oldName, newName),
    };
    handlers[type]?.().then(onResult).catch(onError);
  }

  highlightField(key: string, flagType: SharedProfileType, profileName: string): void {
    this.highlightedFields.update(list => {
      if (
        list.some(
          h => h.controlKey === key && h.flagType === flagType && h.profileName === profileName
        )
      ) {
        return list;
      }
      return [...list, { controlKey: key, flagType, profileName }];
    });
  }

  updateProfileConfig(
    type: SharedProfileType,
    name: string,
    config: Record<string, unknown>
  ): void {
    this.profiles.update(p => ({
      ...p,
      [type]: {
        ...p[type],
        [name]: config,
      },
    }));
  }
}
