import { HttpClient } from '@angular/common/http';
import { TranslateLoader } from '@ngx-translate/core';
import { Observable, forkJoin, map } from 'rxjs';

/**
 * Custom loader to load multiple translation files for a single language
 * and merge them into a single object.
 */
export class MultiFileLoader implements TranslateLoader {
  constructor(
    private http: HttpClient,
    private prefix = '/assets/i18n/',
    private files: string[] = ['main', 'rclone']
  ) {}

  public getTranslation(lang: string): Observable<any> {
    const requests = this.files.map(file => this.http.get(`${this.prefix}${lang}/${file}.json`));

    return forkJoin(requests).pipe(
      map(responses => {
        return responses.reduce((acc, curr) => this.deepMerge(acc, curr), {});
      })
    );
  }

  private deepMerge(target: any, source: any): any {
    const output = Object.assign({}, target);
    if (this.isObject(target) && this.isObject(source)) {
      Object.keys(source).forEach(key => {
        if (this.isObject(source[key])) {
          if (!(key in target)) {
            Object.assign(output, { [key]: source[key] });
          } else {
            output[key] = this.deepMerge(target[key], source[key]);
          }
        } else {
          Object.assign(output, { [key]: source[key] });
        }
      });
    }
    return output;
  }

  private isObject(item: any): boolean {
    return item && typeof item === 'object' && !Array.isArray(item);
  }
}
