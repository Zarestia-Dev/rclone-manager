import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import { FormatFileSizePipe } from '@app/pipes';
import { AlertBannerComponent } from '../../components/alert-banner/alert-banner.component';
import { EscapeCloseDirective } from '../../directives/escape-close.directive';
import {
  ChecksumComparison,
  FileVersions,
  TransferOperationsService,
} from './transfer-operations.service';
import {
  CheckDirection,
  CompareSide,
  compareVersions,
  displayPath,
  FileVersion,
} from './activity.utils';

/** One file the user is asked about. */
export interface CompareEntry {
  /** The file as the user knows it, shown at the top. */
  name: string;
  src: CompareSide;
  dst: CompareSide;
  /**
   * Where the kept version ends up on each side, when that is not where it is now: a bisync
   * conflict keeps its version under the file's original name, and the other version goes.
   */
  target?: { src: CompareSide; dst: CompareSide };
}

export interface CheckCompareData {
  /** The files to decide on, in the order they are asked. */
  entries: readonly CompareEntry[];
  /** Calls the sides Path1 and Path2 instead of source and destination. */
  bisync?: boolean;
  /**
   * Starts the chosen change for `entries[index]`. The dialog moves on to the next file at once
   * and does not wait for the change to finish.
   */
  apply: (index: number, direction: CheckDirection) => void;
}

type ChecksumStatus = 'idle' | 'loading' | 'none' | 'failed' | 'done';

/**
 * Shows both versions of a file that differs and asks which one should win, then does the same for
 * the next file, so the dialog stays open for the whole queue.
 */
@Component({
  selector: 'app-check-compare-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [TransferOperationsService],
  imports: [
    DatePipe,
    MatIconModule,
    MatButtonModule,
    TranslatePipe,
    FormatFileSizePipe,
    AlertBannerComponent,
  ],
  hostDirectives: [EscapeCloseDirective],
  templateUrl: './check-compare-dialog.component.html',
  styleUrls: ['./check-compare-dialog.component.scss', '../../../styles/_shared-modal.scss'],
})
export class CheckCompareDialogComponent {
  private readonly dialogRef = inject(MatDialogRef<CheckCompareDialogComponent>);
  private readonly ops = inject(TransferOperationsService);
  protected readonly data = inject<CheckCompareData>(MAT_DIALOG_DATA);

  protected readonly labels = this.data.bisync
    ? {
        title: 'shared.transferActivity.compare.titleBisync',
        src: 'shared.transferActivity.compare.path1',
        dst: 'shared.transferActivity.compare.path2',
        keepSrc: 'shared.transferActivity.compare.keepPath1',
        keepDst: 'shared.transferActivity.compare.keepPath2',
      }
    : {
        title: 'shared.transferActivity.compare.title',
        src: 'shared.transferActivity.compare.source',
        dst: 'shared.transferActivity.compare.destination',
        keepSrc: 'shared.transferActivity.compare.keepSource',
        keepDst: 'shared.transferActivity.compare.keepDestination',
      };

  /** The file being asked about. */
  protected readonly index = signal(0);
  protected readonly entry = computed(() => this.data.entries[this.index()]);
  protected readonly position = computed(() =>
    this.data.entries.length > 1
      ? { index: this.index() + 1, total: this.data.entries.length }
      : null
  );
  protected readonly hasNext = computed(() => this.index() < this.data.entries.length - 1);

  protected readonly fileDir = computed(() => {
    const name = this.entry().name;
    return name.slice(0, name.lastIndexOf('/') + 1);
  });
  protected readonly fileBase = computed(() => {
    const name = this.entry().name;
    return name.slice(name.lastIndexOf('/') + 1);
  });
  protected readonly srcPath = computed(() =>
    displayPath(this.entry().src.fs, this.entry().src.path)
  );
  protected readonly dstPath = computed(() =>
    displayPath(this.entry().dst.fs, this.entry().dst.path)
  );

  protected readonly versions = signal<FileVersions | null>(null);
  protected readonly loadError = signal('');
  protected readonly choice = signal<CheckDirection | null>(null);
  protected readonly checksumStatus = signal<ChecksumStatus>('idle');
  protected readonly checksumResult = signal<ChecksumComparison | null>(null);
  protected readonly checksumError = signal('');

  /** Versions already asked for, by file, so the next file is read while this one is decided. */
  private readonly reads = new Map<number, Promise<FileVersions>>();

  protected readonly comparison = computed(() => {
    const versions = this.versions();
    return compareVersions(versions?.src ?? null, versions?.dst ?? null);
  });
  /** What the template shows for each side, in display order. */
  protected readonly sides = computed(() => {
    const versions = this.versions();
    const checksum = this.checksumResult();
    return [
      {
        target: 'src' as const,
        label: this.labels.src,
        path: this.srcPath(),
        version: versions?.src ?? null,
        hash: checksum && { type: checksum.hashType, value: checksum.src },
      },
      {
        target: 'dst' as const,
        label: this.labels.dst,
        path: this.dstPath(),
        version: versions?.dst ?? null,
        hash: checksum && { type: checksum.hashType, value: checksum.dst },
      },
    ];
  });
  /** A side can only win when it still holds the file. */
  protected readonly canKeepSource = computed(() => !!this.versions()?.src);
  protected readonly canKeepDestination = computed(() => !!this.versions()?.dst);
  /** What the chosen direction replaces. */
  protected readonly overwritten = computed<{
    path: string;
    version: FileVersion | null;
    /** The version goes with its copies instead of being replaced in place. */
    discarded: boolean;
  } | null>(() => {
    const choice = this.choice();
    if (!choice) return null;
    const versions = this.versions();
    const discarded = !!this.entry().target;
    return choice === 'toDestination'
      ? { path: this.dstPath(), version: versions?.dst ?? null, discarded }
      : { path: this.srcPath(), version: versions?.src ?? null, discarded };
  });
  /** Where each choice leads, as a line under its title. */
  protected readonly outcomes = computed(() => {
    const target = this.entry().target;
    const src = this.srcPath();
    const dst = this.dstPath();
    if (!target) {
      return { toDestination: `${src} → ${dst}`, toSource: `${dst} → ${src}` };
    }
    const both = `${displayPath(target.src.fs, target.src.path)}, ${displayPath(target.dst.fs, target.dst.path)}`;
    return { toDestination: `${src} → ${both}`, toSource: `${dst} → ${both}` };
  });

  constructor() {
    void this.show(0);
  }

  /** Reads the versions of a file once, however often they are asked for. */
  private readVersions(index: number): Promise<FileVersions> {
    let read = this.reads.get(index);
    if (!read) {
      const { src, dst } = this.data.entries[index];
      read = this.ops.getVersionsAt(src, dst);
      this.reads.set(index, read);
      // A file read ahead may fail unseen; the failure is reported when its turn comes.
      read.catch(() => undefined);
    }
    return read;
  }

  /** Moves to a file: clears what belonged to the last one and reads this one. */
  private async show(index: number): Promise<void> {
    this.index.set(index);
    this.versions.set(null);
    this.loadError.set('');
    this.choice.set(null);
    this.checksumStatus.set('idle');
    this.checksumResult.set(null);
    this.checksumError.set('');

    const read = this.readVersions(index);
    if (index + 1 < this.data.entries.length) void this.readVersions(index + 1);
    try {
      const versions = await read;
      if (this.index() === index) this.versions.set(versions);
    } catch (error) {
      console.error('Failed to read the compared files:', error);
      if (this.index() === index) {
        this.loadError.set(error instanceof Error ? error.message : String(error));
      }
    }
  }

  /** Long digests keep their start and end; the full value is in the title. */
  protected shortHash(hash: string): string {
    return hash.length > 20 ? `${hash.slice(0, 10)}…${hash.slice(-8)}` : hash;
  }

  protected pick(direction: CheckDirection): void {
    this.choice.set(this.choice() === direction ? null : direction);
  }

  protected async verifyChecksums(): Promise<void> {
    if (this.checksumStatus() === 'loading') return;
    const index = this.index();
    const { src, dst } = this.entry();
    this.checksumStatus.set('loading');
    try {
      const result = await this.ops.compareChecksumsAt(src, dst);
      if (this.index() !== index) return;
      this.checksumResult.set(result);
      this.checksumStatus.set(result ? 'done' : 'none');
    } catch (error) {
      if (this.index() !== index) return;
      this.checksumError.set(error instanceof Error ? error.message : String(error));
      this.checksumStatus.set('failed');
    }
  }

  /** Hands the choice on and moves to the next file, or closes after the last. */
  protected apply(): void {
    const choice = this.choice();
    if (!choice) return;
    this.data.apply(this.index(), choice);
    this.advance();
  }

  /** Leaves the file as it is. */
  protected skip(): void {
    this.advance();
  }

  protected close(): void {
    this.dialogRef.close();
  }

  private advance(): void {
    if (this.hasNext()) void this.show(this.index() + 1);
    else this.close();
  }
}
