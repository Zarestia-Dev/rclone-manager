import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TranslateService } from '@ngx-translate/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteFileOperationsService } from './remote-file-operations.service';
import { ApiClientService } from '../infrastructure/platform/api-client.service';
import { SseClientService } from '../infrastructure/platform/sse-client.service';
import { BackendTranslationService } from '../i18n/backend-translation.service';
import { NotificationService } from '../ui/notification.service';

describe('RemoteFileOperationsService uploads', () => {
  let service: RemoteFileOperationsService;
  let http: HttpTestingController;
  const files = [
    { file: new File(['first'], 'one.txt', { lastModified: 0 }), relativePath: 'folder/one.txt' },
    { file: new File(['second'], 'özel..txt', { lastModified: 123 }), relativePath: 'özel..txt' },
  ];

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
      ],
    });
    service = TestBed.inject(RemoteFileOperationsService);
    http = TestBed.inject(HttpTestingController);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    http.verify();
    vi.restoreAllMocks();
  });

  it('uploads all files and empty directories in a single batch request', async () => {
    const result = service.uploadWebFilesBatch('drive:', 'destination', files, 'filemanager', [
      'empty-dir',
    ]);
    const req = http.expectOne('/api/upload');
    expect(req.request.withCredentials).toBe(true);
    const body = req.request.body as FormData;
    expect(body.get('remote')).toBe('drive:');
    expect(body.get('path')).toBe('destination');
    expect(body.get('origin')).toBe('"filemanager"');
    expect(body.getAll('emptyDirs')).toEqual(['empty-dir']);
    expect(body.getAll('mtime')).toEqual(['0', '123']);
    expect(body.getAll('file').map(f => (f as File).name)).toEqual(['folder/one.txt', 'özel..txt']);
    expect(body.get('group')).toMatch(/^upload-/);
    expect(service.pendingWebUploads()).toEqual([
      { group: body.get('group'), remote: 'drive:', path: 'destination', origin: 'filemanager' },
    ]);
    req.flush({ success: true, data: '42' });
    expect(await result).toEqual({ successCount: 2, failedPaths: [] });
    expect(service.pendingWebUploads()).toEqual([]);
  });

  it('handles empty directories only without files in batch request', async () => {
    const result = service.uploadWebFilesBatch('drive:', 'destination', [], 'filemanager', [
      'empty-dir',
    ]);
    const req = http.expectOne('/api/upload');
    const body = req.request.body as FormData;
    expect(body.getAll('emptyDirs')).toEqual(['empty-dir']);
    expect(body.getAll('file')).toEqual([]);
    req.flush({ success: true, data: '0' });
    expect(await result).toEqual({ successCount: 0, failedPaths: [] });
  });

  it('reports all paths as failed when the batch request returns unsuccessful', async () => {
    const result = service.uploadWebFilesBatch('drive:', '', files);
    http.expectOne('/api/upload').flush({ success: false, error: 'Transfer failed' });
    expect(await result).toEqual({
      successCount: 0,
      failedPaths: ['folder/one.txt', 'özel..txt'],
    });
    expect(service.pendingWebUploads()).toEqual([]);
  });

  it('reports all paths as failed when the batch request encounters a network error', async () => {
    const result = service.uploadWebFilesBatch('drive:', '', files);
    http.expectOne('/api/upload').error(new ProgressEvent('error'));
    expect(await result).toEqual({
      successCount: 0,
      failedPaths: ['folder/one.txt', 'özel..txt'],
    });
    expect(service.pendingWebUploads()).toEqual([]);
  });

  it('isolates concurrent batch selections made in the same millisecond', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const first = service.uploadWebFilesBatch('drive:', '', [files[0]]);
    const second = service.uploadWebFilesBatch('drive:', '', [files[1]]);
    const requests = http.match('/api/upload');
    expect(requests).toHaveLength(2);
    expect(requests[0].request.body.get('group')).not.toBe(requests[1].request.body.get('group'));
    expect(service.pendingWebUploads()).toHaveLength(2);
    requests[0].flush({ success: true, data: '42' });
    await first;
    expect(service.pendingWebUploads().map(upload => upload.group)).toEqual([
      requests[1].request.body.get('group'),
    ]);
    requests[1].flush({ success: true, data: '43' });
    await second;
    expect(service.pendingWebUploads()).toEqual([]);
  });

  it('reports network failures and falls back to the filename for an empty relative path', async () => {
    const result = service.uploadWebFilesBatch('drive:', '', [
      { file: files[0].file, relativePath: '' },
    ]);
    const request = http.expectOne('/api/upload');
    expect((request.request.body.get('file') as File).name).toBe('one.txt');
    request.error(new ProgressEvent('error'));
    expect(await result).toEqual({ successCount: 0, failedPaths: ['one.txt'] });
  });

  it('does not create a job or send a request for an empty selection', async () => {
    expect(await service.uploadWebFilesBatch('drive:', '', [])).toEqual({
      successCount: 0,
      failedPaths: [],
    });
    http.expectNone('/api/upload');
    expect(service.pendingWebUploads()).toEqual([]);
  });

  it('tracks a single-file batch with an automatically generated group', async () => {
    const result = service.uploadWebFilesBatch('drive:', 'destination', [files[0]], 'filemanager');
    const request = http.expectOne('/api/upload');
    const group = request.request.body.get('group');
    expect(group).toMatch(/^upload-/);
    expect(service.pendingWebUploads()[0].group).toBe(group);
    request.flush({ success: true, data: '42' });
    expect(await result).toEqual({ successCount: 1, failedPaths: [] });
    expect(service.pendingWebUploads()).toEqual([]);
  });

  it('clears single-file batch preparation when the backend rejects the upload', async () => {
    const result = service.uploadWebFilesBatch('drive:', '', [files[0]], 'filemanager');
    const request = http.expectOne('/api/upload');
    expect(request.request.body.get('group')).toMatch(/^upload-/);
    request.flush({ success: false, error: 'Transfer failed' });
    expect(await result).toEqual({ successCount: 0, failedPaths: ['folder/one.txt'] });
    expect(service.pendingWebUploads()).toEqual([]);
  });
});
