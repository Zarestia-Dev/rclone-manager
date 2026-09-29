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

  it('uploads one file at a time and groups the requests without buffering the whole selection', async () => {
    const result = service.uploadWebFilesBatch('drive:', 'destination', files, 'filemanager');
    const first = http.expectOne('/api/upload');
    expect(first.request.withCredentials).toBe(true);
    const body = first.request.body as FormData;
    expect(body.get('remote')).toBe('drive:');
    expect(body.get('path')).toBe('destination');
    expect(body.get('origin')).toBe('"filemanager"');
    expect(body.getAll('mtime')).toEqual(['0']);
    expect(body.getAll('file').map(file => (file as File).name)).toEqual(['folder/one.txt']);
    expect(body.get('group')).toMatch(/^upload-/);
    http.expectNone('/api/upload');
    first.flush({ success: true, data: '42' });
    await Promise.resolve();
    await Promise.resolve();
    const second = http.expectOne('/api/upload');
    expect(second.request.body.get('group')).toBe(body.get('group'));
    expect(second.request.body.get('mtime')).toBe('123');
    expect((second.request.body.get('file') as File).name).toBe('özel..txt');
    second.flush({ success: true, data: '43' });
    expect(await result).toEqual({ successCount: 2, failedPaths: [] });
  });

  it('continues after failure and counts only confirmed uploads', async () => {
    const result = service.uploadWebFilesBatch('drive:', '', files);
    http.expectOne('/api/upload').flush({ success: false, error: 'Transfer failed' });
    await Promise.resolve();
    await Promise.resolve();
    http.expectOne('/api/upload').flush({ success: true, data: '43' });
    expect(await result).toEqual({ successCount: 1, failedPaths: ['folder/one.txt'] });
  });

  it('does not count the final file as successful when its request fails', async () => {
    const result = service.uploadWebFilesBatch('drive:', '', files);
    http.expectOne('/api/upload').flush({ success: true, data: '42' });
    await Promise.resolve();
    await Promise.resolve();
    http.expectOne('/api/upload').error(new ProgressEvent('error'));
    expect(await result).toEqual({ successCount: 1, failedPaths: ['özel..txt'] });
  });

  it('isolates concurrent selections made in the same millisecond', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const first = service.uploadWebFilesBatch('drive:', '', [files[0]]);
    const second = service.uploadWebFilesBatch('drive:', '', [files[1]]);
    const requests = http.match('/api/upload');
    expect(requests).toHaveLength(2);
    expect(requests[0].request.body.get('group')).not.toBe(requests[1].request.body.get('group'));
    for (const request of requests) request.flush({ success: true, data: '42' });
    await Promise.all([first, second]);
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
  });
});
