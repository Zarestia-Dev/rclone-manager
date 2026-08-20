import { TestBed } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BackendTranslationService } from './backend-translation.service';

describe('BackendTranslationService', () => {
  let service: BackendTranslationService;
  let translateServiceMock: { instant: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    translateServiceMock = {
      instant: vi.fn(),
    };

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
      const message = JSON.stringify({
        key: 'backendErrors.mount.configIncomplete',
        params: { profile: 'Default' },
      });
      translateServiceMock.instant.mockReturnValue(
        "Mount configuration incomplete for profile 'Default'"
      );

      const result = service.translateBackendMessage(message);

      expect(translateServiceMock.instant).toHaveBeenCalledWith(
        'backendErrors.mount.configIncomplete',
        {
          profile: 'Default',
        }
      );
      expect(result).toBe("Mount configuration incomplete for profile 'Default'");
    });

    it('should translate embedded JSON error in prefixed string', () => {
      const embedded =
        'Start job failed: {"key":"backendErrors.mount.configIncomplete","params":{"profile":"Default"}}';
      translateServiceMock.instant.mockReturnValue(
        "Mount configuration incomplete for profile 'Default'"
      );

      const result = service.translateBackendMessage(embedded);

      expect(translateServiceMock.instant).toHaveBeenCalledWith(
        'backendErrors.mount.configIncomplete',
        {
          profile: 'Default',
        }
      );
      expect(result).toBe("Start job failed: Mount configuration incomplete for profile 'Default'");
    });

    it('should translate Error object wrapping JSON error', () => {
      const error = new Error(JSON.stringify({ key: 'backendErrors.mount.pointEmpty' }));
      translateServiceMock.instant.mockReturnValue('Mount point cannot be empty');

      const result = service.translateBackendMessage(error);

      expect(translateServiceMock.instant).toHaveBeenCalledWith(
        'backendErrors.mount.pointEmpty',
        undefined
      );
      expect(result).toBe('Mount point cannot be empty');
    });

    it('should translate structured object input directly', () => {
      const obj = { key: 'backendErrors.rclone.binaryNotFound' };
      translateServiceMock.instant.mockReturnValue('Rclone binary not found.');

      const result = service.translateBackendMessage(obj);

      expect(translateServiceMock.instant).toHaveBeenCalledWith(
        'backendErrors.rclone.binaryNotFound',
        undefined
      );
      expect(result).toBe('Rclone binary not found.');
    });

    it('should fallback to raw JSON if translation key is missing', () => {
      const message = JSON.stringify({ key: 'backendErrors.missing', params: {} });
      translateServiceMock.instant.mockReturnValue('backendErrors.missing'); // Returns key if not found

      const result = service.translateBackendMessage(message);

      expect(translateServiceMock.instant).toHaveBeenCalled();
      expect(result).toBe(message); // Should return original full message as fallback
    });

    it('should translate simple translation key', () => {
      const message = 'backendErrors.simple.key';
      translateServiceMock.instant.mockReturnValue('Simple Translation');

      const result = service.translateBackendMessage(message);

      expect(translateServiceMock.instant).toHaveBeenCalledWith(
        'backendErrors.simple.key',
        undefined
      );
      expect(result).toBe('Simple Translation');
    });

    it('should fallback to original string if simple key not found', () => {
      const message = 'backendErrors.missing.key';
      translateServiceMock.instant.mockReturnValue('backendErrors.missing.key');

      const result = service.translateBackendMessage(message);

      expect(result).toBe('backendErrors.missing.key');
    });

    it('should return non-key string as is', () => {
      const message = 'Some random backend error';

      const result = service.translateBackendMessage(message);

      expect(result).toBe(message);
    });

    it('should handle invalid JSON gracefully', () => {
      const message = '{ invalid json ';

      const result = service.translateBackendMessage(message);

      expect(result).toBe(message);
    });

    it('should handle null or undefined gracefully', () => {
      expect(service.translateBackendMessage(null)).toBe('');
      expect(service.translateBackendMessage(undefined)).toBe('');
    });

    it('should handle non-string inputs', () => {
      const message = 123;

      const result = service.translateBackendMessage(message as unknown as string);

      expect(result).toBe('123');
    });
  });
});
