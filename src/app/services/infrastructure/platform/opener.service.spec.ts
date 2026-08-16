import { TestBed } from '@angular/core/testing';
import { OpenerService } from './opener.service';

describe('OpenerService', () => {
  let service: OpenerService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [OpenerService],
    });
    service = TestBed.inject(OpenerService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('should handle empty or null URLs gracefully', async () => {
    await expectAsync(service.openUrl('')).toBeResolved();
  });

  it('should handle empty or null paths gracefully', async () => {
    await expectAsync(service.openPath('')).toBeResolved();
  });

  it('should initialize link interceptor without throwing', () => {
    expect(() => service.initializeGlobalLinkInterceptor()).not.toThrow();
  });
});
