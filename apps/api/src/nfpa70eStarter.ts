import type { AuditDefinition } from "./auditDefinition";

export const nfpa70eStarter = {
  description:
    "A customizable readiness review based on high-level electrical safety themes. This is not an official NFPA checklist, certification, or substitute for the complete standard and qualified professional judgment.",
  name: "NFPA 70E readiness checklist",
  definition: {
    sections: [
      section("program", "Electrical safety program", [
        "A documented electrical safety program is available to affected workers.",
        "Electrical safety responsibilities are assigned and understood.",
        "The program considers the condition of maintenance of electrical equipment.",
      ]),
      section("training", "Training and qualification", [
        "Workers are qualified for the specific equipment and tasks they perform.",
        "Electrical safety and emergency response training records are current.",
        "Unqualified workers receive training appropriate to their electrical exposure.",
      ]),
      section("planning", "Risk assessment and job planning", [
        "Job planning identifies potential shock and arc-flash hazards.",
        "Required shock and arc-flash risk assessments are documented and current.",
        "Energized work is justified and permitted only when applicable requirements are met.",
      ]),
      section("safe-condition", "Electrically safe work condition", [
        "A documented policy prioritizes establishing an electrically safe work condition.",
        "Lockout/tagout and absence-of-voltage verification procedures are followed.",
        "Test instruments are suitable, inspected, and used by qualified people.",
      ]),
      section("protection", "PPE, tools, and work area", [
        "Task-specific PPE is selected from the documented hazard assessment.",
        "Protective equipment and insulated tools are inspected and maintained.",
        "Required labels, signs, barriers, and boundaries are current and legible.",
      ]),
      section("review", "Maintenance and continuous improvement", [
        "Electrical equipment is maintained in a condition appropriate for safe operation.",
        "The electrical safety program is periodically audited.",
        "Deficiencies and corrective actions are documented and tracked to closure.",
      ]),
    ],
    version: 1,
  } satisfies AuditDefinition,
};

function section(id: string, title: string, prompts: string[]) {
  return {
    id,
    items: prompts.map((prompt, index) => ({
      id: `${id}-${index + 1}`,
      prompt,
      required: true,
      responseType: "check" as const,
    })),
    title,
  };
}
