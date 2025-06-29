import { Injectable } from "@angular/core";
import { MountManagementService } from "../file-operations/mount-management.service";
import { FieldType, FlagField, FlagType, getDefaultValueForType } from "../../shared/remote-config/remote-config-types";

@Injectable({
  providedIn: "root",
})
export class FlagConfigService {
  public readonly FLAG_TYPES: FlagType[] = [
    "mount",
    "copy",
    "sync",
    "filter",
    "vfs",
  ];

  constructor(private mountManagementService: MountManagementService) {}

  async loadAllFlagFields(): Promise<Record<FlagType, FlagField[]>> {
    const result: Record<FlagType, FlagField[]> = {
      mount: [],
      copy: [],
      sync: [],
      filter: [],
      vfs: [],
    };

    await Promise.all(
      this.FLAG_TYPES.map(async (type) => {
        result[type] = await this.loadFlagFields(type);
      })
    );

    return result;
  }

  private async loadFlagFields(type: FlagType): Promise<FlagField[]> {
    try {
      const methodName = `get${this.capitalizeFirstLetter(type)}Flags`;
      if (typeof (this.mountManagementService as any)[methodName] === "function") {
        const flags = (await (this.mountManagementService as any)[
          methodName
        ]()) as Promise<any[]>;
        console.log(`Loaded ${type} flags:`, flags);
        return this.mapFlagFields(await flags);
      }
      return [];
    } catch (error) {
      console.error(`Error loading ${type} flags:`, error);
      return [];
    }
  }

  private mapFlagFields(fields: any[]): FlagField[] {
    return fields.map((field) => ({
      ValueStr: field.ValueStr ?? "",
      Value: field.Value ?? null,
      name: field.FieldName || field.Name,
      default: field.Default || null,
      help: field.Help || "No description available",
      type: field.Type || "string",
      required: field.Required || false,
      examples: field.Examples || [],
    }));
  }

  toggleOption(
    selectedOptions: Record<string, any>,
    fields: FlagField[],
    fieldName: string
  ): Record<string, any> {
    const newOptions = { ...selectedOptions };
    const field = fields.find((f) => f.name === fieldName);

    if (!field) {
      return newOptions;
    }
    if (newOptions[fieldName] !== undefined) {
      delete newOptions[fieldName];
    } else {
      newOptions[fieldName] = this.getFlagValue(field);
    }

    return newOptions;
  }

  private getFlagValue(field: FlagField): any {
    let value =
      field.Value !== null
        ? field.Value
        : field.ValueStr !== undefined
        ? field.ValueStr
        : field.default !== null
        ? field.default
        : getDefaultValueForType(field.type as FieldType);

    if (field.type === "Tristate") {
      value = false;
    }

    return this.coerceValueToType(value, field.type as FieldType);
  }

  validateFlagOptions(
    jsonString: string,
    fields: FlagField[]
  ): { valid: boolean; cleanedOptions?: Record<string, any> } {
    try {
      const parsedValue = jsonString ? JSON.parse(jsonString) : {};
      const cleanedValue: Record<string, any> = {};

      for (const [key, value] of Object.entries(parsedValue)) {
        const field = fields.find((f) => f.name === key);
        if (field) {
          cleanedValue[key] = this.coerceValueToType(
            value,
            field.type as FieldType
          );
        }
      }

      return { valid: true, cleanedOptions: cleanedValue };
    } catch (error) {
      return { valid: false };
    }
  }

  private capitalizeFirstLetter(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  coerceValueToType(value: any, type: FieldType): any {
    if (value === null || value === undefined || value === "") {
      return getDefaultValueForType(type);
    }

    try {
      switch (type) {
        case "bool":
          if (typeof value === "string") {
            const normalized = value.trim().toLowerCase();
            if (normalized === "true") return true;
            if (normalized === "false") return false;
          }
          return Boolean(value);

        case "int":
        case "int64":
        case "uint32":
        case "SizeSuffix":
          const intValue = parseInt(value, 10);
          return isNaN(intValue) ? getDefaultValueForType(type) : intValue;

        case "stringArray":
        case "CommaSeparatedList":
          if (Array.isArray(value)) return value;
          if (typeof value === "string") {
            return value
              .split(",")
              .map((item) => item.trim())
              .filter((item) => item);
          }
          return [String(value)];

        case "Tristate":
          if (value === "true") return true;
          if (value === "false") return false;
          return value;

        default:
          return value;
      }
    } catch (error) {
      console.warn(
        `Failed to coerce value '${value}' to type '${type}'`,
        error
      );
      return getDefaultValueForType(type);
    }
  }
}
