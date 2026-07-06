import { ApplicationConfig, provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideTranslateService, TranslateLoader } from '@ngx-translate/core';
import { MultiFileLoader } from './services/i18n/multi-file-loader';
import { ApiClientService } from './services/infrastructure/platform/api-client.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideHttpClient(),
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
