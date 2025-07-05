import { inject, Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { AbstractControl } from '@angular/forms';
import { RemoteManagementService } from './remote-management.service';
import { Entry } from '../../shared/remote-config/remote-config-types';

@Injectable({
  providedIn: 'root',
})
export class PathSelectionService {
  private remoteManagementService = inject(RemoteManagementService);
  private pathStates: Record<
    string,
    { remoteName: string; currentPath: string; options: Entry[] }
  > = {};

  private loadingStates: Record<string, BehaviorSubject<boolean>> = {};

  async fetchEntriesForField(formPath: string, remoteName: string, path: string): Promise<void> {
    // Don't fetch if no remote name is provided
    if (!remoteName || remoteName.trim() === '') {
      this.setLoading(formPath, false);
      return;
    }

    this.setLoading(formPath, true);
    try {
      const cleanPath = this.cleanPath(path, remoteName);
      const response = await this.remoteManagementService.getRemotePaths(
        remoteName,
        cleanPath || '',
        {}
      );

      this.ensurePathState(formPath, remoteName);
      this.pathStates[formPath].currentPath = cleanPath;
      this.pathStates[formPath].options = response.list || [];
    } catch (error) {
      console.error(`Failed to fetch entries for ${remoteName}:`, error);
      // Reset path state on error to avoid stuck state
      this.resetPathSelection(formPath);
    } finally {
      this.setLoading(formPath, false);
    }
  }

  get getPathState(): Record<
    string,
    { remoteName: string; currentPath: string; options: Entry[] }
  > {
    console.log('Current path states:', this.pathStates);

    return this.pathStates;
  }

  getLoadingState(formPath: string): boolean {
    if (!this.loadingStates[formPath]) {
      this.loadingStates[formPath] = new BehaviorSubject<boolean>(false);
    }
    return this.loadingStates[formPath].getValue();
  }

  async onPathSelected(
    formPath: string,
    entryName: string,
    control: AbstractControl | null = null
  ): Promise<void> {
    const state = this.pathStates[formPath];
    if (!state) return;

    const selectedEntry = state.options.find(e => e.Name === entryName);
    if (!selectedEntry) return;

    const fullPath = state.currentPath
      ? `${state.currentPath}/${selectedEntry.Name}`
      : selectedEntry.Name;

    // Always include remote prefix for source paths
    const remotePath = `${state.remoteName}:/${fullPath}`;

    if (selectedEntry.IsDir) {
      state.currentPath = fullPath;
      control?.setValue(remotePath);
      await this.fetchEntriesForField(formPath, state.remoteName, fullPath);
    } else {
      state.currentPath = fullPath;
      state.options = [];
      this.setLoading(formPath, false);
      control?.setValue(remotePath);
    }
  }

  async onRemoteSelected(
    formPath: string,
    remoteWithColon: string,
    control: AbstractControl | null = null
  ): Promise<void> {
    const [remote] = remoteWithColon.split(':');
    this.ensurePathState(formPath, remote);
    this.pathStates[formPath].remoteName = remote;
    this.pathStates[formPath].currentPath = '';

    // Default to remote:/ when selecting a remote
    const remotePath = `${remote}:/`;
    if (control) {
      control.setValue(remotePath);
    }

    await this.fetchEntriesForField(formPath, remote, '');
  }

  resetPathSelection(formPath: string): void {
    // Instead of setting empty values, delete the path state entirely
    // This ensures the template conditions work correctly
    delete this.pathStates[formPath];
  }

  private ensurePathState(formPath: string, remoteName = ''): void {
    if (!this.pathStates[formPath]) {
      this.pathStates[formPath] = { remoteName, currentPath: '', options: [] };
    }
  }

  private cleanPath(path: string, remoteName: string): string {
    let cleanPath = path;

    if (cleanPath.startsWith(`${remoteName}:/`)) {
      cleanPath = cleanPath.slice(`${remoteName}:/`.length);
    }
    cleanPath = cleanPath.replace(/^\/+/, '').replace(/\/+$/, '');

    return cleanPath;
  }

  private setLoading(formPath: string, isLoading: boolean): void {
    if (!this.loadingStates[formPath]) {
      this.loadingStates[formPath] = new BehaviorSubject<boolean>(isLoading);
    } else {
      this.loadingStates[formPath].next(isLoading);
    }
  }

  async onInputChanged(formPath: string, value: string): Promise<void> {
    const state = this.pathStates[formPath];
    const cleanedPath = value?.trim() ?? '';

    if (!this.shouldReloadOnPathChange(cleanedPath, state?.currentPath ?? '')) {
      return;
    }
    if (cleanedPath === '') {
      // If input is cleared and no remote is selected, reset the path state completely
      if (!state?.remoteName) {
        this.resetPathSelection(formPath);
        return;
      }
      await this.fetchEntriesForField(formPath, state.remoteName, '');
      return;
    }
    if (cleanedPath.includes(':/')) {
      const [remote, ...pathParts] = cleanedPath.split(/:\/?/);
      const path = pathParts.join('/');
      await this.fetchEntriesForField(formPath, remote, path);
    } else {
      await this.fetchEntriesForField(formPath, state?.remoteName ?? '', cleanedPath);
    }
  }

  private shouldReloadOnPathChange(newPath: string, currentPath: string): boolean {
    // Reload when input is cleared
    if (newPath === '') return true;

    // Always reload on remote change (contains :/)
    if (newPath.includes(':/')) return true;

    // Reload when trailing slash is added (directory navigation)
    if (newPath.endsWith('/')) return true;

    // Don't reload if path hasn't actually changed
    if (newPath === currentPath) return false;

    // For other cases, only reload if the path exists in our current options
    const pathParts = newPath.split('/').filter(Boolean);
    const parentPath = pathParts.slice(0, -1).join('/');
    return parentPath === currentPath;
  }
}
