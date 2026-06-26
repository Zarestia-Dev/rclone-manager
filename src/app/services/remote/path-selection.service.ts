import { Injectable, inject, signal, WritableSignal } from '@angular/core';
import { AbstractControl } from '@angular/forms';
import { RemoteFileOperationsService } from '../remote/remote-file-operations.service';
import { PathService } from '../infrastructure/platform/path.service';
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

  private readonly pathStates = new Map<string, WritableSignal<PathSelectionState>>();
  private readonly abortControllers = new Map<string, AbortController>();

  registerField(
    fieldId: string,
    remoteName: string,
    initialPath: string | string[] = ''
  ): WritableSignal<PathSelectionState> {
    const existing = this.pathStates.get(fieldId);
    if (existing) return existing;

    // FormControl.value can be string[] with multi-path forms — always coerce to string
    const path = this.pathService.getPrimaryPath(initialPath) ?? '';
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
    this.abortControllers.get(fieldId)?.abort();
    this.abortControllers.delete(fieldId);
    this.pathStates.delete(fieldId);
  }

  triggerLoad(fieldId: string, remoteName: string, path: string): void {
    this.fetchEntries(fieldId, remoteName, path);
  }

  updateInput(fieldId: string, value: string): void {
    const state = this.pathStates.get(fieldId)?.();
    if (state) this.fetchEntries(fieldId, state.remoteName, value);
  }

  selectEntry(fieldId: string, entryName: string, formControl?: AbstractControl | null): void {
    const state = this.pathStates.get(fieldId)?.();
    if (!state) return;

    const entry = state.options.find(e => e.Name === entryName);
    if (!entry) return;

    const newPath = this.pathService.joinPath(state.currentPath, entryName);
    formControl?.setValue(newPath);

    if (entry.IsDir) this.fetchEntries(fieldId, state.remoteName, newPath);
  }

  navigateUp(fieldId: string, formControl?: AbstractControl | null): void {
    const state = this.pathStates.get(fieldId)?.();
    if (!state) return;

    const parentPath = this.pathService.getParentPath(state.currentPath);
    formControl?.setValue(parentPath);
    this.fetchEntries(fieldId, state.remoteName, parentPath);
  }

  resetPath(fieldId: string): void {
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
    rawPath: string | string[]
  ): Promise<void> {
    const stateSignal = this.pathStates.get(fieldId);
    if (!stateSignal) return;

    // FormControl.value can be string[] — coerce to a single string
    const path = this.pathService.getPrimaryPath(rawPath) ?? '';

    this.abortControllers.get(fieldId)?.abort();
    const controller = new AbortController();
    this.abortControllers.set(fieldId, controller);

    stateSignal.update(s => ({ ...s, isLoading: true, currentPath: path }));

    try {
      const normalizedRemote =
        remoteName === '' ? '/' : this.pathService.normalizeRemoteForRclone(remoteName);
      const response = await this.remoteOps.getRemotePaths(
        normalizedRemote,
        path,
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
