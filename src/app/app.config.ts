import { ApplicationConfig, provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { Location, LocationStrategy, PathLocationStrategy } from '@angular/common';
import { provideTranslateService, TranslateLoader } from '@ngx-translate/core';
import { MultiFileLoader } from './services/i18n/multi-file-loader';
import { ApiClientService } from './services/infrastructure/platform/api-client.service';

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
        deps: [ApiClientService],
      },
      fallbackLang: 'en-US',
      lang: 'en-US',
    }),
  ],
};
