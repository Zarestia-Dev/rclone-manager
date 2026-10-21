import { DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  FormArray,
  FormBuilder,
  FormControl,
  FormGroup,
  ValidatorFn,
  Validators,
} from '@angular/forms';
import { merge } from 'rxjs';
import { FlagType, PathGroup, RcConfigOption } from '@app/types';
import { requiredIfCronEnabled, requiredIfWatchEnabled } from 'src/app/shared/validators';
import { OPERATION_PATH_MAPPINGS } from './profile-mapper.utils';
import { staticFlagDefinitions } from '../flag-definitions';
import { getAppConfigValues } from '../../../shared/utils/profile-config.util';

export function createPathFormGroup(
  fb: FormBuilder,
  initial: Partial<PathGroup> & { filename?: string } = {}
): FormGroup {
  return fb.group({ type: 'currentRemote', path: '', remote: '', filename: '', ...initial });
}

/** Constructs the same operation schema for profiles, quick runs and quick creation. */
export function createConfigFormGroup(
  fb: FormBuilder,
  type: FlagType,
  destroyRef: DestroyRef,
  values: Record<string, unknown> = {}
): FormGroup {
  const mapping = OPERATION_PATH_MAPPINGS[type];
  if (!mapping) {
    const options = fb.group({});
    patchConfigOptions(options, (values['options'] as Record<string, unknown> | undefined) ?? {});
    return fb.group({ options });
  }

  const path = (value: unknown, defaultType: PathGroup['type']): FormGroup =>
    createPathFormGroup(fb, { type: defaultType, ...(value as Partial<PathGroup> | undefined) });
  const sourceValue = values['source'];
  const source = mapping.isSourceArray
    ? fb.array(
        (Array.isArray(sourceValue) && sourceValue.length ? sourceValue : [{}]).map(value =>
          path(value, 'currentRemote')
        )
      )
    : path(sourceValue, 'currentRemote');
  const options = fb.group({});
  const subtype =
    type === 'serve' ? { type: 'http' } : type === 'mount' ? { mountType: 'mount' } : {};
  const staticDefaults = Object.fromEntries(
    (staticFlagDefinitions[type] ?? []).map(field => [
      field.Name || field.FieldName,
      field.Value ?? field.Default ?? null,
    ])
  );
  patchConfigOptions(options, {
    ...staticDefaults,
    ...subtype,
    ...(values['options'] as Record<string, unknown>),
  });
  const group = fb.group({
    ...getAppConfigValues(values),
    source,
    ...(mapping.destKey ? { dest: path(values['dest'], 'local') } : {}),
    options,
  });
  setupOperationValidation(group, destroyRef);
  return group;
}

export function setupOperationValidation(group: FormGroup, destroyRef: DestroyRef): void {
  const cron = group.get('cronExpression');
  const delay = group.get('watchDelay');
  cron?.addValidators(requiredIfCronEnabled());
  delay?.addValidators(requiredIfWatchEnabled());
  const refresh = (): void => {
    cron?.updateValueAndValidity({ onlySelf: true, emitEvent: false });
    delay?.updateValueAndValidity({ onlySelf: true, emitEvent: false });
    group.updateValueAndValidity({ emitEvent: false });
  };
  merge(
    ...['cronEnabled', 'watchEnabled'].flatMap(key => {
      const control = group.get(key);
      return control ? [control.valueChanges] : [];
    })
  )
    .pipe(takeUntilDestroyed(destroyRef))
    .subscribe(refresh);
  refresh();
}

export interface DynamicControlOptions {
  preserveKeys?: ReadonlySet<string>;
  prune?: boolean;
  reset?: boolean;
  required?: boolean;
}

// A distinct validator identity keeps caller-owned `Validators.required` intact.
const metadataRequired: ValidatorFn = control => Validators.required(control);

/** Reconciles metadata without recreating matching controls or losing their validators. */
export function reconcileDynamicControls(
  group: FormGroup,
  fields: readonly RcConfigOption[],
  options: DynamicControlOptions = {}
): void {
  const keys = new Set(fields.map(field => field.Name || field.FieldName).filter(Boolean));
  for (const key of Object.keys(group.controls)) {
    if (options.preserveKeys?.has(key)) continue;
    if (options.reset || (options.prune && !keys.has(key))) {
      group.removeControl(key, { emitEvent: false });
    }
  }
  for (const field of fields) {
    const key = field.Name || field.FieldName;
    if (!key) continue;
    const existing = group.get(key);
    if (existing) {
      existing.removeValidators(metadataRequired);
      if (options.required !== false && field.Required) existing.addValidators(metadataRequired);
      existing.updateValueAndValidity({ onlySelf: true, emitEvent: false });
    } else {
      const control = new FormControl(
        field.Value ?? field.Default ?? null,
        options.required !== false && field.Required ? metadataRequired : null
      );
      group.addControl(key, control, { emitEvent: false });
    }
  }
  group.updateValueAndValidity();
}

/** Patches known and custom options with one aggregate form emission. */
export function patchConfigOptions(
  group: FormGroup,
  values: Record<string, unknown>,
  fields: readonly RcConfigOption[] = []
): void {
  const definitions = new Map(
    fields.flatMap(
      field =>
        [
          [field.Name, field],
          [field.FieldName, field],
        ] as const
    )
  );
  for (const [key, value] of Object.entries(values)) {
    const field = definitions.get(key);
    const controlKey = field ? field.Name || field.FieldName : key;
    const control = group.get(controlKey);
    if (control) control.setValue(value, { onlySelf: true, emitEvent: false });
    else group.addControl(controlKey, new FormControl(value), { emitEvent: false });
  }
  group.updateValueAndValidity();
}

export function patchConfigPaths(group: FormGroup, values: Record<string, unknown>): void {
  const source = group.get('source');
  const fb = new FormBuilder();
  const incomingSource = values['source'];
  if (incomingSource !== undefined) {
    if (source instanceof FormArray) {
      source.clear({ emitEvent: false });
      const paths = Array.isArray(incomingSource) ? incomingSource : [incomingSource];
      for (const value of paths.length ? paths : [{}]) {
        source.push(createPathFormGroup(fb, value), { emitEvent: false });
      }
    } else source?.patchValue(incomingSource, { onlySelf: true, emitEvent: false });
    source?.updateValueAndValidity({ onlySelf: true });
  }
  if (values['dest'] !== undefined) {
    const dest = group.get('dest');
    dest?.patchValue(values['dest'], { onlySelf: true, emitEvent: false });
    dest?.updateValueAndValidity({ onlySelf: true });
  }
  group.updateValueAndValidity();
}
