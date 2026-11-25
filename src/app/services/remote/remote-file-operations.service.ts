import { inject, Injectable, signal } from '@angular/core';
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
}

/**
 * How a browser upload ended: its transfer `finished`, is still `running` as a job, or the user
 * `cancelled` it while its files were being sent.
 */
export type WebUploadOutcome = 'finished' | 'running' | 'cancelled';

const MIB = 1024 * 1024;
/** The defaults of the `file_browser` upload settings, used until they load. */
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
  private readonly _pendingWebUploads = signal<PendingWebUpload[]>([]);
  readonly pendingWebUploads = this._pendingWebUploads.asReadonly();
  private readonly cancelledUploads = new Set<string>();

  constructor() {
    super();
    // Leaving the page drops the files it has not sent yet.
    if (!this.isTauri) {
      window.addEventListener('beforeunload', event => {
        if (this._pendingWebUploads().length) event.preventDefault();
      });
    }
  }

  /** Stops sending a browser upload; the files the server staged for it are removed. */
  cancelWebUpload(group: string): void {
    if (this._pendingWebUploads().some(upload => upload.group === group)) {
      this.cancelledUploads.add(group);
    }
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
    template?: string
  ): Promise<string> {
    return this.invokeCommand<string>('transfer', {
      items,
      dstRemote,
      dstPath,
      mode,
      origin: source,
      group,
      parentJobId,
      template,
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
    template?: string
  ): Promise<string> {
    return this.invokeCommand<string>('upload_local_drop_paths', {
      remote,
      path,
      localPaths,
      origin: source,
      group,
      template,
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
    template?: string
  ): Promise<WebUploadOutcome> {
    const upload: PendingWebUpload = {
      group: generatePrefixedId('upload'),
      remote,
      path,
      origin: source,
      sent: 0,
      total: files.reduce((sum, { file }) => sum + file.size, 0),
    };
    this._pendingWebUploads.update(uploads => [...uploads, upload]);
    const [requestMib, parallel] = await Promise.all([
      this.appSettings.getSettingValue<number>('file_browser.upload_request_mib'),
      this.appSettings.getSettingValue<number>('file_browser.parallel_uploads'),
    ]);
    const limits = {
      requestBytes: (requestMib ?? DEFAULT_REQUEST_MIB) * MIB,
      parallel: Math.max(parallel ?? DEFAULT_PARALLEL_UPLOADS, 1),
    };
    const session: { id?: string } = {};
    try {
      await this.openSession(
        session,
        upload,
        files,
        [...new Set(emptyDirectories)],
        limits,
        template
      );
      const id = session.id as string;
      await this.sendFiles(id, upload.group, files, limits);
      this.throwIfCancelled(upload.group);
      const finished = await this.uploadRequest<boolean>('POST', `upload/sessions/${id}/finish`);
      return finished ? 'finished' : 'running';
    } catch (error) {
      // A finished session is already gone; removing it again changes nothing.
      if (session.id) {
        void this.uploadRequest('DELETE', `upload/sessions/${session.id}`).catch(() => undefined);
      }
      if (error instanceof UploadCancelled) return 'cancelled';
      throw error;
    } finally {
      this.cancelledUploads.delete(upload.group);
      this._pendingWebUploads.update(uploads =>
        uploads.filter(item => item.group !== upload.group)
      );
    }
  }

  /**
   * Lists the upload's files and folders: the first part opens the session (its id is set on
   * `session`), the others add to it. Each part is as long as fits in one request.
   */
  private async openSession(
    session: { id?: string },
    upload: PendingWebUpload,
    files: { file: File; relativePath: string }[],
    emptyDirs: string[],
    limits: { requestBytes: number },
    template: string | undefined
  ): Promise<void> {
    const entries = [
      ...files.map(({ file, relativePath }) => ({
        kind: 'files' as const,
        value: { path: relativePath || file.name, size: file.size, mtime: file.lastModified },
      })),
      ...emptyDirs.map(dir => ({ kind: 'emptyDirs' as const, value: dir })),
    ];
    const header = {
      remote: upload.remote,
      path: upload.path,
      origin: upload.origin,
      group: upload.group,
      template,
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

  private async sendFiles(
    session: string,
    group: string,
    files: { file: File; relativePath: string }[],
    limits: { requestBytes: number; parallel: number }
  ): Promise<void> {
    const sent = files.map(() => 0);
    let chunkSize = limits.requestBytes;
    let next = 0;
    let failed = false;
    const shrink = (): boolean => {
      if (chunkSize <= MIN_REQUEST_BYTES) return false;
      chunkSize = Math.max(MIN_REQUEST_BYTES, chunkSize / 2);
      return true;
    };

    const sendFile = async (index: number): Promise<void> => {
      const { file } = files[index];
      let offset = 0;
      while (offset < file.size) {
        if (failed) return;
        this.throwIfCancelled(group);
        // The server answers how much of the file it has, also when this chunk was a repeat.
        offset = await this.sendWithRetries(
          () =>
            this.uploadRequest<number>(
              'PUT',
              `upload/sessions/${session}/files/${index}?offset=${offset}`,
              file.slice(offset, offset + chunkSize)
            ),
          shrink
        );
        sent[index] = offset;
        const total = sent.reduce((sum, bytes) => sum + bytes, 0);
        this._pendingWebUploads.update(uploads =>
          uploads.map(upload => (upload.group === group ? { ...upload, sent: total } : upload))
        );
      }
    };

    const worker = async (): Promise<void> => {
      while (!failed && next < files.length) {
        try {
          await sendFile(next++);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(limits.parallel, files.length) }, worker));
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
