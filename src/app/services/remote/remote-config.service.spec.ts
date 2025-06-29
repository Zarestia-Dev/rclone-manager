import { TestBed } from '@angular/core/testing';

import { RemoteConfigService } from './remote-config.service';

describe('RemoteConfigService', () => {
  let service: RemoteConfigService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(RemoteConfigService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
