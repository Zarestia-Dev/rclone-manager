import { TestBed } from '@angular/core/testing';
import { FormControl } from '@angular/forms';
import { ValidatorsService } from './validators.service';
import { UiStateService } from '@app/services';

describe('ValidatorsService', () => {
  let service: ValidatorsService;
  let mockUiStateService: jasmine.SpyObj<UiStateService>;

  beforeEach(() => {
    const spy = jasmine.createSpyObj('UiStateService', [], { platform: 'linux' });

    TestBed.configureTestingModule({
      providers: [ValidatorsService, { provide: UiStateService, useValue: spy }],
    });

    service = TestBed.inject(ValidatorsService);
    mockUiStateService = TestBed.inject(UiStateService) as jasmine.SpyObj<UiStateService>;
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('crossPlatformPathValidator', () => {
    it('should validate Unix paths correctly', () => {
      const validator = service.crossPlatformPathValidator();

      expect(validator(new FormControl('/home/user'))).toBeNull();
      expect(validator(new FormControl('/usr/bin/test'))).toBeNull();
      expect(validator(new FormControl(''))).toBeNull();
      expect(validator(new FormControl('relative/path'))).toEqual({ invalidPath: true });
    });

    it('should validate Windows paths correctly', () => {
      Object.defineProperty(mockUiStateService, 'platform', { value: 'windows', writable: true });
      const validator = service.crossPlatformPathValidator();

      expect(validator(new FormControl('C:\\Users\\test'))).toBeNull();
      expect(validator(new FormControl('D:/Documents'))).toBeNull();
      expect(validator(new FormControl(''))).toBeNull();
      expect(validator(new FormControl('/unix/path'))).toEqual({ invalidPath: true });
    });
  });

  describe('jsonValidator', () => {
    it('should validate JSON correctly', () => {
      const validator = service.jsonValidator();

      expect(validator(new FormControl('{}'))).toBeNull();
      expect(validator(new FormControl('{"key": "value"}'))).toBeNull();
      expect(validator(new FormControl(''))).toBeNull();
      expect(validator(new FormControl('invalid json'))).toEqual({ invalidJson: true });
      expect(validator(new FormControl('{invalid}'))).toEqual({ invalidJson: true });
    });
  });

  describe('remoteNameValidator', () => {
    it('should validate remote names correctly', () => {
      const existingNames = ['existing1', 'existing2'];
      const pattern = /^[a-zA-Z0-9_-]+$/;
      const validator = service.remoteNameValidator(existingNames, pattern);

      expect(validator(new FormControl('validname'))).toBeNull();
      expect(validator(new FormControl('valid_name'))).toBeNull();
      expect(validator(new FormControl('valid-name'))).toBeNull();
      expect(validator(new FormControl(''))).toBeNull();

      expect(validator(new FormControl('existing1'))).toEqual({ nameTaken: true });
      expect(validator(new FormControl('invalid name'))).toEqual({ invalidChars: true });
      expect(validator(new FormControl('-invalidstart'))).toEqual({ invalidStart: true });
      expect(validator(new FormControl(' invalidstart'))).toEqual({ invalidStart: true });
      expect(validator(new FormControl('invalidend '))).toEqual({ invalidEnd: true });
    });
  });

  describe('urlValidator', () => {
    it('should validate URLs correctly', () => {
      const validator = service.urlValidator();

      expect(validator(new FormControl('https://example.com'))).toBeNull();
      expect(validator(new FormControl('http://localhost:8080'))).toBeNull();
      expect(validator(new FormControl('ftp://files.example.com'))).toBeNull();
      expect(validator(new FormControl(''))).toBeNull();
      expect(validator(new FormControl('invalid-url'))).toEqual({ invalidUrl: true });
      expect(validator(new FormControl('not a url'))).toEqual({ invalidUrl: true });
    });
  });

  describe('portValidator', () => {
    it('should validate port numbers correctly', () => {
      const validator = service.portValidator();

      expect(validator(new FormControl('80'))).toBeNull();
      expect(validator(new FormControl('8080'))).toBeNull();
      expect(validator(new FormControl('65535'))).toBeNull();
      expect(validator(new FormControl(''))).toBeNull();

      expect(validator(new FormControl('0'))).toEqual({ invalidPort: true });
      expect(validator(new FormControl('65536'))).toEqual({ invalidPort: true });
      expect(validator(new FormControl('invalid'))).toEqual({ invalidPort: true });
      expect(validator(new FormControl('-1'))).toEqual({ invalidPort: true });
    });
  });
});
