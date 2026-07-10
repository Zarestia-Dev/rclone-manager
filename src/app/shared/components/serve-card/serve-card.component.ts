import { Component, inject, input, output, computed, ChangeDetectionStrategy } from '@angular/core';
import { UpperCasePipe } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { ServeListItem, TYPE_INFO, DEFAULT_ICON, URL_BASED_PROTOCOLS } from '@app/types';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { CopyToClipboardDirective } from '../../directives/copy-to-clipboard.directive';

@Component({
  selector: 'app-serve-card',
  imports: [
    UpperCasePipe,
    MatCardModule,
    MatIconModule,
    MatButtonModule,
    MatTooltipModule,
    TranslatePipe,
    CopyToClipboardDirective,
  ],
  templateUrl: './serve-card.component.html',
  styleUrl: './serve-card.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ServeCardComponent {
  private readonly translate = inject(TranslateService);
  private readonly pathService = inject(PathService);

  serve = input.required<ServeListItem>();
  showRemoteName = input(false);

  stopServe = output<ServeListItem>();
  cardClick = output<ServeListItem>();

  serveIcon = computed<string>(() => {
    const type = this.serve().params.type.toLowerCase();
    return TYPE_INFO[type]?.icon ?? DEFAULT_ICON;
  });

  serveUrl = computed<string | null>(() => {
    const type = this.serve().params.type.toLowerCase();
    const addr = this.serve().addr;

    return URL_BASED_PROTOCOLS.has(type) ? `${type}://${addr}` : null;
  });

  optionsData = computed<{ keys: string[]; tooltip: string }>(() => {
    const params = this.serve().params;
    const keys = Object.keys(params);

    if (keys.length === 0) {
      return { keys: [], tooltip: this.translate.instant('shared.serveCard.messages.noOptions') };
    }

    const tooltip = keys
      .map(key => {
        const value = params[key as keyof typeof params];
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          const nested = Object.entries(value)
            .map(([k, v]) => `  ${k}: ${v}`)
            .join('\n');
          return `${key}:\n${nested}`;
        }
        return `${key}: ${JSON.stringify(value)}`;
      })
      .join('\n');

    return { keys, tooltip };
  });

  remoteName = computed<string>(() => this.pathService.getRemoteNameFromFs(this.serve().params.fs));

  onStopServe(): void {
    this.stopServe.emit(this.serve());
  }

  onCardClick(): void {
    this.cardClick.emit(this.serve());
  }
}
