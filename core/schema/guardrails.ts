export interface SchemaDefinition { readonly name: string; readonly version: number; readonly required: readonly string[]; readonly fields: Readonly<Record<string, "string" | "number" | "boolean" | "object">>; }
export interface SchemaGuardResult { readonly compatible: boolean; readonly breaking: readonly string[]; }

export function validateSchemaRecord(definition: SchemaDefinition, value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return definition.required.every((key) => key in record) && Object.entries(definition.fields).every(([key, type]) => !(key in record) || typeof record[key] === type);
}

export function checkSchemaEvolution(previous: SchemaDefinition, next: SchemaDefinition): SchemaGuardResult {
  const breaking = previous.required.filter((key) => !next.required.includes(key) || !(key in next.fields));
  for (const key of previous.required) if (next.fields[key] && previous.fields[key] !== next.fields[key]) breaking.push(`${key}:type`);
  if (next.version <= previous.version) breaking.push("version must increase");
  return { compatible: breaking.length === 0, breaking };
}
