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

@Injectable({
  providedIn: 'root',
})
export class PathSelectionService {
  private readonly remoteOps = inject(RemoteFileOperationsService);
  private readonly pathService = inject(PathService);

  private readonly pathStates = new Map<string, WritableSignal<PathSelectionState>>();

  // ============================================================================
  // PUBLIC API
  // ============================================================================

  /**
   * Registers a field with the service, creating its state and returning an observable.
   * This is the new entry point for any component wanting to use the service.
   */
  public registerField(
    fieldId: string,
    remoteName: string,
    initialPath = ''
  ): WritableSignal<PathSelectionState> {
    const existingState = this.pathStates.get(fieldId);
    if (existingState) {
      return existingState;
    }

    const initialState: PathSelectionState = {
      id: fieldId,
      remoteName,
      currentPath: initialPath,
      options: [],
      isLoading: false,
    };

    const stateSignal = signal<PathSelectionState>(initialState);
    this.pathStates.set(fieldId, stateSignal);

    // Initial fetch of directory contents
    this.fetchEntries(fieldId, remoteName, initialPath);

    return stateSignal;
  }

  /**
   * Unregisters a field, cleaning up its state.
   */
  public unregisterField(fieldId: string): void {
    if (this.pathStates.has(fieldId)) {
      this.pathStates.delete(fieldId);
    }
  }

  /**
   * Handles user typing in the input field.
   */
  public updateInput(fieldId: string, value: string): void {
    const state = this.pathStates.get(fieldId)?.();
    if (!state) return;

    this.fetchEntries(fieldId, state.remoteName, value);
  }

  /**
   * Handles the selection of a directory from the dropdown.
   */
  public selectEntry(
    fieldId: string,
    entryName: string,
    formControl?: AbstractControl | null
  ): void {
    const state = this.pathStates.get(fieldId)?.();
    if (!state) return;

    const selectedEntry = state.options.find(e => e.Name === entryName);
    if (!selectedEntry) return;

    const newPath = this.pathService.joinPath(state.currentPath, entryName);

    if (formControl) {
      formControl.setValue(newPath);
    }

    if (selectedEntry.IsDir) {
      this.fetchEntries(fieldId, state.remoteName, newPath);
    }
  }

  /**
   * Navigates one level up in the directory structure.
   */
  public navigateUp(fieldId: string, formControl?: AbstractControl | null): void {
    const state = this.pathStates.get(fieldId)?.();
    if (!state) return;

    const parentPath = this.pathService.getParentPath(state.currentPath);

    if (formControl) {
      formControl.setValue(parentPath);
    }

    this.fetchEntries(fieldId, state.remoteName, parentPath);
  }

  // ============================================================================
  // INTERNAL LOGIC
  // ============================================================================

  private async fetchEntries(fieldId: string, remoteName: string, path: string): Promise<void> {
    const stateSignal = this.pathStates.get(fieldId);
    if (!stateSignal) return;

    // Set loading state
    stateSignal.update(s => ({ ...s, isLoading: true, currentPath: path }));

    try {
      // For local paths (empty remoteName), use '/' as the filesystem root
      // For remote paths, normalize with colon suffix
      const normalizedRemote =
        remoteName === '' ? '/' : this.pathService.normalizeRemoteForRclone(remoteName);
      const response = await this.remoteOps.getRemotePaths(
        normalizedRemote,
        path || '',
        {},
        'filemanager'
      );
      const entries = response && Array.isArray(response.list) ? response.list : [];
      // Update state with new entries
      stateSignal.update(s => ({ ...s, options: entries, isLoading: false }));
    } catch (error) {
      console.error(`Error fetching entries for ${fieldId}:`, error);
      stateSignal.update(s => ({ ...s, options: [], isLoading: false }));
    }
  }

  public resetPath(fieldId: string): void {
    const state = this.pathStates.get(fieldId)?.();
    if (!state) return;

    // Fetch entries for the root directory of the current remote
    this.fetchEntries(fieldId, state.remoteName, '');
  }
}
