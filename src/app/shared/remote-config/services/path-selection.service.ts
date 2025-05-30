import { Injectable } from "@angular/core";
import { RcloneService } from "../../../services/rclone.service";
import { BehaviorSubject } from "rxjs";
import { Entry } from "../remote-config-types";
import { AbstractControl } from "@angular/forms";

@Injectable({
  providedIn: "root",
})
export class PathSelectionService {
  private pathStates: Record<
    string,
    { remoteName: string; currentPath: string; options: Entry[] }
  > = {};

  private loadingStates: Record<string, BehaviorSubject<boolean>> = {};

  constructor(private rcloneService: RcloneService) {}

  async fetchEntriesForField(
    formPath: string,
    remoteName: string,
    path: string
  ): Promise<void> {
    this.setLoading(formPath, true);
    try {
      let cleanPath = this.cleanPath(path, remoteName);
      const options = await this.rcloneService.getRemotePaths(
        remoteName,
        cleanPath || "",
        {}
      );

      this.ensurePathState(formPath, remoteName);
      this.pathStates[formPath].currentPath = cleanPath;
      this.pathStates[formPath].options = options;
    } finally {
      this.setLoading(formPath, false);
    }
  }

  get getPathState() {
    return this.pathStates;
  }

  getLoadingState(formPath: string) {
    if (!this.loadingStates[formPath]) {
      this.loadingStates[formPath] = new BehaviorSubject<boolean>(false);
    }
    return this.loadingStates[formPath].getValue();
  }

  async onPathSelected(
    formPath: string,
    entryName: string,
    control: AbstractControl | null = null,
    isDestination: boolean = false
  ): Promise<void> {
    const state = this.pathStates[formPath];
    if (!state) return;

    const selectedEntry = state.options.find((e) => e.Name === entryName);
    if (!selectedEntry) return;

    const fullPath = state.currentPath
      ? `${state.currentPath}/${selectedEntry.Name}`
      : selectedEntry.Name;

    let remotePath = "";
    if (isDestination) {
      // Fix for destination path - include the selected entry in the path
      remotePath = `${state.remoteName}:/${fullPath}`;
    } else {
      remotePath = `${fullPath}`;
    }

    if (selectedEntry.IsDir) {
      state.currentPath = fullPath;
      control?.setValue(remotePath);
      await this.fetchEntriesForField(formPath, state.remoteName, fullPath);
    } else {
      control?.setValue(remotePath);
    }
  }

  async onRemoteSelected(
    formPath: string,
    remoteWithColon: string,
    control: AbstractControl | null = null
  ): Promise<void> {
    const [remote] = remoteWithColon.split(":");
    this.ensurePathState(formPath, remote);
    this.pathStates[formPath].remoteName = remote;
    this.pathStates[formPath].currentPath = "";

    const remotePath = `${remote}:/`;
    if (control) {
      control.setValue(remotePath);
    }

    await this.fetchEntriesForField(formPath, remote, "");
  }

  resetPathSelection(formPath: string): void {
    this.pathStates[formPath] = {
      remoteName: "",
      currentPath: "",
      options: [],
    };
  }

  private ensurePathState(formPath: string, remoteName: string = "") {
    if (!this.pathStates[formPath]) {
      this.pathStates[formPath] = { remoteName, currentPath: "", options: [] };
    }
  }

  private cleanPath(path: string, remoteName: string): string {
    let cleanPath = path;

    if (cleanPath.startsWith(`${remoteName}:/`)) {
      cleanPath = cleanPath.slice(`${remoteName}:/`.length);
    }
    cleanPath = cleanPath.replace(/^\/+/, "").replace(/\/+$/, "");

    return cleanPath;
  }

  private setLoading(formPath: string, isLoading: boolean) {
    if (!this.loadingStates[formPath]) {
      this.loadingStates[formPath] = new BehaviorSubject<boolean>(isLoading);
    } else {
      this.loadingStates[formPath].next(isLoading);
    }
  }

  async onInputChanged(formPath: string, value: string): Promise<void> {
    const state = this.getPathState[formPath];
    const cleanedPath = value?.trim() ?? "";

    if (!this.shouldReloadOnPathChange(cleanedPath, state?.currentPath ?? "")) {
      return;
    }
    if (cleanedPath === "") {
      await this.fetchEntriesForField(
        formPath,
        state?.remoteName ?? "",
        ""
      );
      return;
    }
    if (cleanedPath.includes(":/")) {
      const [remote, ...pathParts] = cleanedPath.split(/:\/?/);
      const path = pathParts.join("/");
      await this.fetchEntriesForField(
        formPath,
        remote,
        path
      );
    } else {
      await this.fetchEntriesForField(
        formPath,
        state?.remoteName ?? "",
        cleanedPath
      );
    }
  }

  private shouldReloadOnPathChange(
    newPath: string,
    currentPath: string
  ): boolean {
    // Reload when input is cleared
    if (newPath === "") return true;

    // Always reload on remote change (contains :/)
    if (newPath.includes(":/")) return true;

    // Reload when trailing slash is added (directory navigation)
    if (newPath.endsWith("/")) return true;

    // Don't reload if path hasn't actually changed
    if (newPath === currentPath) return false;

    // For other cases, only reload if the path exists in our current options
    const pathParts = newPath.split("/").filter(Boolean);
    const parentPath = pathParts.slice(0, -1).join("/");
    return parentPath === currentPath;
  }
}
