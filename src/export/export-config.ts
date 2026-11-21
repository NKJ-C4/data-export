import path from "node:path";
import { z } from "zod";

const exportFields = [
  "id",
  "sessionId",
  "inspectedAt",
  "result",
  "defectType",
  "confidence",
  "metadata.productionLine",
  "metadata.operator",
] as const;

const exportTransforms = ["uppercase", "iso-date", "percentage"] as const;

const allowedTransformsByField = {
  inspectedAt: ["iso-date"],
  confidence: ["percentage"],
  result: ["uppercase"],
  defectType: ["uppercase"],
  "metadata.productionLine": ["uppercase"],
  "metadata.operator": ["uppercase"],
} as const;

const columnSchema = z
  .object({
    source: z.enum(exportFields),
    header: z.string().trim().min(1, "Column header cannot be empty"),
    transform: z.enum(exportTransforms).optional(),
  })
  .strict()
  .superRefine((column, context) => {
    if (!column.transform) return;

    const allowedTransforms =
      allowedTransformsByField[
        column.source as keyof typeof allowedTransformsByField
      ];

    if (!allowedTransforms?.includes(column.transform as never)) {
      context.addIssue({
        code: "custom",
        path: ["transform"],
        message: `Transform "${column.transform}" cannot be applied to "${column.source}"`,
      });
    }
  });

const destinationPathSchema = z.string().superRefine((destinationPath, context) => {
  const normalizedPath = destinationPath.replaceAll("\\", "/");

  if (
    path.isAbsolute(destinationPath) ||
    normalizedPath.split("/").includes("..") ||
    !normalizedPath.startsWith("output/")
  ) {
    context.addIssue({
      code: "custom",
      message: "Destination path must be a relative path inside output/",
    });
  }

  if (!normalizedPath.toLowerCase().endsWith(".csv")) {
    context.addIssue({
      code: "custom",
      message: "Destination path must end with .csv",
    });
  }
});

export const exportConfigSchema = z
  .object({
    name: z.string().trim().min(1, "Export name is required"),
    tenantId: z.string().trim().min(1, "Tenant ID is required"),
    workspaceId: z.string().trim().min(1, "Workspace ID is required"),
    sessionId: z.string().trim().min(1, "Session ID cannot be empty").optional(),
    filters: z
      .object({
        results: z.array(z.enum(["PASS", "FAIL"])).min(1).optional(),
        minimumConfidence: z.number().min(0).max(1).optional(),
      })
      .strict(),
    columns: z.array(columnSchema).min(1, "At least one column is required"),
    destination: z
      .object({
        type: z.literal("local-file"),
        path: destinationPathSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((config, context) => {
    const seenHeaders = new Set<string>();

    config.columns.forEach((column, index) => {
      const normalizedHeader = column.header.toLowerCase();

      if (seenHeaders.has(normalizedHeader)) {
        context.addIssue({
          code: "custom",
          path: ["columns", index, "header"],
          message: `Duplicate column header "${column.header}"`,
        });
      }

      seenHeaders.add(normalizedHeader);
    });
  });

export type ExportConfig = z.infer<typeof exportConfigSchema>;
export type ExportField = ExportConfig["columns"][number]["source"];
export type ExportTransform = NonNullable<
  ExportConfig["columns"][number]["transform"]
>;

export function validateExportConfig(input: unknown): ExportConfig {
  return exportConfigSchema.parse(input);
}
