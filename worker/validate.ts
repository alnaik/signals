// Server-side checks of tool arguments against each tool's JSON schema. The client may
// validate too, but the server never trusts it: arguments are model output.
type Schema = {
  type?: string;
  enum?: unknown[];
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: Schema;
  minimum?: number;
  maximum?: number;
};

export function validate(value: unknown, schema: Schema, at = "input"): string | null {
  if (schema.enum && !schema.enum.includes(value)) return `${at} must be one of ${schema.enum.join(", ")}`;
  switch (schema.type) {
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) return `${at} must be an object`;
      const obj = value as Record<string, unknown>;
      for (const k of schema.required ?? []) if (obj[k] === undefined) return `${at}.${k} is required`;
      for (const [k, v] of Object.entries(obj)) {
        const sub = schema.properties?.[k];
        if (!sub) {
          if (schema.additionalProperties === false) return `${at}.${k} is not allowed`;
          continue;
        }
        const err = validate(v, sub, `${at}.${k}`);
        if (err) return err;
      }
      return null;
    }
    case "array":
      if (!Array.isArray(value)) return `${at} must be an array`;
      for (let i = 0; i < value.length; i++) {
        const err = schema.items ? validate(value[i], schema.items, `${at}[${i}]`) : null;
        if (err) return err;
      }
      return null;
    case "string":
      return typeof value === "string" ? null : `${at} must be a string`;
    case "integer":
    case "number":
      if (typeof value !== "number" || (schema.type === "integer" && !Number.isInteger(value)))
        return `${at} must be a ${schema.type}`;
      if (schema.minimum !== undefined && value < schema.minimum) return `${at} is below ${schema.minimum}`;
      if (schema.maximum !== undefined && value > schema.maximum) return `${at} is above ${schema.maximum}`;
      return null;
    case "boolean":
      return typeof value === "boolean" ? null : `${at} must be true or false`;
    default:
      return null;
  }
}
