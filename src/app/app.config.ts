import { MAT_DIALOG_DEFAULT_OPTIONS, MatDialogConfig } from '@angular/material/dialog';
import {
  ApplicationConfig,
  inject,
  provideAppInitializer,
  provideZonelessChangeDetection,
} from '@angular/core';
import { HttpClient, provideHttpClient } from '@angular/common/http';
import { Location, LocationStrategy, PathLocationStrategy } from '@angular/common';
import {
  provideTranslateCompiler,
  provideTranslateService,
  TranslateLoader,
} from '@ngx-translate/core';
import { MultiFileLoader } from './services/i18n/multi-file-loader';
import { LocaleService } from './services/i18n/locale.service';
import { DialogLabelsService } from './services/ui/dialog-labels.service';
import { PluralCompiler } from './services/i18n/plural';

/**
 * Defaults for every MatDialog. Material uses this object in place of `new MatDialogConfig()`, not
 * on top of it, so it starts from those defaults: without them dialogs lose `role="dialog"`, do not
 * move focus inside when they open, and do not return it when they close.
 */
export const DIALOG_DEFAULT_OPTIONS: MatDialogConfig = {
  ...new MatDialogConfig(),
  closeOnNavigation: false,
};

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideAppInitializer(() => {
      inject(LocaleService);
      inject(DialogLabelsService);
    }),
    { provide: MAT_DIALOG_DEFAULT_OPTIONS, useValue: DIALOG_DEFAULT_OPTIONS },
    provideHttpClient(),
    Location,
    { provide: LocationStrategy, useClass: PathLocationStrategy },
    provideTranslateService({
      loader: {
        provide: TranslateLoader,
        useClass: MultiFileLoader,
        deps: [HttpClient],
      },
      compiler: provideTranslateCompiler(PluralCompiler),
      fallbackLang: 'en-US',
      lang: 'en-US',
    }),
  ],
};
