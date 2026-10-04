export * from "./generated/api";
export * from "./generated/types";
// Operations that have both path and query parameters make orval emit a zod
// path-params schema (api.ts) and a TypeScript query-params type (types/)
// under the same name. Re-export the zod schemas explicitly so the barrel is
// unambiguous; the query-param shapes are available as *QueryParams schemas.
export {
  ListTemplateDraftsParams,
  UploadTemplateMediaParams,
} from "./generated/api";
