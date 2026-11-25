import { DestroyRef, inject, Injectable, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { generatePrefixedId } from 'src/app/shared/utils';
import {
  BisyncConflict,
  Entry,
  FsInfo,
  Origin,
  FsTransferItem,
  FsDeleteItem,
  ArchiveListResponse,
  RenameItem,
  ConfigValue,
} from '@app/types';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { AppSettingsService } from '../settings/app-settings.service';
import { LocalStorageService } from '../ui/state/local-storage.service';
import type { TransferOptionValues } from 'src/app/shared/modals/transfer-options-modal/transfer-options-modal.component';

/**
 * Options for a listing or stat that only needs names and kinds. rclone then skips the modification
 * time and the MIME type of every entry, which some backends must fetch with a request of their own.
 */
export const NAMES_ONLY = { noModTime: true, noMimeType: true } as const;

export interface PendingWebUpload {
  group: string;
  remote: string;
  path: string;
  origin?: Origin;
  /** Bytes the server has received so far, out of `total`. */
  sent: number;
  total: number;
  files: number;
  /**
   * Set while the upload waits for the user: the connection was lost, or the page was reloaded.
   * `missing` counts the unfinished files the page no longer holds, which the user selects again.
   */
  paused?: { missing: number };
}

/**
 * How a browser upload ended: its transfer `finished`, is still `running` as a job, the user
 * `cancelled` it while its files were being sent, or it is `paused` until the user continues it.
 */
export type WebUploadOutcome = 'finished' | 'running' | 'cancelled' | 'paused';

/** A file of an upload session, with what the server has of it. */
interface SessionFile {
  path: string;
  size: number;
  mtime: number | null;
  received: number;
  /** The file to send the rest from, while the page holds it. */
  file?: File;
}

interface UploadSession {
  id: string;
  files: SessionFile[];
}

/**
 * An upload this browser started, kept so a reloaded page can continue it. `owner` is the tab
 * that shows it and `seen` when that tab last said it is open (0 once it has gone).
 */
interface StoredUpload {
  session: string;
  remote: string;
  path: string;
  origin?: Origin;
  /** False until the whole file list reached the server; such a session cannot be continued. */
  listed: boolean;
  owner: string;
  seen: number;
}

const STORED_UPLOADS = 'nautilus.web_uploads';
/** How often a tab says that it still shows its uploads, and when it is taken to be gone. */
const OWNER_HEARTBEAT_MS = 10_000;
const OWNER_GONE_MS = 30_000;

const MIB = 1024 * 1024;
/** The defaults of the `nautilus` upload settings, used until they load. */
const DEFAULT_REQUEST_MIB = 8;
/** The server reads a part of the file list whole and takes no larger one (`MAX_LIST_BYTES`). */
const MAX_LIST_BYTES = 8 * MIB;
const DEFAULT_PARALLEL_UPLOADS = 3;
/** Upload requests are halved while a proxy refuses them as too large, down to this size. */
const MIN_REQUEST_BYTES = 256 * 1024;
/** A request lost to the network is sent again this many times, waiting longer each time. */
const REQUEST_RETRIES = 5;
/** Answers that mean the server or a proxy in front of it may take the request a moment later. */
const RETRY_STATUSES = new Set([0, 408, 429, 502, 503, 504]);

interface UploadResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/** A failed upload request, with the error text the server sent (a backend translation key). */
class UploadRequestError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

class UploadCancelled extends Error {}

@Injectable({ providedIn: 'root' })
export class RemoteFileOperationsService extends TauriBaseService {
  private readonly http = inject(HttpClient);
  private readonly appSettings = inject(AppSettingsService);
  private readonly storage = inject(LocalStorageService);
  private readonly _pendingWebUploads = signal<PendingWebUpload[]>([]);
  readonly pendingWebUploads = this._pendingWebUploads.asReadonly();
  private readonly cancelledUploads = new Set<string>();
  private readonly uploadSessions = new Map<string, UploadSession>();
  private readonly tabId = generatePrefixedId('tab');

  constructor() {
    super();
    if (!this.isTauri) {
      // Leaving the page stops the files it is sending; a reloaded page can continue them.
      window.addEventListener('beforeunload', event => {
        if (this._pendingWebUploads().some(upload => !upload.paused)) event.preventDefault();
      });
      window.addEventListener('pagehide', () => this.markOwnUploads(0));
      const heartbeat = setInterval(() => this.markOwnUploads(Date.now()), OWNER_HEARTBEAT_MS);
      inject(DestroyRef).onDestroy(() => clearInterval(heartbeat));
      void this.restoreUploads();
    }
  }

  /**
   * Stops a browser upload and removes the files the server staged for it: one being sent stops
   * at its next request, a paused one at once.
   */
  cancelWebUpload(group: string): void {
    const upload = this._pendingWebUploads().find(item => item.group === group);
    if (!upload) return;
    if (!upload.paused) {
      this.cancelledUploads.add(group);
      return;
    }
    const session = this.uploadSessions.get(group);
    if (session) this.discardSession(session.id);
    this.endUpload(group);
  }

  /**
   * Gives a paused upload the files the user selected again, found by path, size and
   * modification time. Returns how many of its unfinished files were found.
   */
  attachWebUploadFiles(group: string, picked: { file: File; relativePath: string }[]): number {
    const session = this.uploadSessions.get(group);
    if (!session) return 0;
    const byPath = new Map(picked.map(({ file, relativePath }) => [relativePath, file]));
    let found = 0;
    for (const entry of session.files) {
      if (entry.file || entry.received >= entry.size) continue;
      const file = byPath.get(entry.path);
      if (
        file?.size === entry.size &&
        (entry.mtime === null || entry.mtime === file.lastModified)
      ) {
        entry.file = file;
        found++;
      }
    }
    if (found) this.setPaused(group, session);
    return found;
  }

  /**
   * Sends the rest of a paused upload's files that the page holds, then finishes it. It pauses
   * again when files the page does not hold are still missing.
   */
  async resumeWebUpload(group: string): Promise<WebUploadOutcome> {
    const session = this.uploadSessions.get(group);
    if (!session || !this._pendingWebUploads().some(item => item.group === group && item.paused)) {
      return 'cancelled';
    }
    this.updatePending(group, { paused: undefined });
    this.storeUpload(group, {});
    return this.sendAndFinish(group, session, await this.uploadLimits());
  }

  private async uploadRequest<T>(method: string, url: string, body?: unknown): Promise<T> {
    let response: UploadResponse<T>;
    try {
      response = await firstValueFrom(
        this.http.request<UploadResponse<T>>(method, `${this.apiClient.getApiBase()}/${url}`, {
          body,
          withCredentials: true,
        })
      );
    } catch (error) {
      if (error instanceof HttpErrorResponse) {
        const reply = error.error as UploadResponse<T> | null;
        throw new UploadRequestError(reply?.error ?? error.message, error.status);
      }
      throw error;
    }
    if (!response.success) throw new UploadRequestError(response.error ?? '', 200);
    return response.data as T;
  }

  async getFsInfo(remote: string, source?: Origin, group?: string): Promise<FsInfo> {
    return this.invokeCommand<FsInfo>('get_fs_info', { remote, origin: source, group });
  }

  async getDiskUsage(
    remote: string,
    path?: string,
    source?: Origin,
    group?: string
  ): Promise<{
    total: number;
    used: number;
    free: number;
  }> {
    return this.invokeCommand('get_disk_usage', { remote, path, origin: source, group });
  }

  /** fs must be an Rclone filesystem (e.g. "drive:") or a local path. */
  async getSize(
    fs: string,
    path?: string,
    source?: Origin,
    group?: string
  ): Promise<{ count: number; bytes: number }> {
    return this.invokeCommand('get_size', { remote: fs, path, origin: source, group });
  }

  async getStat(
    remote: string,
    path: string,
    opt?: Record<string, unknown>,
    source?: Origin,
    group?: string
  ): Promise<{ item: Entry }> {
    return this.invokeCommand('get_stat', { remote, path, opt, origin: source, group });
  }

  async getHashsum(
    remote: string,
    path: string,
    hashType: string,
    source?: Origin,
    group?: string
  ): Promise<{ hashsum: string[]; hashType: string }> {
    return this.invokeCommand('get_hashsum', { remote, path, hashType, origin: source, group });
  }

  async getHashsumFile(
    remote: string,
    path: string,
    hashType: string,
    source?: Origin,
    group?: string
  ): Promise<{ hash: string; hashType: string }> {
    return this.invokeCommand('get_hashsum_file', {
      remote,
      path,
      hashType,
      origin: source,
      group,
    });
  }

  async getPublicLink(
    remote: string,
    path: string,
    unlink?: boolean,
    expire?: string,
    source?: Origin,
    group?: string
  ): Promise<{ url: string }> {
    return this.invokeCommand('get_public_link', {
      remote,
      path,
      unlink,
      expire,
      origin: source,
      group,
    });
  }

  async getRemotePaths(
    remote: string,
    path: string,
    options: Record<string, unknown>,
    source?: Origin,
    group?: string
  ): Promise<{ list: Entry[] }> {
    return this.invokeCommand<{ list: Entry[] }>('get_remote_paths', {
      remote,
      path,
      options,
      origin: source,
      group,
    });
  }

  async transferItems(
    items: FsTransferItem[],
    dstRemote: string,
    dstPath: string,
    mode: 'copy' | 'move',
    source?: Origin,
    group?: string,
    parentJobId?: number,
    options?: TransferOptionValues
  ): Promise<string> {
    return this.invokeCommand<string>('transfer', {
      items,
      dstRemote,
      dstPath,
      mode,
      origin: source,
      group,
      parentJobId,
      options,
    });
  }

  async deleteItems(items: FsDeleteItem[], source?: Origin, group?: string): Promise<string> {
    return this.invokeCommand<string>('delete', { items, origin: source, group });
  }

  async removeEmptyDirs(
    remote: string,
    path: string,
    source?: Origin,
    group?: string
  ): Promise<string> {
    return this.invokeCommand<string>('remove_empty_dirs', { remote, path, origin: source, group });
  }

  /** `options` are the index options by rclone's names, as a profile keeps them. */
  async generateIndex(
    remote: string,
    path: string,
    options: Record<string, ConfigValue>,
    source?: Origin,
    group?: string
  ): Promise<void> {
    return this.invokeCommand<void>('generate_index', {
      remote,
      path,
      options,
      origin: source,
      group,
    });
  }

  async rename(
    remote: string,
    srcPath: string,
    dstPath: string,
    isDir: boolean,
    source?: Origin,
    group?: string
  ): Promise<string> {
    return this.renameBatch([{ remote, srcPath, dstPath, isDir }], source, group);
  }

  async renameBatch(items: RenameItem[], source?: Origin, group?: string): Promise<string> {
    return this.invokeCommand<string>('rename', {
      items,
      origin: source,
      group,
    });
  }

  /**
   * Keeps one version of a file bisync could not reconcile on both of the job's paths.
   * Resolves when every step has finished; a failed step stops the rest.
   */
  async resolveBisyncConflict(
    path1: string,
    path2: string,
    conflict: BisyncConflict,
    keep: 'path1' | 'path2',
    source?: Origin,
    group?: string
  ): Promise<void> {
    return this.invokeCommand<void>('resolve_bisync_conflict', {
      path1,
      path2,
      conflict,
      keep,
      origin: source,
      group,
    });
  }

  async makeDirectory(
    remote: string,
    path: string,
    source?: Origin,
    group?: string,
    backendName?: string
  ): Promise<void> {
    return this.invokeCommand<void>('mkdir', {
      remote,
      path,
      origin: source,
      group,
      ...(backendName && { backendName }),
    });
  }

  async cleanup(remote: string, path?: string, source?: Origin, group?: string): Promise<void> {
    return this.invokeCommand<void>('cleanup', { remote, path, origin: source, group });
  }

  async copyUrl(
    remote: string,
    path: string,
    urlToCopy: string,
    autoFilename: boolean,
    source?: Origin,
    group?: string
  ): Promise<void> {
    return this.invokeCommand<void>('copy_url', {
      remote,
      path,
      urlToCopy,
      autoFilename,
      origin: source,
      group,
    });
  }

  async uploadLocalDropPaths(
    remote: string,
    path: string,
    localPaths: string[],
    source?: Origin,
    group?: string,
    options?: TransferOptionValues
  ): Promise<string> {
    return this.invokeCommand<string>('upload_local_drop_paths', {
      remote,
      path,
      localPaths,
      origin: source,
      group,
      options,
    });
  }

  async uploadFileSimple(
    remote: string,
    path: string,
    name: string,
    content: Uint8Array
  ): Promise<string> {
    return this.invokeCommand<string>('upload_file', {
      remote,
      path,
      name,
      content: Array.from(content),
    });
  }

  /**
   * Sends files from the browser to the server, then transfers them to `remote`. Every request
   * (a part of the file list or a chunk of a file) stays within the size the preferences allow, a
   * request lost to the network is sent again, and a proxy that refuses large requests gets smaller
   * ones. Rejects with the server's error (a backend translation key) when the upload fails.
   */
  async uploadWebFilesBatch(
    remote: string,
    path: string,
    files: { file: File; relativePath: string }[],
    source?: Origin,
    emptyDirectories: string[] = [],
    options?: TransferOptionValues
  ): Promise<WebUploadOutcome> {
    const upload: PendingWebUpload = {
      group: generatePrefixedId('upload'),
      remote,
      path,
      origin: source,
      sent: 0,
      total: files.reduce((sum, { file }) => sum + file.size, 0),
      files: files.length,
    };
    this._pendingWebUploads.update(uploads => [...uploads, upload]);
    const limits = await this.uploadLimits();
    const session: UploadSession = {
      id: '',
      files: files.map(({ file, relativePath }) => ({
        path: relativePath || file.name,
        size: file.size,
        mtime: file.lastModified,
        received: 0,
        file,
      })),
    };
    try {
      await this.openSession(session, upload, [...new Set(emptyDirectories)], limits, options);
    } catch (error) {
      if (session.id) this.discardSession(session.id);
      this.endUpload(upload.group);
      if (error instanceof UploadCancelled) return 'cancelled';
      throw error;
    }
    this.storeUpload(upload.group, { listed: true });
    this.uploadSessions.set(upload.group, session);
    return this.sendAndFinish(upload.group, session, limits);
  }

  private async uploadLimits(): Promise<{ requestBytes: number; parallel: number }> {
    const [requestMib, parallel] = await Promise.all([
      this.appSettings.getSettingValue<number>('nautilus.upload_request_mib'),
      this.appSettings.getSettingValue<number>('nautilus.parallel_uploads'),
    ]);
    return {
      requestBytes: (requestMib ?? DEFAULT_REQUEST_MIB) * MIB,
      parallel: Math.max(parallel ?? DEFAULT_PARALLEL_UPLOADS, 1),
    };
  }

  /**
   * Sends what the server lacks of the files the page holds, then starts the transfer. A
   * connection lost for longer than the retries wait pauses the upload instead of ending it.
   */
  private async sendAndFinish(
    group: string,
    session: UploadSession,
    limits: { requestBytes: number; parallel: number }
  ): Promise<WebUploadOutcome> {
    try {
      await this.sendFiles(group, session, limits);
      this.throwIfCancelled(group);
      if (session.files.some(file => file.received < file.size)) {
        this.setPaused(group, session);
        return 'paused';
      }
      const finished = await this.uploadRequest<boolean>(
        'POST',
        `upload/sessions/${session.id}/finish`
      );
      this.endUpload(group);
      return finished ? 'finished' : 'running';
    } catch (error) {
      if (error instanceof UploadRequestError && RETRY_STATUSES.has(error.status)) {
        this.cancelledUploads.delete(group);
        this.setPaused(group, session);
        return 'paused';
      }
      // A finished session is already gone; removing it again changes nothing.
      this.discardSession(session.id);
      this.endUpload(group);
      if (error instanceof UploadCancelled) return 'cancelled';
      throw error;
    }
  }

  private setPaused(group: string, session: UploadSession): void {
    const missing = session.files.filter(file => file.received < file.size && !file.file).length;
    this.updatePending(group, { paused: { missing } });
  }

  private updatePending(group: string, change: Partial<PendingWebUpload>): void {
    this._pendingWebUploads.update(uploads =>
      uploads.map(upload => (upload.group === group ? { ...upload, ...change } : upload))
    );
  }

  private discardSession(id: string): void {
    void this.uploadRequest('DELETE', `upload/sessions/${id}`).catch(() => undefined);
  }

  private endUpload(group: string): void {
    this.cancelledUploads.delete(group);
    this.uploadSessions.delete(group);
    this.storeUpload(group, null);
    this._pendingWebUploads.update(uploads => uploads.filter(item => item.group !== group));
  }

  private storedUploads(): Record<string, StoredUpload> {
    return this.storage.get<Record<string, StoredUpload>>(STORED_UPLOADS, {});
  }

  /** Adds to the upload's stored record as this tab's, or removes it with `null`. */
  private storeUpload(group: string, change: Partial<StoredUpload> | null): void {
    const uploads = this.storedUploads();
    if (change) {
      uploads[group] = { ...uploads[group], owner: this.tabId, seen: Date.now(), ...change };
    } else if (group in uploads) {
      delete uploads[group];
    } else {
      return;
    }
    this.storage.set(STORED_UPLOADS, uploads);
  }

  /**
   * Says when this tab last showed its uploads: now while it is open, 0 when the page goes, which
   * frees them for the next page to continue.
   */
  private markOwnUploads(seen: number): void {
    const uploads = this.storedUploads();
    const own = Object.values(uploads).filter(upload => upload.owner === this.tabId);
    if (!own.length) return;
    for (const upload of own) upload.seen = seen;
    this.storage.set(STORED_UPLOADS, uploads);
  }

  /**
   * Shows the uploads an earlier page of this browser left unfinished as paused, with what the
   * server has of each file. Uploads another open tab shows stay there; a session whose file list
   * never reached the server whole, or that the server no longer has, is dropped.
   */
  private async restoreUploads(): Promise<void> {
    for (const [group, stored] of Object.entries(this.storedUploads())) {
      if (Date.now() - stored.seen < OWNER_GONE_MS) continue;
      if (!stored.listed) {
        this.discardSession(stored.session);
        this.storeUpload(group, null);
        continue;
      }
      this.storeUpload(group, {});
      let files: SessionFile[];
      try {
        files = await this.uploadRequest('GET', `upload/sessions/${stored.session}`);
      } catch (error) {
        if (error instanceof UploadRequestError && error.status === 404) {
          this.storeUpload(group, null);
        } else {
          // Tried again by the next page.
          this.storeUpload(group, { seen: 0 });
        }
        continue;
      }
      const session: UploadSession = { id: stored.session, files };
      this.uploadSessions.set(group, session);
      this._pendingWebUploads.update(uploads => [
        ...uploads,
        {
          group,
          remote: stored.remote,
          path: stored.path,
          origin: stored.origin,
          sent: session.files.reduce((sum, file) => sum + file.received, 0),
          total: session.files.reduce((sum, file) => sum + file.size, 0),
          files: session.files.length,
        },
      ]);
      this.setPaused(group, session);
    }
  }

  /**
   * Lists the session's files and the upload's empty folders: the first part opens the session
   * (its id is set on `session`), the others add to it. Each part is as long as fits in one
   * request.
   */
  private async openSession(
    session: UploadSession,
    upload: PendingWebUpload,
    emptyDirs: string[],
    limits: { requestBytes: number },
    options: TransferOptionValues | undefined
  ): Promise<void> {
    const entries = [
      ...session.files.map(({ path, size, mtime }) => ({
        kind: 'files' as const,
        value: { path, size, mtime },
      })),
      ...emptyDirs.map(dir => ({ kind: 'emptyDirs' as const, value: dir })),
    ];
    const header = {
      remote: upload.remote,
      path: upload.path,
      origin: upload.origin,
      group: upload.group,
      options,
    };
    const encoder = new TextEncoder();
    const headerBytes = encoder.encode(JSON.stringify(header)).length;
    let budget = Math.min(limits.requestBytes, MAX_LIST_BYTES);
    let listed = 0;
    let listedFiles = 0;
    do {
      this.throwIfCancelled(upload.group);
      const part: { files: object[]; emptyDirs: string[] } = { files: [], emptyDirs: [] };
      await this.sendWithRetries(
        () => {
          // Built at each attempt, so a part refused as too large is sent again smaller.
          part.files = [];
          part.emptyDirs = [];
          let bytes = headerBytes + 32;
          for (const entry of entries.slice(listed)) {
            const size = encoder.encode(JSON.stringify(entry.value)).length + 1;
            if (part.files.length + part.emptyDirs.length > 0 && bytes + size > budget) break;
            bytes += size;
            if (entry.kind === 'files') part.files.push(entry.value);
            else part.emptyDirs.push(entry.value);
          }
          return session.id
            ? this.uploadRequest(
                'POST',
                `upload/sessions/${session.id}/files?start=${listedFiles}`,
                part
              )
            : this.uploadRequest<string>('POST', 'upload/sessions', { ...header, ...part }).then(
                id => {
                  session.id = id;
                  this.storeUpload(upload.group, {
                    session: id,
                    remote: upload.remote,
                    path: upload.path,
                    origin: upload.origin,
                    listed: false,
                  });
                }
              );
        },
        () => {
          if (budget <= MIN_REQUEST_BYTES) return false;
          budget = Math.max(MIN_REQUEST_BYTES, budget / 2);
          return true;
        }
      );
      listed += part.files.length + part.emptyDirs.length;
      listedFiles += part.files.length;
    } while (listed < entries.length);
  }

  /** Sends the rest of every file the page holds, as many at once as the settings allow. */
  private async sendFiles(
    group: string,
    session: UploadSession,
    limits: { requestBytes: number; parallel: number }
  ): Promise<void> {
    const queue = session.files.flatMap((entry, index) =>
      entry.file && entry.received < entry.size ? [{ entry, index }] : []
    );
    let sent = session.files.reduce((sum, entry) => sum + entry.received, 0);
    let chunkSize = limits.requestBytes;
    let failed = false;
    const shrink = (): boolean => {
      if (chunkSize <= MIN_REQUEST_BYTES) return false;
      chunkSize = Math.max(MIN_REQUEST_BYTES, chunkSize / 2);
      return true;
    };

    const sendFile = async ({ entry, index }: (typeof queue)[number]): Promise<void> => {
      const file = entry.file as File;
      while (entry.received < entry.size) {
        if (failed) return;
        this.throwIfCancelled(group);
        const offset = entry.received;
        // The server answers how much of the file it has, also when this chunk was a repeat.
        entry.received = await this.sendWithRetries(
          () =>
            this.uploadRequest<number>(
              'PUT',
              `upload/sessions/${session.id}/files/${index}?offset=${offset}`,
              file.slice(offset, offset + chunkSize)
            ),
          shrink
        );
        sent += entry.received - offset;
        this.updatePending(group, { sent });
      }
    };

    let next = 0;
    const worker = async (): Promise<void> => {
      while (!failed && next < queue.length) {
        try {
          await sendFile(queue[next++]);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(limits.parallel, queue.length) }, worker));
  }

  /**
   * Sends a request again while the network or a proxy loses it, waiting longer each time. After a
   * 413, `shrink` makes the next attempt smaller and returns false when it cannot.
   */
  private async sendWithRetries<T>(send: () => Promise<T>, shrink: () => boolean): Promise<T> {
    let failures = 0;
    for (;;) {
      try {
        return await send();
      } catch (error) {
        const status = error instanceof UploadRequestError ? error.status : -1;
        if (status === 413 && shrink()) continue;
        if (!RETRY_STATUSES.has(status) || ++failures > REQUEST_RETRIES) throw error;
        await new Promise(resolve => setTimeout(resolve, Math.min(1000 * 2 ** failures, 30_000)));
      }
    }
  }

  private throwIfCancelled(group: string): void {
    if (this.cancelledUploads.has(group)) throw new UploadCancelled();
  }

  async archiveCreate(
    source: string,
    destination: string,
    format?: string,
    prefix?: string,
    fullPath?: boolean,
    include?: string[]
  ): Promise<unknown> {
    return this.invokeCommand('archive_create', {
      source,
      destination,
      format,
      prefix,
      fullPath,
      include,
    });
  }

  async archiveExtract(source: string, destination: string): Promise<unknown> {
    return this.invokeCommand('archive_extract', { source, destination });
  }

  /**
   * Lists an archive's entries. The listing runs as a job in `group`, so stopping that group
   * cancels it (a large archive on a remote can take minutes to read).
   */
  async archiveList(
    source: string,
    options: {
      long?: boolean;
      plain?: boolean;
      filesOnly?: boolean;
      dirsOnly?: boolean;
      group?: string;
    } = {}
  ): Promise<ArchiveListResponse> {
    return this.invokeCommand<ArchiveListResponse>('archive_list', {
      source,
      long: options.long,
      plain: options.plain,
      files_only: options.filesOnly,
      dirs_only: options.dirsOnly,
      group: options.group,
    });
  }
}
