import { TranslateLoader } from '@ngx-translate/core';
import { Observable, from } from 'rxjs';
import { ApiClientService } from '../../services/core/api-client.service';

/**
 * Custom loader to load multiple translation files for a single language
 * and merge them into a single object.
 */
export class MultiFileLoader implements TranslateLoader {
  constructor(private apiClient: ApiClientService) {}

  public getTranslation(lang: string): Observable<any> {
    return from(this.apiClient.invoke<Record<string, unknown>>('get_i18n', { lang }));
  }
}
