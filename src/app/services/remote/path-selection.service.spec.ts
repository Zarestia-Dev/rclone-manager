import { TestBed } from '@angular/core/testing';

import { PathSelectionService } from './path-selection.service';

describe('PathSelectionService', () => {
  let service: PathSelectionService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(PathSelectionService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
