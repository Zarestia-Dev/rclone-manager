import { ApplicationConfig, provideZonelessChangeDetection } from '@angular/core';
import { HttpClient, provideHttpClient } from '@angular/common/http';
import { Location, LocationStrategy, PathLocationStrategy } from '@angular/common';
import { provideTranslateService, TranslateLoader } from '@ngx-translate/core';
import { MultiFileLoader } from './services/i18n/multi-file-loader';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideHttpClient(),
    Location,
    { provide: LocationStrategy, useClass: PathLocationStrategy },
    provideTranslateService({
      loader: {
        provide: TranslateLoader,
        useClass: MultiFileLoader,
        deps: [HttpClient],
      },
      fallbackLang: 'en-US',
      lang: 'en-US',
    }),
  ],
};
