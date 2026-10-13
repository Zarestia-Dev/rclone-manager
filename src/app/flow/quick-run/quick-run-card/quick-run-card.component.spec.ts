import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideTranslateService } from '@ngx-translate/core';
import { QuickRunCardComponent } from './quick-run-card.component';
import { QuickRun } from '@app/types';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { IconService } from 'src/app/services/ui/icon.service';
import { RemoteFacadeService } from 'src/app/services/facade/remote-facade.service';
import { QuickRunService } from 'src/app/services/flow/quick-run.service';

describe('QuickRunCardComponent', () => {
  let fixture: ComponentFixture<QuickRunCardComponent>;
  let component: QuickRunCardComponent;

  const mockQuickRun: QuickRun = {
    id: 'qr-1',
    name: 'Backup Documents',
    operationType: 'sync',
    remoteName: 'missing-drive',
    status: 'idle',
    config: {
      app: { autoStart: false },
      rclone: { srcFs: '/home/user/docs', dstFs: 'missing-drive:backup' },
    },
  };

  const isRemoteActiveMock = vi.fn((name?: string | null) => name !== 'missing-drive');

  beforeEach(async () => {
    isRemoteActiveMock.mockImplementation((name?: string | null) => name !== 'missing-drive');

    await TestBed.configureTestingModule({
      imports: [QuickRunCardComponent],
      providers: [
        provideTranslateService(),
        {
          provide: PathService,
          useValue: {
            activeRemotes: signal([]),
            formatFsPath: vi.fn((p: string) => p),
            isLocalPath: vi.fn(() => false),
            getFilename: vi.fn((p: string) => p),
          },
        },
        {
          provide: IconService,
          useValue: {
            getIconName: vi.fn(() => 'cloud'),
          },
        },
        {
          provide: RemoteFacadeService,
          useValue: {
            actionInProgress: signal({}),
            orderedRemotes: signal([]),
            isRemoteActive: isRemoteActiveMock,
          },
        },
        {
          provide: QuickRunService,
          useValue: {
            actionInProgress: signal({}),
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(QuickRunCardComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('quickRun', mockQuickRun);
    fixture.detectChanges();
  });

  it('should detect when the remote is missing', () => {
    expect(component.isRemoteMissing()).toBe(true);
    const remoteBtn = fixture.nativeElement.querySelector('.remote-link-btn');
    expect(remoteBtn.classList.contains('is-missing')).toBe(true);
  });

  it('should display the warning icon when remote is missing', () => {
    const remoteIcon = fixture.nativeElement.querySelector('.remote-link-btn mat-icon');
    expect(remoteIcon).toBeTruthy();
    expect(component.isRemoteMissing()).toBe(true);
  });

  it('should disable the primary action button when remote is missing', () => {
    const actionBtn = fixture.nativeElement.querySelector(
      '.quick-actions button'
    ) as HTMLButtonElement;
    expect(actionBtn).toBeTruthy();
    expect(actionBtn.disabled).toBe(true);
  });

  it('should not mark card as missing when remote is active', () => {
    isRemoteActiveMock.mockReturnValue(true);
    fixture.componentRef.setInput('quickRun', {
      ...mockQuickRun,
      remoteName: 'existing-drive',
    });
    fixture.detectChanges();

    expect(component.isRemoteMissing()).toBe(false);
    expect(fixture.nativeElement.classList.contains('remote-missing')).toBe(false);
    const missingBadge = fixture.nativeElement.querySelector('.missing-tag');
    expect(missingBadge).toBeNull();
  });
});
