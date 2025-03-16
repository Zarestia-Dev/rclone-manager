import { TestBed } from '@angular/core/testing';

import { RcloneService } from './rclone.service';

describe('RcloneService', () => {
  let service: RcloneService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(RcloneService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
