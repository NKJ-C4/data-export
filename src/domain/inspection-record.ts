export type InspectionResult = "PASS" | "FAIL";

export interface InspectionRecord {
  id: string;
  tenantId: string;
  workspaceId: string;
  sessionId: string;
  inspectedAt: string;
  result: InspectionResult;
  defectType?: string;
  confidence: number;
  metadata: {
    productionLine: string;
    operator?: string;
  };
}
