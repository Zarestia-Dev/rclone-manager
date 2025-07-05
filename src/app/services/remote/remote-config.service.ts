import { Injectable } from "@angular/core";
import { AbstractControl, ValidationErrors, Validators } from "@angular/forms";
import { RemoteManagementService } from "./remote-management.service";
import { FieldType, getDefaultValueForType, RemoteField, RemoteType } from "../../shared/remote-config/remote-config-types";

@Injectable({
  providedIn: "root",
})
export class RemoteConfigService {
  constructor(private remoteManagementService: RemoteManagementService) {}

  async getRemoteTypes(): Promise<RemoteType[]> {
    try {
      const providers = await this.remoteManagementService.getRemoteTypes();
      return providers.map((provider) => ({
        value: provider.name,
        label: provider.description,
      }));
    } catch (error) {
      console.error("Error fetching remote types:", error);
      throw error;
    }
  }

  mapRemoteFields(remoteOptions: any[]): RemoteField[] {
    return remoteOptions.map((option) => ({
      Name: option.Name,
      Type: (option.Type?.toLowerCase() || "string") as FieldType,
      Help: option.Help || "No description available",
      Value: option.Value || null,
      Default: option.Default || null,
      Required: option.Required ?? false,
      Advanced: option.Advanced ?? false,
      Examples: option.Examples || [],
    }));
  }

  createFormControlConfig(field: RemoteField): any {
    const initialValue = this.getInitialValueForField(field);
    const validators = this.getValidatorsForField(field);

    return {
      value: initialValue,
      validators: validators,
    };
  }

  private getInitialValueForField(field: RemoteField): any {
    // Use field.Default if defined, otherwise field.Value, otherwise type default
    const value =
      field.Default !== undefined
        ? field.Default
        : field.Value !== undefined
        ? field.Value
        : getDefaultValueForType(field.Type);

    // Special handling for object types
    if (typeof value === "object" && !Array.isArray(value) && value !== null) {
      if (field.Type === "bool") {
        return false;
      }
      return JSON.stringify(value);
    }

    return value;
  }

  private getValidatorsForField(field: RemoteField): any[] {
    const validators = [];

    if (field.Required) {
      validators.push(Validators.required);
    }

    // Add type-specific validators
    switch (field.Type) {
      case "int":
      case "int64":
      case "uint32":
      case "SizeSuffix":
        validators.push(Validators.pattern("^[0-9]*$"));
        break;
      case "stringArray":
      case "CommaSeparatedList":
        validators.push(this.arrayValidator);
        break;
    }

    return validators;
  }

  private arrayValidator(control: AbstractControl): ValidationErrors | null {
    if (!control.value) return null;
    try {
      const arr = Array.isArray(control.value)
        ? control.value
        : JSON.parse(control.value);
      if (!Array.isArray(arr)) {
        return { invalidArray: true };
      }
      return null;
    } catch {
      return { invalidArray: true };
    }
  }
}
