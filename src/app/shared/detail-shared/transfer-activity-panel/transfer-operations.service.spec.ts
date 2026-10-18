import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TranslateService } from '@ngx-translate/core';
import { createDefaultRemoteFeatures } from '@app/types';
import { TransferOperationsService } from './transfer-operations.service';
import { RemoteManagementService } from 'src/app/services/remote/remote-management.service';
import { RemoteFileOperationsService } from 'src/app/services/remote/remote-file-operations.service';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { DownloadService } from 'src/app/services/operations/download.service';

describe('TransferOperationsService feature warmup', () => {
  let service: TransferOperationsService;
  const getFeaturesSignal = vi.fn();
  const getFeatures = vi.fn();
  beforeEach(() => {
    getFeaturesSignal.mockReset().mockReturnValue(signal(createDefaultRemoteFeatures()));
    getFeatures.mockReset();
    TestBed.configureTestingModule({
      providers: [
        TransferOperationsService,
        { provide: RemoteManagementService, useValue: { getFeaturesSignal, getFeatures } },
        { provide: RemoteFileOperationsService, useValue: {} },
        { provide: TranslateService, useValue: {} },
        { provide: NotificationService, useValue: {} },
        { provide: DownloadService, useValue: {} },
        {
          provide: PathService,
          useValue: { isLocalPath: (path: string): boolean => path.startsWith('/') },
        },
      ],
    });
    service = TestBed.inject(TransferOperationsService);
  });

  it('uses deferred metadata loading and deduplicates remotes across transfer rows', () => {
    service.preloadFeatures([
      { srcFs: 'drive:source', dstFs: 'backup:dest' },
      { srcFs: 'drive:more', dstFs: '/tmp/local' },
      { srcFs: 'https://example.com/file' },
    ]);
    expect(getFeaturesSignal.mock.calls.map(call => call[0])).toEqual(['drive', 'backup']);
    expect(getFeatures).not.toHaveBeenCalled();
  });

  it('does not warm up metadata for empty or local-only transfer lists', () => {
    service.preloadFeatures([]);
    service.preloadFeatures([{ srcFs: '/tmp/source', dstFs: '/tmp/dest' }, {}]);
    expect(getFeaturesSignal).not.toHaveBeenCalled();
  });
});
