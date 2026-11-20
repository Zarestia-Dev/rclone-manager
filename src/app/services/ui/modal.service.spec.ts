import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { TranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppSettingsService } from '../settings/app-settings.service';
import { VaultService } from '../security/vault.service';
import { NavigationHistoryService } from './navigation-history.service';
import { IntentGuideResume, ModalService } from './modal.service';

describe('ModalService intent guide', () => {
  const resume: IntentGuideResume = {
    remoteName: 'drive',
    goal: 'migrate',
    answers: { keepOld: 'keep' },
  };
  let service: ModalService;
  let openModal: ReturnType<typeof vi.fn>;

  const guideData = (): unknown => (openModal.mock.calls.at(-1)?.[1] as { data: unknown }).data;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: MatDialog, useValue: { afterOpened: new Subject() } },
        { provide: NavigationHistoryService, useValue: {} },
        { provide: VaultService, useValue: {} },
        { provide: AppSettingsService, useValue: {} },
        { provide: TranslateService, useValue: { instant: (key: string): string => key } },
      ],
    });
    service = TestBed.inject(ModalService);
    openModal = vi.fn().mockReturnValue({});
    (service as unknown as { openModal: unknown }).openModal = openModal;
  });

  it('carries on with the choices when the added remote opens the guide', () => {
    service.openQuickAddRemote(resume);
    service.openIntentGuide({ remoteName: 'onedrive' });
    expect(guideData()).toEqual({ remoteName: 'onedrive', resume });
  });

  it('starts fresh when the guide opens without a new remote', () => {
    service.openQuickAddRemote(resume);
    service.openIntentGuide();
    expect(guideData()).toEqual({ remoteName: undefined, resume: undefined });
  });

  it('does not carry on with a remote that was already in use', () => {
    service.openQuickAddRemote(resume);
    service.openIntentGuide({ remoteName: 'drive' });
    expect(guideData()).toEqual({ remoteName: 'drive', resume: undefined });
  });

  it('carries on only once', () => {
    service.openQuickAddRemote(resume);
    service.openIntentGuide({ remoteName: 'onedrive' });
    service.openIntentGuide({ remoteName: 'box' });
    expect(guideData()).toEqual({ remoteName: 'box', resume: undefined });
  });

  it('forgets an old choice when quick add opens without one', () => {
    service.openQuickAddRemote(resume);
    service.openQuickAddRemote();
    service.openIntentGuide({ remoteName: 'onedrive' });
    expect(guideData()).toEqual({ remoteName: 'onedrive', resume: undefined });
  });
});
