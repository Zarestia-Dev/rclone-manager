import * as pathUtils from 'src/app/shared/utils/path.utils';
import { Injectable, inject, signal, WritableSignal, DestroyRef } from '@angular/core';
import { AbstractControl } from '@angular/forms';
import { RemoteFileOperationsService } from '../remote/remote-file-operations.service';
import { PathService } from '../infrastructure/platform/path.service';
import { BackendService } from '../infrastructure/system/backend.service';
import { RemoteManagementService } from '../remote/remote-management.service';
import { Entry } from '@app/types';

export interface PathSelectionState {
  id: string;
  remoteName: string;
  currentPath: string;
  options: Entry[];
  isLoading: boolean;
}

@Injectable({ providedIn: 'root' })
export class PathSelectionService {
  private readonly remoteOps = inject(RemoteFileOperationsService);
  private readonly pathService = inject(PathService);
  private readonly backendService = inject(BackendService);
  private readonly remoteManagement = inject(RemoteManagementService);

  private readonly pathStates = new Map<string, WritableSignal<PathSelectionState>>();
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly inputTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly activeLoads = new Map<string, Promise<void>>();
  private readonly queuedLoads = new Map<string, { remoteName: string; path: string | string[] }>();

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      for (const id of this.pathStates.keys()) this.unregisterField(id);
    });
  }

  private cancelLoad(fieldId: string): void {
    clearTimeout(this.inputTimers.get(fieldId));
    this.inputTimers.delete(fieldId);
    this.abortControllers.get(fieldId)?.abort();
    this.abortControllers.delete(fieldId);
    this.queuedLoads.delete(fieldId);
  }

  registerField(
    fieldId: string,
    remoteName: string,
    initialPath: string | string[] = ''
  ): WritableSignal<PathSelectionState> {
    const existing = this.pathStates.get(fieldId);
    if (existing) return existing;

    // FormControl.value can be string[] with multi-path forms — always coerce to string
    const path = pathUtils.getPrimaryPath(initialPath) ?? '';
    const stateSignal = signal<PathSelectionState>({
      id: fieldId,
      remoteName,
      currentPath: path,
      options: [],
      isLoading: false,
    });

    this.pathStates.set(fieldId, stateSignal);
    return stateSignal;
  }

  unregisterField(fieldId: string): void {
    this.cancelLoad(fieldId);
    this.pathStates.delete(fieldId);
  }

  triggerLoad(fieldId: string, remoteName: string, path: string): void {
    this.cancelLoad(fieldId);
    void this.fetchEntries(fieldId, remoteName, path);
  }

  updateInput(fieldId: string, value: string): void {
    const state = this.pathStates.get(fieldId)?.();
    this.cancelLoad(fieldId);
    if (!state) return;
    this.inputTimers.set(
      fieldId,
      setTimeout(() => {
        this.inputTimers.delete(fieldId);
        void this.fetchEntries(fieldId, state.remoteName, value);
      }, 250)
    );
  }

  selectEntry(fieldId: string, entryName: string, formControl?: AbstractControl | null): void {
    const state = this.pathStates.get(fieldId)?.();
    if (!state) return;

    const entry = state.options.find(e => e.Name === entryName);
    if (!entry) return;

    let newPath: string;
    if (state.remoteName) {
      newPath = state.currentPath
        ? `${state.currentPath.replace(/\/+$/, '')}/${entryName}`
        : entryName;
    } else if (this.backendService.isWindows() && !state.currentPath) {
      newPath = entry.Path;
    } else {
      newPath = this.pathService.getFullDisplayPath(
        { name: state.currentPath || '/', isLocal: true },
        entryName
      );
    }
    formControl?.setValue(
      !state.remoteName && this.backendService.isWindows()
        ? this.pathService.normalizeForPlatform(newPath)
        : newPath
    );

    if (entry.IsDir) this.triggerLoad(fieldId, state.remoteName, newPath);
  }

  navigateUp(fieldId: string, formControl?: AbstractControl | null): void {
    const state = this.pathStates.get(fieldId)?.();
    if (!state) return;

    const pathStyle = state.remoteName ? 'posix' : this.pathService.enginePathStyle();
    const parentPath = this.pathService.getParentPath(state.currentPath, pathStyle);
    formControl?.setValue(
      !state.remoteName && this.backendService.isWindows()
        ? this.pathService.normalizeForPlatform(parentPath)
        : parentPath
    );
    this.triggerLoad(fieldId, state.remoteName, parentPath);
  }

  resetPath(fieldId: string): void {
    this.cancelLoad(fieldId);
    const stateSignal = this.pathStates.get(fieldId);
    if (stateSignal) {
      stateSignal.update(s => ({
        ...s,
        currentPath: '',
        options: [],
        isLoading: false,
      }));
    }
  }

  private async fetchEntries(
    fieldId: string,
    remoteName: string,
    path: string | string[]
  ): Promise<void> {
    // IPC directory listings cannot be cancelled. Keep one transport per field
    // and replace queued work with the latest input while discarding stale results.
    if (this.activeLoads.has(fieldId)) {
      this.queuedLoads.set(fieldId, { remoteName, path });
      return;
    }
    const request = this.loadEntries(fieldId, remoteName, path);
    this.activeLoads.set(fieldId, request);
    try {
      await request;
    } finally {
      this.activeLoads.delete(fieldId);
      const queued = this.queuedLoads.get(fieldId);
      this.queuedLoads.delete(fieldId);
      if (queued && this.pathStates.has(fieldId)) {
        void this.fetchEntries(fieldId, queued.remoteName, queued.path);
      }
    }
  }

  private async loadEntries(
    fieldId: string,
    remoteName: string,
    rawPath: string | string[]
  ): Promise<void> {
    const stateSignal = this.pathStates.get(fieldId);
    if (!stateSignal) return;

    // FormControl.value can be string[] — coerce to a single string
    const path = pathUtils.getPrimaryPath(rawPath) ?? '';

    this.abortControllers.get(fieldId)?.abort();
    const controller = new AbortController();
    this.abortControllers.set(fieldId, controller);

    const isLocal = remoteName === '';

    if (isLocal && this.backendService.isWindows() && !path) {
      stateSignal.update(s => ({ ...s, remoteName, isLoading: true, currentPath: path }));
      try {
        const drives = await this.remoteManagement.getLocalDrives();
        if (controller.signal.aborted) return;

        const options: Entry[] = drives.map(drive => ({
          Name: drive.name,
          Path: drive.name,
          IsDir: true,
          Size: -1,
          ID: drive.id || drive.name,
          MimeType: 'inode/directory',
          ModTime: '',
        }));

        stateSignal.update(s => ({ ...s, options, isLoading: false }));
        return;
      } catch {
        if (controller.signal.aborted) return;
        stateSignal.update(s => ({ ...s, options: [], isLoading: false }));
        return;
      }
    }

    stateSignal.update(s => ({ ...s, remoteName, isLoading: true, currentPath: path }));

    try {
      let normalizedRemote = '/';
      let subPath = path;

      if (isLocal) {
        const split = this.pathService.splitLocalPath(path);
        normalizedRemote = split.remote || '/';
        subPath = this.backendService.isWindows()
          ? split.remainder.replace(/\\/g, '/')
          : split.remainder;
      } else {
        normalizedRemote = this.pathService.normalizeRemoteForRclone(remoteName);
      }

      const response = await this.remoteOps.getRemotePaths(
        normalizedRemote,
        subPath,
        {},
        'filemanager'
      );

      if (controller.signal.aborted) return;

      stateSignal.update(s => ({ ...s, options: response?.list ?? [], isLoading: false }));
    } catch {
      if (controller.signal.aborted) return;
      stateSignal.update(s => ({ ...s, options: [], isLoading: false }));
    }
  }
}
