import { describe, expect, it } from 'vitest';
import { findCloneName, findCopyName, findUniqueName } from './unique-name.util';

describe('findUniqueName', () => {
  it('keeps a free name', () => {
    expect(findUniqueName('profile', ['other'])).toBe('profile');
  });

  it('numbers a taken name from 1 and skips numbers that are taken too', () => {
    expect(findUniqueName('profile', ['profile'])).toBe('profile-1');
    expect(findUniqueName('profile', ['profile', 'profile-1', 'profile-2'])).toBe('profile-3');
  });

  it('uses the separator it is given', () => {
    expect(findUniqueName('Run', ['Run'], ' ')).toBe('Run 1');
  });
});

describe('findCloneName', () => {
  it('names the copy after the original', () => {
    expect(findCloneName('drive', ['drive'])).toBe('drive-clone');
  });

  it('numbers a copy that already exists', () => {
    expect(findCloneName('drive', ['drive', 'drive-clone'])).toBe('drive-clone-1');
  });

  it('copies a copy under the name of the original instead of stacking suffixes', () => {
    expect(findCloneName('drive-clone', ['drive', 'drive-clone'])).toBe('drive-clone-1');
    expect(findCloneName('drive-clone-1', ['drive', 'drive-clone', 'drive-clone-1'])).toBe(
      'drive-clone-2'
    );
  });

  it('does not strip a number that belongs to the name', () => {
    expect(findCloneName('s3-backup', [])).toBe('s3-backup-clone');
    expect(findCloneName('gdrive2', [])).toBe('gdrive2-clone');
    expect(findCloneName('backup-2024', [])).toBe('backup-2024-clone');
  });

  it('falls back to a name when nothing is left of the original', () => {
    expect(findCloneName('', [])).toBe('remote-clone');
  });
});

describe('findCopyName', () => {
  it('numbers a file before its extension, from 2', () => {
    expect(findCopyName('report.pdf', false, ['report.pdf'])).toBe('report (2).pdf');
    expect(findCopyName('report.pdf', false, ['report.pdf', 'report (2).pdf'])).toBe(
      'report (3).pdf'
    );
  });

  it('keeps .tar.gz whole and numbers a folder at the end, dots included', () => {
    expect(findCopyName('backup.tar.gz', false, [])).toBe('backup (2).tar.gz');
    expect(findCopyName('v1.2', true, [])).toBe('v1.2 (2)');
  });

  it('numbers a dotfile and a file without extension at the end', () => {
    expect(findCopyName('.bashrc', false, [])).toBe('.bashrc (2)');
    expect(findCopyName('Makefile', false, [])).toBe('Makefile (2)');
  });

  it('counts on from the number of a copy instead of stacking them', () => {
    expect(findCopyName('notes (2).txt', false, ['notes.txt', 'notes (2).txt'])).toBe(
      'notes (3).txt'
    );
  });

  it('counts a name taken in another case as taken when asked to ignore case', () => {
    expect(findCopyName('a.txt', false, ['A (2).TXT'])).toBe('a (2).txt');
    expect(findCopyName('a.txt', false, ['A (2).TXT'], true)).toBe('a (3).txt');
  });

  it('does not take a space-separated last word for an extension', () => {
    expect(findCopyName('Q1 report. final', false, [])).toBe('Q1 report. final (2)');
  });
});
