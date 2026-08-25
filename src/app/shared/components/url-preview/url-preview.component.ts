import {
  Component,
  ChangeDetectionStrategy,
  computed,
  inject,
  input,
  signal,
  effect,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import { IconService } from 'src/app/services/ui/icon.service';
import { FileViewerService } from 'src/app/services/ui/file-viewer.service';
import { parseUrlInfo, buildDestinationPreview } from 'src/app/shared/utils/url.utils';
import { Entry } from '@app/types';

@Component({
  selector: 'app-url-preview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, MatButtonModule, TranslatePipe],
  templateUrl: './url-preview.component.html',
  styleUrls: ['./url-preview.component.scss'],
})
export class UrlPreviewComponent {
  public readonly iconService = inject(IconService);
  private readonly fileViewerService = inject(FileViewerService);

  readonly url = input<string | null | undefined>('');
  readonly customFilename = input<string | null | undefined>();
  readonly destinationPath = input<string | null | undefined>();
  readonly compact = input<boolean>(false);

  readonly mediaError = signal(false);
  readonly mediaLoaded = signal(false);

  readonly parsedInfo = computed(() => parseUrlInfo(this.url()));
  readonly isValid = computed(() => this.parsedInfo().isValid);
  readonly hostname = computed(() => this.parsedInfo().hostname || '');
  readonly isHttps = computed(() => this.parsedInfo().isHttps ?? false);
  readonly protocol = computed(() => this.parsedInfo().protocolType || '');
  readonly protocolLabel = computed(() => this.parsedInfo().protocolLabel || '');
  readonly protocolIcon = computed(
    () => this.parsedInfo().protocolIcon || (this.isHttps() ? 'lock' : 'globe')
  );
  readonly inferredFilename = computed(() => this.parsedInfo().inferredFilename || '');

  readonly effectiveFilename = computed(() => {
    const custom = (this.customFilename() ?? '').trim();
    return custom || this.inferredFilename();
  });

  readonly extension = computed(() => {
    const name = this.effectiveFilename();
    const parts = name.split('.');
    if (parts.length > 1 && parts[parts.length - 1].length <= 10) {
      return parts.pop()?.toLowerCase() || '';
    }
    return '';
  });

  readonly syntheticEntry = computed<Entry>(() => ({
    ID: '',
    Name: this.effectiveFilename() || 'file',
    Path: this.effectiveFilename() || 'file',
    IsDir: false,
    Size: 0,
    MimeType: '',
    ModTime: new Date().toISOString(),
  }));

  readonly fileCategory = computed(() =>
    this.iconService.getFileTypeCategory(this.syntheticEntry())
  );

  readonly isMedia = computed(() => {
    const cat = this.fileCategory();
    if (['image', 'video', 'audio'].includes(cat)) return true;
    return !this.extension() && !this.mediaError();
  });

  readonly canOpenViewer = computed(() => {
    return this.isValid() && this.isMedia() && !this.mediaError();
  });

  readonly targetPreview = computed(() =>
    buildDestinationPreview(this.destinationPath(), this.customFilename(), this.inferredFilename())
  );

  constructor() {
    effect(() => {
      this.url();
      this.customFilename();
      this.mediaError.set(false);
      this.mediaLoaded.set(false);
    });
  }

  onMediaError(): void {
    this.mediaError.set(true);
    this.mediaLoaded.set(true);
  }

  onMediaLoad(): void {
    this.mediaLoaded.set(true);
    this.mediaError.set(false);
  }

  openInViewer(): void {
    const rawUrl = this.url();
    if (!rawUrl || !this.canOpenViewer()) return;
    void this.fileViewerService.openDirectUrl(rawUrl, this.effectiveFilename());
  }
}
