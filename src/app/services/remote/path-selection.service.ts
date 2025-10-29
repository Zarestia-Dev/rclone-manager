import { Injectable, inject } from '@angular/core';
import { AbstractControl } from '@angular/forms';
import { BehaviorSubject, Observable } from 'rxjs';
import { RemoteManagementService } from './remote-management.service';
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
  private readonly remoteManagementService = inject(RemoteManagementService);

  private readonly pathStates = new Map<string, BehaviorSubject<PathSelectionState>>();
  private readonly debounceTimers = new Map<string, any>();

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
  ): Observable<PathSelectionState> {
    if (this.pathStates.has(fieldId)) {
      return this.pathStates.get(fieldId)!.asObservable();
    }

    const initialState: PathSelectionState = {
      id: fieldId,
      remoteName,
      currentPath: initialPath,
      options: [],
      isLoading: false,
    };

    const state$ = new BehaviorSubject<PathSelectionState>(initialState);
    this.pathStates.set(fieldId, state$);

    // Initial fetch of directory contents
    this.fetchEntries(fieldId, remoteName, initialPath);

    return state$.asObservable();
  }

  /**
   * Unregisters a field, cleaning up its state and timers.
   */
  public unregisterField(fieldId: string): void {
    if (this.debounceTimers.has(fieldId)) {
      clearTimeout(this.debounceTimers.get(fieldId));
      this.debounceTimers.delete(fieldId);
    }
    if (this.pathStates.has(fieldId)) {
      this.pathStates.get(fieldId)?.complete();
      this.pathStates.delete(fieldId);
    }
  }

  /**
   * Handles user typing in the input field, with debouncing.
   */
  public updateInput(fieldId: string, value: string): void {
    if (this.debounceTimers.has(fieldId)) {
      clearTimeout(this.debounceTimers.get(fieldId));
    }

    const state = this.pathStates.get(fieldId)?.getValue();
    if (!state) return;

    this.debounceTimers.set(
      fieldId,
      setTimeout(() => {
        this.fetchEntries(fieldId, state.remoteName, value);
      }, 300)
    );
  }

  /**
   * Handles the selection of a directory from the dropdown.
   */
  public selectEntry(
    fieldId: string,
    entryName: string,
    formControl?: AbstractControl | null
  ): void {
    const state = this.pathStates.get(fieldId)?.getValue();
    if (!state) return;

    const selectedEntry = state.options.find(e => e.Name === entryName);
    if (!selectedEntry || !selectedEntry.IsDir) return; // Only navigate into directories

    const newPath = this.joinPath(state.currentPath, entryName);

    if (formControl) {
      formControl.setValue(newPath);
    }

    this.fetchEntries(fieldId, state.remoteName, newPath);
  }

  /**
   * Navigates one level up in the directory structure.
   */
  public navigateUp(fieldId: string, formControl?: AbstractControl | null): void {
    const state = this.pathStates.get(fieldId)?.getValue();
    if (!state) return;

    const parentPath = this.getParentPath(state.currentPath);

    if (formControl) {
      formControl.setValue(parentPath);
    }

    this.fetchEntries(fieldId, state.remoteName, parentPath);
  }

  // ============================================================================
  // INTERNAL LOGIC
  // ============================================================================

  private async fetchEntries(fieldId: string, remoteName: string, path: string): Promise<void> {
    const state$ = this.pathStates.get(fieldId);
    if (!state$) return;

    // Set loading state
    state$.next({ ...state$.getValue(), isLoading: true, currentPath: path });

    try {
      const response = await this.remoteManagementService.getRemotePaths(
        remoteName,
        path || '',
        {}
      );
      const entries = response && Array.isArray(response.list) ? response.list : [];
      // Update state with new entries
      state$.next({ ...state$.getValue(), options: entries, isLoading: false });
    } catch (error) {
      console.error(`Error fetching entries for ${fieldId}:`, error);
      state$.next({ ...state$.getValue(), options: [], isLoading: false });
    }
  }

  public resetPath(fieldId: string): void {
    const state = this.pathStates.get(fieldId)?.getValue();
    if (!state) return;

    // Fetch entries for the root directory of the current remote
    this.fetchEntries(fieldId, state.remoteName, '');
  }

  private getParentPath(path: string): string {
    if (!path || path === '/') return '';
    const parts = path.split('/').filter(p => p);
    parts.pop();
    return parts.join('/');
  }

  private joinPath(base: string, part: string): string {
    if (!base || base === '/') return part;
    return `${base}/${part}`;
  }
}
