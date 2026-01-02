import { TestBed } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import { BackendTranslationService } from './backend-translation.service';

describe('BackendTranslationService', () => {
  let service: BackendTranslationService;
  let translateServiceMock: jasmine.SpyObj<TranslateService>;

  beforeEach(() => {
    translateServiceMock = jasmine.createSpyObj('TranslateService', ['instant']);

    TestBed.configureTestingModule({
      providers: [
        BackendTranslationService,
        { provide: TranslateService, useValue: translateServiceMock },
      ],
    });

    service = TestBed.inject(BackendTranslationService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('translateBackendMessage', () => {
    it('should translate valid JSON error with params', () => {
      const message = JSON.stringify({ key: 'errors.test', params: { param: 'value' } });
      translateServiceMock.instant.and.returnValue('Translated Error value');

      const result = service.translateBackendMessage(message);

      expect(translateServiceMock.instant).toHaveBeenCalledWith('errors.test', { param: 'value' });
      expect(result).toBe('Translated Error value');
    });

    it('should fallback to raw JSON if translation key is missing', () => {
      const message = JSON.stringify({ key: 'errors.missing', params: {} });
      translateServiceMock.instant.and.returnValue('errors.missing'); // Returns key if not found

      const result = service.translateBackendMessage(message);

      expect(translateServiceMock.instant).toHaveBeenCalled();
      expect(result).toBe(message); // Should return original full message as fallback
    });

    it('should translate simple translation key', () => {
      const message = 'errors.simple.key';
      translateServiceMock.instant.and.returnValue('Simple Translation');

      const result = service.translateBackendMessage(message);

      expect(translateServiceMock.instant).toHaveBeenCalledWith('errors.simple.key', undefined);
      expect(result).toBe('Simple Translation');
    });

    it('should fallback to original string if simple key not found', () => {
      const message = 'errors.missing.key';
      translateServiceMock.instant.and.returnValue('errors.missing.key');

      const result = service.translateBackendMessage(message);

      expect(result).toBe('errors.missing.key');
    });

    it('should return non-key string as is', () => {
      const message = 'Some random backend error';
      // Should NOT call translate service

      const result = service.translateBackendMessage(message);

      expect(result).toBe(message);
    });

    it('should handle invalid JSON gracefully', () => {
      const message = '{ invalid json ';

      const result = service.translateBackendMessage(message);

      expect(result).toBe(message);
    });

    it('should handle non-string inputs', () => {
      const message = 123;

      const result = service.translateBackendMessage(message as unknown as string);

      expect(result).toBe('123');
    });
  });
});
