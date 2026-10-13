import { HttpClient } from '@angular/common/http';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { MultiFileLoader } from './multi-file-loader';

describe('MultiFileLoader', () => {
  it('should load and merge main, rclone, and rclone-providers translation files', async () => {
    const httpMock = {
      get: vi.fn((url: string) => {
        if (url === 'assets/i18n/tr-TR/main.json') {
          return of({ common: { ok: 'Tamam' } });
        }
        if (url === 'assets/i18n/tr-TR/rclone.json') {
          return of({ flags: { verbose: 'Ayrıntılı' } });
        }
        if (url === 'assets/i18n/tr-TR/rclone-providers.json') {
          return of({ providers: { drive: 'Google Drive' } });
        }
        return throwError(() => new Error('Not found'));
      }),
    } as unknown as HttpClient;

    const loader = new MultiFileLoader(httpMock);
    const result = await new Promise(resolve => {
      loader.getTranslation('tr-TR').subscribe(resolve);
    });

    expect(result).toEqual({
      common: { ok: 'Tamam' },
      flags: { verbose: 'Ayrıntılı' },
      providers: { drive: 'Google Drive' },
    });
  });

  it('should fallback to en-US if requested locale file fails to load', async () => {
    const httpMock = {
      get: vi.fn((url: string) => {
        if (url === 'assets/i18n/es-ES/main.json') {
          return throwError(() => new Error('404'));
        }
        if (url === 'assets/i18n/en-US/main.json') {
          return of({ common: { ok: 'OK' } });
        }
        if (url === 'assets/i18n/es-ES/rclone.json') {
          return of({ flags: { verbose: 'Detallado' } });
        }
        if (url === 'assets/i18n/es-ES/rclone-providers.json') {
          return of({});
        }
        return throwError(() => new Error('Not found'));
      }),
    } as unknown as HttpClient;

    const loader = new MultiFileLoader(httpMock);
    const result = await new Promise(resolve => {
      loader.getTranslation('es-ES').subscribe(resolve);
    });

    expect(result).toEqual({
      common: { ok: 'OK' },
      flags: { verbose: 'Detallado' },
    });
  });
});
