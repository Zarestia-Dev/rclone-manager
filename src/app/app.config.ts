import { ApplicationConfig } from '@angular/core';
import { provideHttpClient, withFetch, HttpClient } from '@angular/common/http';
import { provideTranslateService, TranslateLoader } from '@ngx-translate/core';
import { MultiFileLoader } from './core/i18n/multi-file-loader';

export const appConfig: ApplicationConfig = {
  providers: [
    provideHttpClient(withFetch()),
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
