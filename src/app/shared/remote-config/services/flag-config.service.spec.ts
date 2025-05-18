import { TestBed } from '@angular/core/testing';

import { FlagConfigService } from './flag-config.service';

describe('FlagConfigService', () => {
  let service: FlagConfigService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(FlagConfigService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
