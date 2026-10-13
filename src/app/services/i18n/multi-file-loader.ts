import { HttpClient } from '@angular/common/http';
import { TranslateLoader, TranslationObject } from '@ngx-translate/core';
import { Observable, forkJoin, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';

/**
 * Custom loader to load multiple translation files for a single language
 * from static assets and merge them into a single object.
 */
export class MultiFileLoader implements TranslateLoader {
  constructor(private http: HttpClient) {}

  public getTranslation(lang: string): Observable<TranslationObject> {
    const files = ['main.json', 'rclone.json', 'rclone-providers.json'];
    const requests = files.map(file =>
      this.http.get<TranslationObject>(`assets/i18n/${lang}/${file}`).pipe(
        catchError(() => {
          if (lang !== 'en-US') {
            return this.http
              .get<TranslationObject>(`assets/i18n/en-US/${file}`)
              .pipe(catchError(() => of({} as TranslationObject)));
          }
          return of({} as TranslationObject);
        })
      )
    );

    return forkJoin(requests).pipe(
      map(responses => {
        const merged: TranslationObject = {};
        for (const res of responses) {
          if (res && typeof res === 'object') {
            Object.assign(merged, res);
          }
        }
        return merged;
      })
    );
  }
}
