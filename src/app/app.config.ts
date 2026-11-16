import { MAT_DIALOG_DEFAULT_OPTIONS } from '@angular/material/dialog';
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
import { PluralCompiler } from './services/i18n/plural';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideAppInitializer(() => {
      inject(LocaleService);
    }),
    { provide: MAT_DIALOG_DEFAULT_OPTIONS, useValue: { closeOnNavigation: false } },
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
