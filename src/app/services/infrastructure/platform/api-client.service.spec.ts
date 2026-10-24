import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiClientService } from './api-client.service';

describe('ApiClientService HTTP command diagnostics', () => {
  let http: HttpTestingController;
  let service: ApiClientService;
  let nativeDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    nativeDescriptor = Object.getOwnPropertyDescriptor(window, '__TAURI_INTERNALS__');
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: undefined, configurable: true });
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    service = TestBed.inject(ApiClientService);
  });

  afterEach(() => {
    http.verify();
    if (nativeDescriptor) {
      Object.defineProperty(window, '__TAURI_INTERNALS__', nativeDescriptor);
    } else {
      Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    }
  });

  it('identifies the command in the URL while keeping arguments in the POST body', async () => {
    const result = service.invoke('get_disk_usage', {
      remote: 'Google Drive:',
      origin: 'dashboard',
    });
    const request = http.expectOne('/api/invoke?command=get_disk_usage');
    expect(request.request.method).toBe('POST');
    expect(request.request.withCredentials).toBe(true);
    expect(request.request.body).toEqual({
      command: 'get_disk_usage',
      args: { remote: 'Google Drive:', origin: 'dashboard' },
    });
    request.flush({ success: true, data: { total: 100 } });
    expect(await result).toEqual({ total: 100 });
  });

  it('keeps localized error strings intact when command metadata accompanies a 500', async () => {
    const result = service.invoke('get_disk_usage');
    const message = JSON.stringify({ key: 'backendErrors.test', params: {} });
    const rejection = expect(result).rejects.toThrow(message);
    http
      .expectOne('/api/invoke?command=get_disk_usage')
      .flush(
        { success: false, command: 'get_disk_usage', error: message },
        { status: 500, statusText: 'Internal Server Error' }
      );
    await rejection;
  });

  it('encodes the diagnostic command and preserves its original body value', async () => {
    const result = service.invoke('test&x=#');
    const request = http.expectOne('/api/invoke?command=test%26x%3D%23');
    expect(request.request.body).toEqual({ command: 'test&x=#', args: {} });
    request.flush({ success: true, data: null });
    expect(await result).toBeNull();
  });
});
