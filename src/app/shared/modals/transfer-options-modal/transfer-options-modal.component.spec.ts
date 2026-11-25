import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RcConfigOption } from '@app/types';
import {
  TransferOptionsModalComponent,
  TransferOptionsModalData,
} from './transfer-options-modal.component';
import { FlagConfigService } from 'src/app/services/remote/flag-config.service';
import { RemoteManagementService } from 'src/app/services/remote/remote-management.service';
import { RemoteFacadeService } from 'src/app/services/facade/remote-facade.service';
import { AppSettingsService } from 'src/app/services/settings/app-settings.service';
import { BackendService } from 'src/app/services/infrastructure/system/backend.service';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { IconService } from 'src/app/services/ui/icon.service';

const field = (Name: string, Default: unknown): RcConfigOption =>
  ({
    Name,
    FieldName: Name,
    Default,
    DefaultStr: String(Default),
    Help: '',
    Type: 'bool',
  }) as RcConfigOption;

describe('TransferOptionsModalComponent', () => {
  const close = vi.fn();
  const saveSetting = vi.fn();
  const showError = vi.fn();
  const loadConfigFields = vi.fn();
  const getRemoteConfigFields = vi.fn();
  const activeBackend = signal('Local');
  const isLocalBackend = signal(true);

  const open = async (data: TransferOptionsModalData): Promise<TransferOptionsModalComponent> => {
    TestBed.overrideProvider(MAT_DIALOG_DATA, { useValue: data });
    const component = TestBed.createComponent(TransferOptionsModalComponent).componentInstance;
    await vi.waitFor(() => expect(component.isLoading()).toBe(false));
    return component;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    saveSetting.mockResolvedValue(undefined);
    loadConfigFields.mockImplementation(async (types: string[]) =>
      Object.fromEntries(
        types.map(type => [
          type,
          type === 'filter'
            ? [field('exclude', '')]
            : type === 'backend'
              ? [field('transfers', 4)]
              : [field('check_first', false)],
        ])
      )
    );
    getRemoteConfigFields.mockResolvedValue([field('chunk_size', '8M')]);
    TestBed.configureTestingModule({
      imports: [TransferOptionsModalComponent],
      providers: [
        provideTranslateService(),
        { provide: MatDialogRef, useValue: { close } },
        { provide: MAT_DIALOG_DATA, useValue: {} },
        { provide: FlagConfigService, useValue: { loadConfigFields } },
        { provide: RemoteManagementService, useValue: { getRemoteConfigFields } },
        {
          provide: RemoteFacadeService,
          useValue: {
            remoteSummaries: signal([
              { name: 'drive', type: 'drive' },
              { name: 'nas', type: 'sftp' },
            ]),
          },
        },
        { provide: AppSettingsService, useValue: { saveSetting } },
        { provide: BackendService, useValue: { activeBackend, isLocalBackend } },
        { provide: NotificationService, useValue: { showError, showSuccess: vi.fn() } },
        { provide: IconService, useValue: { getIconName: (type: string): string => type } },
      ],
    }).overrideComponent(TransferOptionsModalComponent, { set: { template: '', imports: [] } });
  });

  it('shows the operation, filters, backend and each remote the transfer touches', async () => {
    activeBackend.set('NAS');
    isLocalBackend.set(false);
    const modal = await open({
      mode: 'transfer',
      operation: 'move',
      count: 2,
      destination: 'drive:dest',
      // A local path is no remote; an unknown name has no configuration to set.
      remotes: ['drive', 'nas', 'gone'],
      values: { move: { check_first: true } },
    });
    expect(modal.steps().map(step => step.key)).toEqual([
      'move',
      'filter',
      'backend',
      'remote:drive',
      'remote:nas',
    ]);
    expect(modal.engine()).toEqual({ name: 'NAS', local: false });
    expect(getRemoteConfigFields.mock.calls).toEqual([['drive'], ['sftp']]);
    // The default is filled in; options left at rclone's defaults are not sent.
    expect(modal.values()).toEqual({ move: { check_first: true } });
    activeBackend.set('Local');
    isLocalBackend.set(true);
  });

  it('closes with the options as set, including those of single remotes', async () => {
    const modal = await open({
      mode: 'transfer',
      operation: 'upload',
      remotes: ['drive'],
      values: {},
    });
    expect(modal.flagSteps).toEqual(['copy', 'filter', 'backend']);
    modal.form.get('backendConfig.options.transfers')?.setValue(8);
    modal.remoteSteps().get('drive')?.form.get('chunk_size')?.setValue('64M');
    await modal.confirm();
    expect(saveSetting).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledExactlyOnceWith({
      backend: { transfers: 8 },
      remotes: { drive: { chunk_size: '64M' } },
    });
  });

  it('keeps the other sections of the default and no remote when it becomes the default', async () => {
    const modal = await open({
      mode: 'transfer',
      operation: 'copy',
      remotes: ['drive'],
      values: { move: { check_first: true }, filter: { exclude: '*.tmp' } },
    });
    modal.form.get('copyConfig.options.check_first')?.setValue(true);
    modal.form.get('filterConfig.options.exclude')?.setValue('');
    modal.remoteSteps().get('drive')?.form.get('chunk_size')?.setValue('64M');
    modal.useAsDefault.set(true);
    modal.dontAskAgain.set(true);
    await modal.confirm();
    expect(saveSetting.mock.calls).toEqual([
      [
        'nautilus',
        'transfer_options',
        { move: { check_first: true }, copy: { check_first: true } },
      ],
      ['nautilus', 'ask_transfer_options', false],
    ]);
    expect(close).toHaveBeenCalledOnce();
  });

  it('edits the default for copies and moves alike, and keeps it open when it cannot be saved', async () => {
    const modal = await open({ mode: 'default', values: {} });
    expect(modal.flagSteps).toEqual(['copy', 'move', 'filter', 'backend']);
    modal.form.get('moveConfig.options.check_first')?.setValue(true);
    saveSetting.mockRejectedValueOnce(new Error('locked'));
    await modal.confirm();
    expect(showError).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    await modal.confirm();
    expect(saveSetting).toHaveBeenLastCalledWith('nautilus', 'transfer_options', {
      move: { check_first: true },
    });
    expect(close).toHaveBeenCalledExactlyOnceWith({ move: { check_first: true } });
  });

  it('offers only the destination options for an upload to an rclone on another computer', async () => {
    isLocalBackend.set(false);
    const modal = await open({
      mode: 'transfer',
      operation: 'upload',
      destination: 'drive:',
      remotes: ['drive'],
      values: { copy: { check_first: true } },
    });
    expect(modal.streamsFiles).toBe(true);
    expect(modal.steps().map(step => step.key)).toEqual(['remote:drive']);
    expect(loadConfigFields).not.toHaveBeenCalled();
    modal.remoteSteps().get('drive')?.form.get('chunk_size')?.setValue('64M');
    modal.useAsDefault.set(true);
    await modal.confirm();
    // Nothing else applies to such an upload, so the default is left alone.
    expect(close).toHaveBeenCalledExactlyOnceWith({ remotes: { drive: { chunk_size: '64M' } } });
    expect(saveSetting).toHaveBeenCalledExactlyOnceWith('nautilus', 'transfer_options', {
      copy: { check_first: true },
    });

    isLocalBackend.set(true);
  });

  it('offers every option for a copy between remotes on an rclone on another computer', async () => {
    isLocalBackend.set(false);
    // It runs as a job on that rclone, which reads every option.
    const copy = await open({ mode: 'transfer', operation: 'copy', values: {} });
    expect(copy.streamsFiles).toBe(false);
    expect(copy.flagSteps).toEqual(['copy', 'filter', 'backend']);
    isLocalBackend.set(true);
  });

  it('fills in what a template sets for the sections it shows', async () => {
    const modal = await open({ mode: 'transfer', operation: 'copy', values: {} });
    modal.onApplyTemplate({
      sourceName: 'Safe',
      values: {
        copy: { check_first: true },
        move: { check_first: true },
        backend: { transfers: 2 },
      },
    });
    expect(modal.values()).toEqual({ copy: { check_first: true }, backend: { transfers: 2 } });
  });
});
