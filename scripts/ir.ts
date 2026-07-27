/** Intermediate representation shared by the scraper, prober and generator. */

export type ParamType =
  | "TEXT"
  | "NUMBER"
  | "BOOLEAN"
  | "JSON"
  | "CSV"
  | "DATE"
  | "HTML"
  | "XML";

export interface Param {
  name: string;
  type: ParamType;
  required: boolean;
  description: string;
  maxLength?: number;
  enum?: string[];
  default?: string;
  /** Documented shape of a JSON-typed param. */
  fields?: Param[];
  /** True when the JSON param is an array of `fields` rather than one object. */
  isArray?: boolean;
}

export interface Endpoint {
  /** Doc anchor, e.g. "/account/create.json". */
  anchor: string;
  method: "GET" | "POST";
  /** e.g. "/api/v1/account/create.json" */
  path: string;
  /** Breadcrumb trail, e.g. ["Account", "Category"]. */
  group: string[];
  summary: string;
  description: string;
  params: Param[];
}

export interface Spec {
  source: string;
  baseUrlTemplate: string;
  endpoints: Endpoint[];
}

/** A response shape inferred from live API calls (spec/responses.json). */
export type Shape =
  | { kind: "scalar"; types: ScalarType[] }
  | { kind: "object"; fields: Record<string, ShapeField> }
  | { kind: "array"; items: Shape }
  | { kind: "unknown" };

export type ScalarType = "string" | "number" | "boolean" | "null";

export interface ShapeField {
  shape: Shape;
  /** True when the key was absent from at least one sample. */
  optional: boolean;
}

export interface InferredResponse {
  /** How the payload was wrapped: `{data,...}`, `{success,...}`, or bare. */
  envelope: "data" | "write" | "raw";
  /** Shape of the unwrapped payload (the `data` value for `list`). */
  shape: Shape;
  /** Number of live objects the inference is based on. */
  samples: number;
  /** Set when probing failed; `shape` is then `unknown`. */
  error?: string;
}

export interface ResponseSpec {
  probedAt: string;
  organisation: string;
  responses: Record<string, InferredResponse>;
}
