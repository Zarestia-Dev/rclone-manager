import { Injectable, inject } from '@angular/core';
import { AbstractControl } from '@angular/forms';
import { RemoteManagementService } from './remote-management.service';
import { Entry } from '@app/types';

interface PathState {
  remoteName: string;
  currentPath: string;
  options: Entry[];
}

@Injectable({
  providedIn: 'root',
})
export class PathSelectionService {
  private readonly remoteManagementService = inject(RemoteManagementService);

  // Public path state accessible by components
  pathState: Record<string, PathState> = {};

  private loadingStates: Record<string, boolean> = {};
  private debounceTimers: Record<string, any> = {};

  /**
   * Get loading state for a specific form path
   */
  getLoadingState(formPath: string): boolean {
    return this.loadingStates[formPath] || false;
  }

  /**
   * Set loading state for a specific form path
   */
  private setLoadingState(formPath: string, isLoading: boolean): void {
    this.loadingStates[formPath] = isLoading;
  }

  /**
   * Handle remote selection (e.g., "remoteName:/")
   */
  async onRemoteSelected(
    formPath: string,
    remoteWithColon: string,
    control?: AbstractControl | null
  ): Promise<void> {
    const remoteName = remoteWithColon.replace(':/', '').trim();

    // Create a new state object instead of mutating
    this.pathState = {
      ...this.pathState,
      [formPath]: {
        remoteName,
        currentPath: '',
        options: [],
      },
    };

    // Fetch root entries
    await this.fetchEntriesForField(formPath, remoteName, '');

    // Update form control
    if (control) {
      control.setValue(''); // Set to empty string, as the full path is remoteName + :/ + path
    }
  }

  /**
   * Handle path selection within a remote
   */
  async onPathSelected(
    formPath: string,
    entryName: string,
    control?: AbstractControl | null
  ): Promise<void> {
    let state = this.pathState[formPath];
    if (!state || !state.remoteName) return;

    const selectedEntry = (state.options || []).find((e: Entry) => e.Name === entryName);
    if (!selectedEntry) return;

    // Build new path
    const newPath = state.currentPath ? `${state.currentPath}/${entryName}` : entryName;

    // Update current path by creating a new state
    state = { ...state, currentPath: newPath };
    this.pathState = { ...this.pathState, [formPath]: state };

    // Update form control with relative path
    if (control) {
      control.setValue(newPath);
    }

    // Only fetch new entries if the selected item is a directory
    if (selectedEntry.IsDir) {
      // Fetch entries for new path
      await this.fetchEntriesForField(formPath, state.remoteName, newPath);
    } else {
      // If it's a file, clear options as we can't navigate further (create new state)
      this.pathState = {
        ...this.pathState,
        [formPath]: { ...state, options: [] },
      };
    }
  }

  /**
   * Handle input changes with debouncing
   */
  onInputChanged(formPath: string, value: string): void {
    // Clear existing timer
    if (this.debounceTimers[formPath]) {
      clearTimeout(this.debounceTimers[formPath]);
    }

    // Don't fetch if no remote is selected
    const state = this.pathState[formPath];
    if (!state || !state.remoteName) return;

    // Debounce the fetch
    this.debounceTimers[formPath] = setTimeout(() => {
      // When input changes, we are searching relative to the remote root
      // So we update the currentPath to the new value (create new state)
      this.pathState = {
        ...this.pathState,
        [formPath]: { ...state, currentPath: value },
      };
      this.fetchEntriesForField(formPath, state.remoteName, value);
    }, 300);
  }

  /**
   * Fetch directory entries for a given path
   */
  async fetchEntriesForField(formPath: string, remoteName: string, path: string): Promise<void> {
    this.setLoadingState(formPath, true);

    console.log(`Fetching entries for ${formPath}: remote=${remoteName}, path=`, path);

    try {
      // The response from getRemotePaths is the object { list: [...] }
      const response = await this.remoteManagementService.getRemotePaths(
        remoteName,
        path || '',
        {}
      );

      // Get current state for this formPath, or create a default
      const currentState = this.pathState[formPath] || {
        remoteName,
        currentPath: path,
        options: [],
      };

      // Create a new state object
      this.pathState = {
        ...this.pathState,
        [formPath]: {
          ...currentState,
          remoteName,
          currentPath: path,
          options: response || [],
        },
      };

      console.log(this.pathState[formPath]);
    } catch (error) {
      console.error(`Error fetching entries for ${formPath}:`, error);
      if (this.pathState[formPath]) {
        this.pathState = {
          ...this.pathState,
          [formPath]: {
            ...this.pathState[formPath],
            options: [],
          },
        };
      }
    } finally {
      this.setLoadingState(formPath, false);
    }
  }

  /**
   * Reset path selection for a field
   */
  resetPathSelection(formPath: string): void {
    // Create new state object without the deleted key
    const newState = { ...this.pathState };
    delete newState[formPath];
    this.pathState = newState;

    this.setLoadingState(formPath, false);

    if (this.debounceTimers[formPath]) {
      clearTimeout(this.debounceTimers[formPath]);
      delete this.debounceTimers[formPath];
    }
  }

  /**
   * Clear all path states
   */
  clearAllStates(): void {
    this.pathState = {}; // This already creates a new reference, so it's fine
    this.loadingStates = {};

    Object.keys(this.debounceTimers).forEach(key => {
      clearTimeout(this.debounceTimers[key]);
    });
    this.debounceTimers = {};
  }

  /**
   * Initialize path state for edit mode
   * Parses existing paths and fetches entries if it's a remote path
   */
  async initializePathStateForEdit(formPath: string, existingPath: string): Promise<void> {
    if (!existingPath) return;

    // Check if it's a remote path
    const remoteMatch = existingPath.match(/^([^:]+):\/(.*)$/);
    if (!remoteMatch) return; // Local path, no initialization needed

    const remoteName = remoteMatch[1];
    const path = remoteMatch[2];

    // Initialize state by
    this.pathState = {
      ...this.pathState,
      [formPath]: {
        remoteName,
        currentPath: path,
        options: [],
      },
    };

    // Fetch entries for the path
    // We fetch based on the directory of the path to show options
    const lastSlash = path.lastIndexOf('/');
    const dirPath = lastSlash > -1 ? path.substring(0, lastSlash) : '';

    await this.fetchEntriesForField(formPath, remoteName, dirPath);

    // After fetching, ensure the currentPath is set back to the full original path
    if (this.pathState[formPath]) {
      this.pathState = {
        ...this.pathState,
        [formPath]: {
          ...this.pathState[formPath],
          currentPath: path,
        },
      };
    }
  }
}
