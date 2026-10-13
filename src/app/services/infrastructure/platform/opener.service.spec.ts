import { TestBed } from '@angular/core/testing';
import { OpenerService } from './opener.service';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TranslateService } from '@ngx-translate/core';
import { expect } from 'vitest';

describe('OpenerService', () => {
  let service: OpenerService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        OpenerService,
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: TranslateService, useValue: { instant: (k: string): string => k } },
      ],
    });
    service = TestBed.inject(OpenerService);
  });

  it('should be created', (): void => {
    expect(service).toBeTruthy();
  });

  it('should handle empty or null URLs gracefully', async (): Promise<void> => {
    await expect(service.openUrl('')).resolves.toBeUndefined();
  });

  it('should handle empty or null paths gracefully', async (): Promise<void> => {
    await expect(service.openPath('')).resolves.toBeUndefined();
  });

  it('should initialize link interceptor without throwing', (): void => {
    expect(() => service.initializeGlobalLinkInterceptor()).not.toThrow();
  });
});
