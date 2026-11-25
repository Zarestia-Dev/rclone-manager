import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  TestRequest,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TranslateService } from '@ngx-translate/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteFileOperationsService } from './remote-file-operations.service';
import { ApiClientService } from '../infrastructure/platform/api-client.service';
import { SseClientService } from '../infrastructure/platform/sse-client.service';
import { BackendTranslationService } from '../i18n/backend-translation.service';
import { NotificationService } from '../ui/notification.service';
import { AppSettingsService } from '../settings/app-settings.service';

describe('RemoteFileOperationsService uploads', () => {
  let service: RemoteFileOperationsService;
  let http: HttpTestingController;
  const files = [
    { file: new File(['first'], 'one.txt', { lastModified: 0 }), relativePath: 'folder/one.txt' },
    { file: new File(['second'], 'özel..txt', { lastModified: 123 }), relativePath: '' },
  ];
  const ok = <T>(data: T): { success: true; data: T } => ({ success: true, data });
  const settings: Record<string, number | undefined> = {};
  const getSettingValue = vi.fn(async (key: string) => settings[key]);
  const next = (url: string): Promise<TestRequest> =>
    vi.waitFor(() => http.expectOne(request => request.url === url));

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        RemoteFileOperationsService,
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ApiClientService, useValue: { getApiBase: (): string => '/api' } },
        { provide: SseClientService, useValue: {} },
        { provide: BackendTranslationService, useValue: {} },
        { provide: NotificationService, useValue: {} },
        { provide: TranslateService, useValue: {} },
        { provide: AppSettingsService, useValue: { getSettingValue } },
      ],
    });
    service = TestBed.inject(RemoteFileOperationsService);
    http = TestBed.inject(HttpTestingController);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    http.verify();
    for (const key of Object.keys(settings)) delete settings[key];
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('opens a session, sends each file in chunks and finishes it', async () => {
    const result = service.uploadWebFilesBatch('drive:', 'destination', files, 'filemanager', [
      'empty-dir',
      'empty-dir',
    ]);
    const open = await next('/api/upload/sessions');
    expect(open.request.method).toBe('POST');
    expect(open.request.withCredentials).toBe(true);
    const group = open.request.body.group;
    expect(group).toMatch(/^upload-/);
    expect(open.request.body).toEqual({
      remote: 'drive:',
      path: 'destination',
      origin: 'filemanager',
      group,
      files: [
        { path: 'folder/one.txt', size: 5, mtime: 0 },
        { path: 'özel..txt', size: 6, mtime: 123 },
      ],
      emptyDirs: ['empty-dir'],
    });
    expect(service.pendingWebUploads()).toEqual([
      { group, remote: 'drive:', path: 'destination', origin: 'filemanager', sent: 0, total: 11 },
    ]);
    open.flush(ok('s1'));

    const first = await next('/api/upload/sessions/s1/files/0?offset=0');
    const second = await next('/api/upload/sessions/s1/files/1?offset=0');
    expect(first.request.method).toBe('PUT');
    expect(await (first.request.body as Blob).text()).toBe('first');
    first.flush(ok(5));
    await vi.waitFor(() => expect(service.pendingWebUploads()[0].sent).toBe(5));
    second.flush(ok(6));

    const finish = await next('/api/upload/sessions/s1/finish');
    expect(finish.request.method).toBe('POST');
    finish.flush(ok(true));
    expect(await result).toBe('finished');
    expect(service.pendingWebUploads()).toEqual([]);
  });

  it('lists a long upload in parts that each fit in one request', async () => {
    settings['file_browser.upload_request_mib'] = 0.25;
    const many = Array.from({ length: 4000 }, (_, index) => ({
      file: new File([], `${index}.txt`),
      relativePath: `${'deep/'.repeat(12)}${index}.txt`,
    }));
    const result = service.uploadWebFilesBatch('drive:', '', many, undefined, ['empty']);
    const open = await next('/api/upload/sessions');
    const first = open.request.body.files.length;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(many.length);
    expect(new TextEncoder().encode(JSON.stringify(open.request.body)).length).toBeLessThanOrEqual(
      256 * 1024
    );
    open.flush(ok('s1'));
    let listed = first;
    let emptyDirs: string[] = [];
    while (listed < many.length || !emptyDirs.length) {
      const part = await next(`/api/upload/sessions/s1/files?start=${listed}`);
      listed += part.request.body.files.length;
      emptyDirs = part.request.body.emptyDirs;
      part.flush(ok(null));
    }
    expect(listed).toBe(many.length);
    expect(emptyDirs).toEqual(['empty']);
    // Empty files are complete as soon as they are listed.
    (await next('/api/upload/sessions/s1/finish')).flush(ok(true));
    expect(await result).toBe('finished');
  });

  it('sends chunks larger than a list part when the preferences allow them', async () => {
    settings['file_browser.upload_request_mib'] = 16;
    const big = new File([new Uint8Array(10 * 1024 * 1024)], 'big.bin');
    const result = service.uploadWebFilesBatch('drive:', '', [{ file: big, relativePath: '' }]);
    (await next('/api/upload/sessions')).flush(ok('s1'));
    const chunk = await next('/api/upload/sessions/s1/files/0?offset=0');
    expect((chunk.request.body as Blob).size).toBe(big.size);
    chunk.flush(ok(big.size));
    (await next('/api/upload/sessions/s1/finish')).flush(ok(true));
    expect(await result).toBe('finished');
  });

  it('sends as many files at once as the preferences allow', async () => {
    settings['file_browser.parallel_uploads'] = 1;
    const result = service.uploadWebFilesBatch('drive:', '', files);
    (await next('/api/upload/sessions')).flush(ok('s1'));
    const first = await next('/api/upload/sessions/s1/files/0?offset=0');
    http.expectNone('/api/upload/sessions/s1/files/1?offset=0');
    first.flush(ok(5));
    (await next('/api/upload/sessions/s1/files/1?offset=0')).flush(ok(6));
    (await next('/api/upload/sessions/s1/finish')).flush(ok(true));
    expect(await result).toBe('finished');
  });

  it('reports a transfer that goes on after finishing as running', async () => {
    const result = service.uploadWebFilesBatch('drive:', '', [], 'filemanager', ['empty']);
    (await next('/api/upload/sessions')).flush(ok('s1'));
    (await next('/api/upload/sessions/s1/finish')).flush(ok(false));
    expect(await result).toBe('running');
  });

  it('halves the chunk while a proxy refuses it as too large', async () => {
    const big = new File([new Uint8Array(5 * 1024 * 1024)], 'big.bin');
    const result = service.uploadWebFilesBatch('drive:', '', [{ file: big, relativePath: '' }]);
    (await next('/api/upload/sessions')).flush(ok('s1'));
    const refused = await next('/api/upload/sessions/s1/files/0?offset=0');
    expect((refused.request.body as Blob).size).toBe(big.size);
    refused.flush('<html>413</html>', { status: 413, statusText: 'Payload Too Large' });
    const smaller = await next('/api/upload/sessions/s1/files/0?offset=0');
    expect((smaller.request.body as Blob).size).toBe(4 * 1024 * 1024);
    smaller.flush(ok(4 * 1024 * 1024));
    (await next(`/api/upload/sessions/s1/files/0?offset=${4 * 1024 * 1024}`)).flush(ok(big.size));
    (await next('/api/upload/sessions/s1/finish')).flush(ok(true));
    expect(await result).toBe('finished');
  });

  it('sends a chunk lost to the network again and continues where the server is', async () => {
    vi.useFakeTimers();
    const result = service.uploadWebFilesBatch('drive:', '', [files[0]]);
    (await next('/api/upload/sessions')).flush(ok('s1'));
    (await next('/api/upload/sessions/s1/files/0?offset=0')).error(new ProgressEvent('error'));
    await vi.advanceTimersByTimeAsync(2000);
    // The lost chunk had arrived: the server says so instead of writing it twice.
    (await next('/api/upload/sessions/s1/files/0?offset=0')).flush(ok(5));
    (await next('/api/upload/sessions/s1/finish')).flush(ok(true));
    expect(await result).toBe('finished');
  });

  it('rejects with the server error and removes the session when a chunk is refused', async () => {
    const result = service.uploadWebFilesBatch('drive:', '', [files[0]]);
    (await next('/api/upload/sessions')).flush(ok('s1'));
    (await next('/api/upload/sessions/s1/files/0?offset=0')).flush(
      { success: false, error: 'backendErrors.file.diskFull' },
      { status: 500, statusText: 'Internal Server Error' }
    );
    await expect(result).rejects.toThrow('backendErrors.file.diskFull');
    const cancel = await next('/api/upload/sessions/s1');
    expect(cancel.request.method).toBe('DELETE');
    cancel.flush(ok(null));
    expect(service.pendingWebUploads()).toEqual([]);
  });

  it('rejects a session the server refuses without sending anything else', async () => {
    const result = service.uploadWebFilesBatch('drive:', '', files);
    (await next('/api/upload/sessions')).flush(
      { success: false, error: 'backendErrors.upload.invalidPath' },
      { status: 400, statusText: 'Bad Request' }
    );
    await expect(result).rejects.toThrow('backendErrors.upload.invalidPath');
    expect(service.pendingWebUploads()).toEqual([]);
  });

  it('stops a cancelled upload and removes what the server staged', async () => {
    const result = service.uploadWebFilesBatch('drive:', '', [files[0]]);
    (await next('/api/upload/sessions')).flush(ok('s1'));
    const chunk = await next('/api/upload/sessions/s1/files/0?offset=0');
    service.cancelWebUpload(service.pendingWebUploads()[0].group);
    chunk.flush(ok(5));
    expect(await result).toBe('cancelled');
    (await next('/api/upload/sessions/s1')).flush(ok(null));
    expect(service.pendingWebUploads()).toEqual([]);
  });

  it('tracks uploads started together separately', async () => {
    const first = service.uploadWebFilesBatch('drive:', '', [], undefined, ['a']);
    const second = service.uploadWebFilesBatch('drive:', '', [], undefined, ['b']);
    const opens = await vi.waitFor(() => {
      const requests = http.match('/api/upload/sessions');
      expect(requests).toHaveLength(2);
      return requests;
    });
    expect(opens[0].request.body.group).not.toBe(opens[1].request.body.group);
    opens[0].flush(ok('s1'));
    opens[1].flush(ok('s2'));
    (await next('/api/upload/sessions/s1/finish')).flush(ok(true));
    await first;
    expect(service.pendingWebUploads().map(upload => upload.group)).toEqual([
      opens[1].request.body.group,
    ]);
    (await next('/api/upload/sessions/s2/finish')).flush(ok(true));
    await second;
    expect(service.pendingWebUploads()).toEqual([]);
  });
});

describe('RemoteFileOperationsService archives', () => {
  let service: RemoteFileOperationsService;
  const invoke = vi.fn().mockResolvedValue({ success: true, items: [] });

  beforeEach(() => {
    invoke.mockClear();
    TestBed.configureTestingModule({
      providers: [
        RemoteFileOperationsService,
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ApiClientService, useValue: { getApiBase: (): string => '/api', invoke } },
        { provide: SseClientService, useValue: {} },
        { provide: BackendTranslationService, useValue: {} },
        { provide: NotificationService, useValue: {} },
        { provide: TranslateService, useValue: {} },
        { provide: AppSettingsService, useValue: {} },
      ],
    });
    service = TestBed.inject(RemoteFileOperationsService);
  });

  it("lists an archive as a job in the caller's group so it can be cancelled", async () => {
    await service.archiveList('drive:a.zip', { long: true, group: 'ui/file-viewer/abc' });
    expect(invoke).toHaveBeenCalledWith('archive_list', {
      source: 'drive:a.zip',
      long: true,
      plain: undefined,
      files_only: undefined,
      dirs_only: undefined,
      group: 'ui/file-viewer/abc',
    });
  });

  it('lists without options and without a group', async () => {
    await service.archiveList('drive:a.zip');
    expect(invoke).toHaveBeenCalledWith(
      'archive_list',
      expect.objectContaining({ source: 'drive:a.zip', group: undefined })
    );
  });
});
