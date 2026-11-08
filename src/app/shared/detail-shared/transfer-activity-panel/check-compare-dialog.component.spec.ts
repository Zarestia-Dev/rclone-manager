import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import {
  CheckCompareData,
  CheckCompareDialogComponent,
  CompareEntry,
} from './check-compare-dialog.component';
import { TransferOperationsService } from './transfer-operations.service';
import { ActivityRow, compareSidesOf } from './activity.utils';

const item: ActivityRow = {
  jobid: 5,
  name: 'reports/annual.docx',
  size: 100,
  bytes: 0,
  checked: false,
  error: '',
  status: 'partial',
  srcFs: 'gdrive:Projects',
  dstFs: '/backup/Projects',
  uniqueId: 'row',
};

const entryOf = (name: string): CompareEntry => ({
  name,
  ...compareSidesOf({ ...item, name }),
});

describe('CheckCompareDialogComponent', () => {
  const close = vi.fn();
  const apply = vi.fn();
  const getVersionsAt = vi.fn();
  const compareChecksumsAt = vi.fn();

  const create = async (
    data: Partial<CheckCompareData> = {}
  ): Promise<CheckCompareDialogComponent> => {
    TestBed.configureTestingModule({
      providers: [
        provideTranslateService(),
        { provide: MatDialogRef, useValue: { close } },
        {
          provide: MAT_DIALOG_DATA,
          useValue: { entries: [entryOf(item.name)], apply, ...data },
        },
      ],
    });
    TestBed.overrideComponent(CheckCompareDialogComponent, {
      set: {
        template: '',
        styleUrls: [],
        providers: [
          { provide: TransferOperationsService, useValue: { getVersionsAt, compareChecksumsAt } },
        ],
      },
    });
    const fixture = TestBed.createComponent(CheckCompareDialogComponent);
    await fixture.whenStable();
    return fixture.componentInstance;
  };

  const both = {
    src: { size: 1500, modTime: '2026-11-07T16:30:00Z' },
    dst: { size: 1200, modTime: '2026-11-03T10:12:00Z' },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getVersionsAt.mockResolvedValue(both);
  });

  it('shows the real paths of both sides and tags the newer and larger version', async () => {
    const dialog = await create();
    expect(dialog['srcPath']()).toBe('gdrive:Projects/reports/annual.docx');
    expect(dialog['dstPath']()).toBe('/backup/Projects/reports/annual.docx');
    expect(getVersionsAt).toHaveBeenCalledWith(
      { fs: 'gdrive:Projects', path: 'reports/annual.docx' },
      { fs: '/backup/Projects', path: 'reports/annual.docx' }
    );
    expect(dialog['comparison']()).toEqual({ newer: 'src', larger: 'src' });
    expect(dialog['canKeepSource']()).toBe(true);
    expect(dialog['canKeepDestination']()).toBe(true);
  });

  it('applies nothing until a direction is picked, and a second pick of it undoes it', async () => {
    const dialog = await create();
    dialog['apply']();
    expect(apply).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    dialog['pick']('toSource');
    expect(dialog['overwritten']()?.path).toBe('gdrive:Projects/reports/annual.docx');
    dialog['pick']('toSource');
    expect(dialog['choice']()).toBeNull();
    expect(dialog['overwritten']()).toBeNull();
  });

  it('names the file the chosen direction replaces, hands the choice on and closes after the last file', async () => {
    const dialog = await create();
    dialog['pick']('toDestination');
    expect(dialog['overwritten']()).toEqual({
      path: '/backup/Projects/reports/annual.docx',
      version: both.dst,
      discarded: false,
    });
    dialog['apply']();
    expect(apply).toHaveBeenCalledWith(0, 'toDestination');
    expect(close).toHaveBeenCalledWith();
  });

  it('only lets a side win while it still holds the file', async () => {
    getVersionsAt.mockResolvedValue({ src: null, dst: both.dst });
    const dialog = await create();
    expect(dialog['canKeepSource']()).toBe(false);
    expect(dialog['canKeepDestination']()).toBe(true);
    expect(dialog['comparison']()).toEqual({ newer: null, larger: null });
  });

  it('reports a file it could not read instead of pretending both sides are known', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getVersionsAt.mockRejectedValue(new Error('403 forbidden'));
    const dialog = await create();
    expect(dialog['loadError']()).toBe('403 forbidden');
    expect(dialog['versions']()).toBeNull();
    expect(dialog['canKeepSource']()).toBe(false);
  });

  it('closes without a choice when the dialog is cancelled', async () => {
    const dialog = await create();
    dialog['close']();
    expect(close).toHaveBeenCalledWith();
    expect(apply).not.toHaveBeenCalled();
  });

  describe('a queue of files', () => {
    const queue = (): Promise<CheckCompareDialogComponent> =>
      create({ entries: [entryOf('a/one.txt'), entryOf('b/two.txt'), entryOf('c/three.txt')] });

    it('says which file it is on and whether another follows', async () => {
      const dialog = await queue();
      expect(dialog['position']()).toEqual({ index: 1, total: 3 });
      expect(dialog['hasNext']()).toBe(true);
      dialog['skip']();
      dialog['skip']();
      expect(dialog['position']()).toEqual({ index: 3, total: 3 });
      expect(dialog['hasNext']()).toBe(false);
    });

    it('has no position for a single file', async () => {
      expect((await create())['position']()).toBeNull();
    });

    it('hands each choice on and moves to the next file without closing', async () => {
      const dialog = await queue();
      dialog['pick']('toSource');
      dialog['apply']();
      expect(apply).toHaveBeenLastCalledWith(0, 'toSource');
      expect(close).not.toHaveBeenCalled();
      expect(dialog['index']()).toBe(1);

      dialog['pick']('toDestination');
      dialog['apply']();
      expect(apply).toHaveBeenLastCalledWith(1, 'toDestination');
      expect(close).not.toHaveBeenCalled();

      dialog['pick']('toSource');
      dialog['apply']();
      expect(apply).toHaveBeenLastCalledWith(2, 'toSource');
      expect(apply).toHaveBeenCalledTimes(3);
      expect(close).toHaveBeenCalledTimes(1);
    });

    it('skips a file without handing anything on, and closes when the last is skipped', async () => {
      const dialog = await queue();
      dialog['skip']();
      dialog['skip']();
      expect(close).not.toHaveBeenCalled();
      dialog['skip']();
      expect(apply).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(1);
    });

    it('starts every file clean: no choice, no checksums, its own versions', async () => {
      // The second file is read ahead, so its answer is set before the dialog opens.
      getVersionsAt.mockResolvedValueOnce(both).mockResolvedValueOnce({ src: both.src, dst: null });
      const dialog = await queue();
      compareChecksumsAt.mockResolvedValueOnce({
        hashType: 'md5',
        src: 'a',
        dst: 'b',
        match: true,
      });
      await dialog['verifyChecksums']();
      dialog['pick']('toSource');
      expect(dialog['checksumStatus']()).toBe('done');

      dialog['apply']();
      await vi.waitFor(() => expect(dialog['versions']()).toEqual({ src: both.src, dst: null }));
      expect(dialog['choice']()).toBeNull();
      expect(dialog['checksumStatus']()).toBe('idle');
      expect(dialog['checksumResult']()).toBeNull();
      expect(dialog['fileBase']()).toBe('two.txt');
    });

    it('reads the next file while the first is decided, and each file only once', async () => {
      const dialog = await queue();
      expect(getVersionsAt).toHaveBeenCalledTimes(2);
      expect(getVersionsAt).toHaveBeenLastCalledWith(
        { fs: 'gdrive:Projects', path: 'b/two.txt' },
        { fs: '/backup/Projects', path: 'b/two.txt' }
      );
      dialog['skip']();
      await vi.waitFor(() => expect(getVersionsAt).toHaveBeenCalledTimes(3));
      dialog['skip']();
      expect(getVersionsAt).toHaveBeenCalledTimes(3);
    });

    it('reports a failure of a file read ahead only when its turn comes', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      getVersionsAt
        .mockResolvedValueOnce(both)
        .mockRejectedValueOnce(new Error('gone'))
        .mockResolvedValueOnce(both);
      const dialog = await queue();
      expect(dialog['loadError']()).toBe('');
      dialog['skip']();
      await vi.waitFor(() => expect(dialog['loadError']()).toBe('gone'));
      expect(dialog['canKeepSource']()).toBe(false);
    });

    it('drops an answer that arrives after the dialog moved on', async () => {
      const dialog = await queue();
      let answer: (value: unknown) => void = () => undefined;
      compareChecksumsAt.mockImplementationOnce(() => new Promise(resolve => (answer = resolve)));
      const pending = dialog['verifyChecksums']();
      dialog['skip']();
      answer({ hashType: 'md5', src: 'a', dst: 'b', match: true });
      await pending;
      expect(dialog['checksumResult']()).toBeNull();
      expect(dialog['checksumStatus']()).toBe('idle');
    });
  });

  it('compares checksums on request and keeps the outcome for each case', async () => {
    const dialog = await create();
    compareChecksumsAt.mockResolvedValueOnce({ hashType: 'md5', src: 'a', dst: 'b', match: false });
    await dialog['verifyChecksums']();
    expect(dialog['checksumStatus']()).toBe('done');
    expect(dialog['checksumResult']()?.match).toBe(false);

    compareChecksumsAt.mockResolvedValueOnce(null);
    await dialog['verifyChecksums']();
    expect(dialog['checksumStatus']()).toBe('none');

    compareChecksumsAt.mockRejectedValueOnce(new Error('unsupported hash'));
    await dialog['verifyChecksums']();
    expect(dialog['checksumStatus']()).toBe('failed');
    expect(dialog['checksumError']()).toBe('unsupported hash');
  });

  it('splits the file into its folder and name', async () => {
    const dialog = await create();
    expect(dialog['fileDir']()).toBe('reports/');
    expect(dialog['fileBase']()).toBe('annual.docx');
  });

  it('gives a file without a folder an empty folder part', async () => {
    const dialog = await create({ entries: [entryOf('notes.md')] });
    expect(dialog['fileDir']()).toBe('');
    expect(dialog['fileBase']()).toBe('notes.md');
  });

  it('labels each side and adds its digest once the checksums are compared', async () => {
    const dialog = await create();
    expect(dialog['sides']().map(side => [side.target, side.label, side.hash])).toEqual([
      ['src', 'shared.transferActivity.compare.source', null],
      ['dst', 'shared.transferActivity.compare.destination', null],
    ]);

    compareChecksumsAt.mockResolvedValueOnce({
      hashType: 'md5',
      src: 'aa',
      dst: 'bb',
      match: false,
    });
    await dialog['verifyChecksums']();
    expect(dialog['sides']().map(side => side.hash)).toEqual([
      { type: 'md5', value: 'aa' },
      { type: 'md5', value: 'bb' },
    ]);
  });

  it('shortens long digests and leaves short ones whole', async () => {
    const dialog = await create();
    expect(dialog['shortHash']('abc123')).toBe('abc123');
    expect(dialog['shortHash']('0123456789abcdef0123456789abcdef')).toBe('0123456789…89abcdef');
  });

  it('calls the sides source and destination for a check', async () => {
    const dialog = await create();
    expect(dialog['labels'].src).toBe('shared.transferActivity.compare.source');
    expect(dialog['labels'].title).toBe('shared.transferActivity.compare.title');
  });

  describe('a bisync conflict', () => {
    const conflict: CompareEntry = {
      name: 'notes/a.md',
      src: { fs: 'gdrive:Notes', path: 'notes/a.md.conflict1' },
      dst: { fs: '/home/me/Notes', path: 'notes/a.md.conflict2' },
      target: {
        src: { fs: 'gdrive:Notes', path: 'notes/a.md' },
        dst: { fs: '/home/me/Notes', path: 'notes/a.md' },
      },
    };
    const create1 = (): Promise<CheckCompareDialogComponent> =>
      create({ bisync: true, entries: [conflict] });

    it('calls the sides Path1 and Path2 and reads each version from its own file name', async () => {
      const dialog = await create1();
      expect(dialog['labels'].src).toBe('shared.transferActivity.compare.path1');
      expect(dialog['labels'].keepDst).toBe('shared.transferActivity.compare.keepPath2');
      expect(dialog['srcPath']()).toBe('gdrive:Notes/notes/a.md.conflict1');
      expect(dialog['dstPath']()).toBe('/home/me/Notes/notes/a.md.conflict2');
      expect(getVersionsAt).toHaveBeenCalledWith(conflict.src, conflict.dst);
    });

    it('says the kept version ends up under the original name on both paths', async () => {
      const dialog = await create1();
      expect(dialog['outcomes']()).toEqual({
        toDestination:
          'gdrive:Notes/notes/a.md.conflict1 → gdrive:Notes/notes/a.md, /home/me/Notes/notes/a.md',
        toSource:
          '/home/me/Notes/notes/a.md.conflict2 → gdrive:Notes/notes/a.md, /home/me/Notes/notes/a.md',
      });
    });

    it('names the version that is discarded instead of an overwritten file', async () => {
      const dialog = await create1();
      dialog['pick']('toDestination');
      expect(dialog['overwritten']()).toMatchObject({
        path: '/home/me/Notes/notes/a.md.conflict2',
        discarded: true,
      });
      dialog['pick']('toDestination');
      dialog['pick']('toSource');
      expect(dialog['overwritten']()).toMatchObject({
        path: 'gdrive:Notes/notes/a.md.conflict1',
        discarded: true,
      });
    });
  });

  it('describes a check choice as a copy from one side to the other, and the file as overwritten', async () => {
    const dialog = await create();
    expect(dialog['outcomes']().toDestination).toBe(
      'gdrive:Projects/reports/annual.docx → /backup/Projects/reports/annual.docx'
    );
    dialog['pick']('toDestination');
    expect(dialog['overwritten']()?.discarded).toBe(false);
  });
});
