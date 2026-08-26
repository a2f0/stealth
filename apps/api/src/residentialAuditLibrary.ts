import type { AuditDefinition } from "./auditDefinition";

const reviewedAt = "2026-08-26";

const taxonomy = {
  domains: [
    "worker-safety",
    "public-safety",
    "installation-quality",
    "building-life-safety",
    "environmental-health",
    "project-controls",
  ],
  hazards: [
    "asbestos",
    "caught-between",
    "chemical-exposure",
    "collapse",
    "combustion",
    "confined-space",
    "electrical",
    "ergonomics",
    "fall",
    "falling-object",
    "fire-explosion",
    "heat-cold",
    "lead",
    "mobile-equipment",
    "noise",
    "public-interface",
    "respiratory",
    "silica-dust",
    "struck-by",
    "water-intrusion",
  ],
  phases: [
    "preconstruction",
    "pre-task",
    "pre-installation",
    "in-progress",
    "pre-cover",
    "testing",
    "closeout",
    "daily",
  ],
  questionClasses: [
    "applicability-gate",
    "document-review",
    "field-observation",
    "measurement",
    "material-verification",
    "pre-cover-hold-point",
    "test-result",
    "closeout-verification",
  ],
  verificationMethods: [
    "document",
    "interview",
    "measurement",
    "observation",
    "photo",
    "test-record",
  ],
  workCategories: [
    "project-readiness",
    "site-conditions",
    "tools-equipment-exposures",
    "demolition-existing",
    "earthwork-utilities",
    "foundations-concrete-masonry",
    "framing-structure",
    "falls-ladders-scaffolds",
    "roofing",
    "building-envelope",
    "plumbing",
    "hvac-fuel-gas",
    "electrical",
    "insulation-air-moisture",
    "fire-life-safety",
    "interior-finishes",
    "stairs-decks-guards",
    "exterior-drainage",
    "commissioning-closeout",
  ],
} as const;

type Domain = (typeof taxonomy.domains)[number];
type Hazard = (typeof taxonomy.hazards)[number];
type Phase = (typeof taxonomy.phases)[number];
type QuestionClass = (typeof taxonomy.questionClasses)[number];
type VerificationMethod = (typeof taxonomy.verificationMethods)[number];
type WorkCategory = (typeof taxonomy.workCategories)[number];

type AuthorityType =
  | "federal-regulation"
  | "federal-guidance"
  | "model-code"
  | "industry-reference"
  | "project-requirement";

interface SourceEntry {
  authority: AuthorityType;
  copyrightUse: "government-work" | "reference-only" | "project-supplied";
  id: string;
  jurisdiction: "project" | "us-federal" | "us-model";
  notes: string;
  reviewedAt: string;
  title: string;
  url?: string;
  version: string;
}

interface SourceReference {
  locator: string;
  sourceId: string;
}

type RiskPriority = "critical" | "high" | "medium" | "low";

interface ResidentialControl {
  applicability: string;
  category: WorkCategory;
  domains: Domain[];
  evidence: string[];
  guidance: string;
  hazards: Hazard[];
  id: string;
  phases: Phase[];
  prompt: string;
  questionClass: QuestionClass;
  risk: {
    priority: RiskPriority;
    stopWorkCandidate: boolean;
  };
  sourceRefs: SourceReference[];
  verificationMethods: VerificationMethod[];
}

interface ControlDraft {
  applicability?: string;
  domains?: Domain[];
  evidence?: string[];
  guidance?: string;
  hazards?: Hazard[];
  id: string;
  phases?: Phase[];
  prompt: string;
  questionClass?: QuestionClass;
  risk?: Partial<ResidentialControl["risk"]>;
  sourceRefs?: SourceReference[];
  verificationMethods?: VerificationMethod[];
}

interface SectionDefaults {
  applicability: string;
  domains: Domain[];
  evidence: string[];
  guidance: string;
  hazards: Hazard[];
  phases: Phase[];
  questionClass: QuestionClass;
  risk: ResidentialControl["risk"];
  sourceRefs: SourceReference[];
  verificationMethods: VerificationMethod[];
}

interface ResidentialSection {
  category: WorkCategory;
  controls: ResidentialControl[];
  id: string;
  title: string;
}

interface SectionDraft {
  category: WorkCategory;
  controls: ControlDraft[];
  defaults: SectionDefaults;
  id: string;
  title: string;
}

const sources: SourceEntry[] = [
  {
    authority: "federal-regulation",
    copyrightUse: "government-work",
    id: "osha-1926-general",
    jurisdiction: "us-federal",
    notes:
      "Federal construction safety baseline. OSHA-approved State Plans may add or differ.",
    reviewedAt,
    title: "29 CFR Part 1926 — Safety and Health Regulations for Construction",
    url: "https://www.osha.gov/laws-regs/regulations/standardnumber/1926/",
    version: "Current electronic edition",
  },
  {
    authority: "federal-regulation",
    copyrightUse: "government-work",
    id: "osha-1926-fall",
    jurisdiction: "us-federal",
    notes:
      "Use the activity-specific provision and exceptions; do not apply a single threshold to every fall exposure.",
    reviewedAt,
    title: "29 CFR 1926 Subpart M — Fall Protection",
    url: "https://www.osha.gov/laws-regs/regulations/standardnumber/1926/1926.501",
    version: "Current electronic edition",
  },
  {
    authority: "federal-guidance",
    copyrightUse: "government-work",
    id: "osha-residential-fall-guidance",
    jurisdiction: "us-federal",
    notes:
      "Compliance assistance for residential construction; guidance does not create new legal obligations.",
    reviewedAt,
    title: "OSHA Fall Protection in Residential Construction",
    url: "https://www.osha.gov/residential-fall-protection/guidance",
    version: "Current web edition",
  },
  {
    authority: "federal-regulation",
    copyrightUse: "government-work",
    id: "osha-1926-ladders",
    jurisdiction: "us-federal",
    notes: "Construction stairway and ladder requirements.",
    reviewedAt,
    title: "29 CFR 1926 Subpart X — Stairways and Ladders",
    url: "https://www.osha.gov/laws-regs/regulations/standardnumber/1926/1926.1053",
    version: "Current electronic edition",
  },
  {
    authority: "federal-regulation",
    copyrightUse: "government-work",
    id: "osha-1926-scaffolds",
    jurisdiction: "us-federal",
    notes: "Construction scaffold requirements.",
    reviewedAt,
    title: "29 CFR 1926 Subpart L — Scaffolds",
    url: "https://www.osha.gov/laws-regs/regulations/standardnumber/1926/1926.451",
    version: "Current electronic edition",
  },
  {
    authority: "federal-regulation",
    copyrightUse: "government-work",
    id: "osha-1926-excavations",
    jurisdiction: "us-federal",
    notes: "Construction excavation and trenching requirements.",
    reviewedAt,
    title: "29 CFR 1926 Subpart P — Excavations",
    url: "https://www.osha.gov/laws-regs/regulations/standardnumber/1926/1926.651",
    version: "Current electronic edition",
  },
  {
    authority: "federal-regulation",
    copyrightUse: "government-work",
    id: "osha-1926-electrical",
    jurisdiction: "us-federal",
    notes:
      "Construction electrical safety requirements, including temporary power.",
    reviewedAt,
    title: "29 CFR 1926 Subpart K — Electrical",
    url: "https://www.osha.gov/laws-regs/regulations/standardnumber/1926/1926.404",
    version: "Current electronic edition",
  },
  {
    authority: "federal-regulation",
    copyrightUse: "government-work",
    id: "osha-1926-ppe",
    jurisdiction: "us-federal",
    notes:
      "Construction personal protective and lifesaving equipment requirements.",
    reviewedAt,
    title:
      "29 CFR 1926 Subpart E — Personal Protective and Life Saving Equipment",
    url: "https://www.osha.gov/laws-regs/regulations/standardnumber/1926/1926.95",
    version: "Current electronic edition",
  },
  {
    authority: "federal-regulation",
    copyrightUse: "government-work",
    id: "osha-1926-fire",
    jurisdiction: "us-federal",
    notes: "Construction fire prevention and protection requirements.",
    reviewedAt,
    title: "29 CFR 1926 Subpart F — Fire Protection and Prevention",
    url: "https://www.osha.gov/laws-regs/regulations/standardnumber/1926/1926.150",
    version: "Current electronic edition",
  },
  {
    authority: "federal-regulation",
    copyrightUse: "government-work",
    id: "osha-1926-tools",
    jurisdiction: "us-federal",
    notes: "Construction hand and power tool requirements.",
    reviewedAt,
    title: "29 CFR 1926 Subpart I — Tools — Hand and Power",
    url: "https://www.osha.gov/laws-regs/regulations/standardnumber/1926/1926.300",
    version: "Current electronic edition",
  },
  {
    authority: "federal-regulation",
    copyrightUse: "government-work",
    id: "osha-1926-material-handling",
    jurisdiction: "us-federal",
    notes:
      "Construction material handling, storage, disposal, and rigging requirements.",
    reviewedAt,
    title:
      "29 CFR 1926 Subpart H — Materials Handling, Storage, Use, and Disposal",
    url: "https://www.osha.gov/laws-regs/regulations/standardnumber/1926/1926.250",
    version: "Current electronic edition",
  },
  {
    authority: "federal-regulation",
    copyrightUse: "government-work",
    id: "osha-1926-motor-equipment",
    jurisdiction: "us-federal",
    notes:
      "Construction motor vehicle, material-handling equipment, and mechanized-equipment requirements.",
    reviewedAt,
    title: "29 CFR 1926 Subpart O — Motor Vehicles and Mechanized Equipment",
    url: "https://www.osha.gov/laws-regs/regulations/standardnumber/1926/1926.600",
    version: "Current electronic edition",
  },
  {
    authority: "federal-regulation",
    copyrightUse: "government-work",
    id: "osha-1926-welding",
    jurisdiction: "us-federal",
    notes:
      "Construction welding, cutting, cylinder-handling, ventilation, and fire-prevention requirements.",
    reviewedAt,
    title: "29 CFR 1926 Subpart J — Welding and Cutting",
    url: "https://www.osha.gov/laws-regs/regulations/standardnumber/1926/1926.350",
    version: "Current electronic edition",
  },
  {
    authority: "federal-regulation",
    copyrightUse: "government-work",
    id: "osha-respiratory-protection",
    jurisdiction: "us-federal",
    notes:
      "Construction respiratory protection requirements incorporate the general-industry respiratory-protection program requirements.",
    reviewedAt,
    title: "29 CFR 1926.103 — Respiratory Protection",
    url: "https://www.osha.gov/laws-regs/regulations/standardnumber/1926/1926.103",
    version: "Current electronic edition",
  },
  {
    authority: "federal-regulation",
    copyrightUse: "government-work",
    id: "osha-1926-silica",
    jurisdiction: "us-federal",
    notes:
      "Task-specific construction silica exposure controls and related program duties.",
    reviewedAt,
    title: "29 CFR 1926.1153 — Respirable Crystalline Silica",
    url: "https://www.osha.gov/laws-regs/regulations/standardnumber/1926/1926.1153",
    version: "Current electronic edition",
  },
  {
    authority: "federal-regulation",
    copyrightUse: "government-work",
    id: "osha-1926-demolition",
    jurisdiction: "us-federal",
    notes: "Construction demolition requirements.",
    reviewedAt,
    title: "29 CFR 1926 Subpart T — Demolition",
    url: "https://www.osha.gov/laws-regs/regulations/standardnumber/1926/1926.850",
    version: "Current electronic edition",
  },
  {
    authority: "federal-regulation",
    copyrightUse: "government-work",
    id: "osha-1926-concrete",
    jurisdiction: "us-federal",
    notes: "Construction concrete and masonry safety requirements.",
    reviewedAt,
    title: "29 CFR 1926 Subpart Q — Concrete and Masonry Construction",
    url: "https://www.osha.gov/laws-regs/regulations/standardnumber/1926/1926.700",
    version: "Current electronic edition",
  },
  {
    authority: "federal-regulation",
    copyrightUse: "government-work",
    id: "osha-1926-cranes",
    jurisdiction: "us-federal",
    notes:
      "Construction cranes, derricks, hoisting, and signaling requirements.",
    reviewedAt,
    title: "29 CFR 1926 Subpart CC — Cranes and Derricks in Construction",
    url: "https://www.osha.gov/laws-regs/regulations/standardnumber/1926/1926.1400",
    version: "Current electronic edition",
  },
  {
    authority: "federal-regulation",
    copyrightUse: "government-work",
    id: "osha-1926-confined-spaces",
    jurisdiction: "us-federal",
    notes: "Construction confined-space requirements.",
    reviewedAt,
    title: "29 CFR 1926 Subpart AA — Confined Spaces in Construction",
    url: "https://www.osha.gov/laws-regs/regulations/standardnumber/1926/1926.1203",
    version: "Current electronic edition",
  },
  {
    authority: "federal-regulation",
    copyrightUse: "government-work",
    id: "osha-hazard-communication",
    jurisdiction: "us-federal",
    notes:
      "Hazard communication requirements that also apply to construction employers.",
    reviewedAt,
    title: "29 CFR 1910.1200 — Hazard Communication",
    url: "https://www.osha.gov/laws-regs/regulations/standardnumber/1910/1910.1200",
    version: "Current electronic edition",
  },
  {
    authority: "federal-regulation",
    copyrightUse: "government-work",
    id: "epa-lead-rrp",
    jurisdiction: "us-federal",
    notes:
      "Applicability depends on building age, occupancy, work, exclusions, and EPA-authorized state or Tribal programs.",
    reviewedAt,
    title: "EPA Lead Renovation, Repair and Painting Program",
    url: "https://www.epa.gov/lead/renovation-repair-and-painting-program-contractors",
    version: "Current web edition",
  },
  {
    authority: "model-code",
    copyrightUse: "reference-only",
    id: "icc-2024-irc",
    jurisdiction: "us-model",
    notes:
      "Model baseline only. Verify the edition, amendments, interpretations, and approvals adopted by the authority having jurisdiction.",
    reviewedAt,
    title: "2024 International Residential Code",
    url: "https://codes.iccsafe.org/content/IRC2024V2.0/",
    version: "2024, version 2",
  },
  {
    authority: "model-code",
    copyrightUse: "reference-only",
    id: "icc-2024-iecc-residential",
    jurisdiction: "us-model",
    notes:
      "Model baseline only. Climate zone, compliance path, adopted edition, and local amendments control applicability.",
    reviewedAt,
    title:
      "2024 International Energy Conservation Code — Residential Provisions",
    url: "https://codes.iccsafe.org/content/IECC2024V1.2/",
    version: "2024, version 1.2",
  },
  {
    authority: "model-code",
    copyrightUse: "reference-only",
    id: "nfpa-70-nec",
    jurisdiction: "us-model",
    notes:
      "Use the edition adopted by the authority having jurisdiction. NFPA content is copyrighted and is referenced rather than reproduced.",
    reviewedAt,
    title: "NFPA 70 — National Electrical Code",
    url: "https://link.nfpa.org/all-publications/655/",
    version: "Edition adopted by the authority having jurisdiction",
  },
  {
    authority: "federal-guidance",
    copyrightUse: "government-work",
    id: "doe-building-america",
    jurisdiction: "us-federal",
    notes:
      "Building-science guidance and field checklists; not a substitute for adopted code or project requirements.",
    reviewedAt,
    title: "DOE Building America Solution Center",
    url: "https://basc.pnnl.gov/",
    version: "Current web edition",
  },
  {
    authority: "industry-reference",
    copyrightUse: "reference-only",
    id: "astm-construction",
    jurisdiction: "us-model",
    notes:
      "Use only the specific standard and edition invoked by the contract, code, listing, or approved procedure.",
    reviewedAt,
    title: "ASTM Construction Standards",
    url: "https://store.astm.org/products-services/standards-and-publications/standards/construction-standards.html",
    version: "Edition specified by controlling documents",
  },
  {
    authority: "project-requirement",
    copyrightUse: "project-supplied",
    id: "project-documents",
    jurisdiction: "project",
    notes:
      "Contract, drawings, specifications, addenda, accepted changes, approved shop drawings, and RFIs. Apply the contract's order-of-precedence rules.",
    reviewedAt,
    title: "Project construction documents",
    version: "Project-specific current approved revision",
  },
  {
    authority: "project-requirement",
    copyrightUse: "project-supplied",
    id: "manufacturer-instructions",
    jurisdiction: "project",
    notes:
      "Use instructions for the exact product, system, substrate, exposure, and warranty selected for the project.",
    reviewedAt,
    title: "Manufacturer installation and warranty instructions",
    version: "Product-specific current approved revision",
  },
  {
    authority: "project-requirement",
    copyrightUse: "reference-only",
    id: "product-listings",
    jurisdiction: "project",
    notes:
      "Use the complete listing or tested assembly for the installed products and conditions; do not mix details from different systems.",
    reviewedAt,
    title: "Approved product listings and tested assemblies",
    version: "Project-specific listed system",
  },
  {
    authority: "project-requirement",
    copyrightUse: "project-supplied",
    id: "ahj-requirements",
    jurisdiction: "project",
    notes:
      "Permit conditions, adopted codes and amendments, approved alternatives, inspection requirements, and written AHJ direction.",
    reviewedAt,
    title: "Authority-having-jurisdiction requirements",
    version: "Project-specific",
  },
  {
    authority: "project-requirement",
    copyrightUse: "project-supplied",
    id: "utility-requirements",
    jurisdiction: "project",
    notes:
      "Serving utility standards, approved service details, and inspection requirements.",
    reviewedAt,
    title: "Serving utility requirements",
    version: "Project-specific current revision",
  },
];

const ref = (sourceId: string, locator: string): SourceReference => ({
  locator,
  sourceId,
});

const projectRef = ref("project-documents", "Applicable approved documents");
const ahjRef = ref(
  "ahj-requirements",
  "Applicable adopted requirements and approvals",
);
const manufacturerRef = ref(
  "manufacturer-instructions",
  "Exact installed product or system",
);
const ircRef = ref(
  "icc-2024-irc",
  "Applicable model-code chapter; verify local adoption",
);

function defineSection(draft: SectionDraft): ResidentialSection {
  return {
    category: draft.category,
    controls: draft.controls.map((control) => ({
      applicability: control.applicability ?? draft.defaults.applicability,
      category: draft.category,
      domains: control.domains ?? draft.defaults.domains,
      evidence: control.evidence ?? draft.defaults.evidence,
      guidance: control.guidance ?? draft.defaults.guidance,
      hazards: control.hazards ?? draft.defaults.hazards,
      id: control.id,
      phases: control.phases ?? draft.defaults.phases,
      prompt: control.prompt,
      questionClass: control.questionClass ?? draft.defaults.questionClass,
      risk: {
        priority: control.risk?.priority ?? draft.defaults.risk.priority,
        stopWorkCandidate:
          control.risk?.stopWorkCandidate ??
          draft.defaults.risk.stopWorkCandidate,
      },
      sourceRefs: uniqueReferences([
        ...draft.defaults.sourceRefs,
        ...(control.sourceRefs ?? []),
      ]),
      verificationMethods:
        control.verificationMethods ?? draft.defaults.verificationMethods,
    })),
    id: draft.id,
    title: draft.title,
  };
}

function uniqueReferences(references: SourceReference[]) {
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = `${reference.sourceId}:${reference.locator}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const baselineQualityDefaults: SectionDefaults = {
  applicability:
    "Use N/A when the work is outside the project scope. Verify against the adopted jurisdictional requirements and current approved project documents.",
  domains: ["installation-quality"],
  evidence: [
    "Field observation",
    "Approved project document or product instruction",
  ],
  guidance:
    "Treat this as a U.S. residential baseline check, not an independent code-compliance determination.",
  hazards: [],
  phases: ["in-progress", "pre-cover"],
  questionClass: "field-observation",
  risk: { priority: "medium", stopWorkCandidate: false },
  sourceRefs: [projectRef, ahjRef, ircRef],
  verificationMethods: ["observation", "document"],
};

const sections: ResidentialSection[] = [
  defineSection({
    category: "project-readiness",
    controls: [
      {
        id: "res-ready-001",
        prompt:
          "The current permit set, approved revisions, and applicable specifications are available to supervisors and inspectors.",
      },
      {
        id: "res-ready-002",
        prompt:
          "Required permits are active, their conditions are understood, and the required inspection sequence is documented.",
      },
      {
        id: "res-ready-003",
        prompt:
          "The project scope identifies whether the work is new construction, alteration, repair, addition, demolition, or a combination.",
      },
      {
        id: "res-ready-004",
        prompt:
          "Responsibility for safety, quality control, inspections, testing, and correction of deficiencies is assigned.",
      },
      {
        domains: ["worker-safety", "project-controls"],
        hazards: ["collapse", "electrical", "fall", "struck-by"],
        id: "res-ready-005",
        prompt:
          "The employer has designated competent or qualified people for activities that require them.",
        risk: { priority: "high" },
        sourceRefs: [
          ref(
            "osha-1926-general",
            "1926.20(b) and activity-specific provisions",
          ),
        ],
      },
      {
        domains: ["worker-safety", "project-controls"],
        hazards: ["collapse", "electrical", "fall", "struck-by"],
        id: "res-ready-006",
        phases: ["pre-task", "daily"],
        prompt:
          "Current work activities have been evaluated for hazards, controls, sequencing, and interactions with other trades.",
        risk: { priority: "high" },
        sourceRefs: [ref("osha-1926-general", "1926.20 and 1926.21")],
      },
      {
        domains: ["worker-safety", "public-safety"],
        hazards: ["fire-explosion", "public-interface"],
        id: "res-ready-007",
        prompt:
          "Emergency contacts, the site address, access instructions, evacuation actions, and worker communication methods are established.",
        risk: { priority: "high" },
        sourceRefs: [ref("osha-1926-general", "1926.35 and 1926.50")],
      },
      {
        domains: ["worker-safety", "public-safety", "project-controls"],
        hazards: ["electrical", "struck-by"],
        id: "res-ready-008",
        prompt:
          "Known underground and overhead utilities are identified before work that could contact or damage them begins.",
        risk: { priority: "critical", stopWorkCandidate: true },
        sourceRefs: [ref("osha-1926-excavations", "1926.651(b)")],
      },
      {
        domains: ["environmental-health", "worker-safety"],
        hazards: ["chemical-exposure"],
        id: "res-ready-009",
        prompt:
          "A current chemical inventory, labels, safety data sheets, and employee hazard-communication training cover materials in use.",
        risk: { priority: "high" },
        sourceRefs: [ref("osha-hazard-communication", "1910.1200")],
      },
      {
        domains: ["environmental-health", "worker-safety"],
        hazards: ["lead"],
        id: "res-ready-010",
        prompt:
          "For covered renovation work in pre-1978 housing, firm and renovator certifications, occupant notices, and lead-safe work practices are documented.",
        risk: { priority: "high" },
        sourceRefs: [
          ref(
            "epa-lead-rrp",
            "40 CFR Part 745 RRP applicability and work practices",
          ),
        ],
      },
      {
        id: "res-ready-011",
        prompt:
          "Submittals, product selections, delegated designs, and required mockups are approved before the affected work begins.",
      },
      {
        domains: ["project-controls", "installation-quality"],
        id: "res-ready-012",
        phases: ["preconstruction", "pre-installation"],
        prompt:
          "Required hold points, pre-cover inspections, tests, and photo-documentation needs are included in the project schedule.",
      },
    ],
    defaults: {
      ...baselineQualityDefaults,
      domains: ["project-controls"],
      evidence: ["Current project records", "Field interview"],
      phases: ["preconstruction", "pre-installation"],
      questionClass: "document-review",
      verificationMethods: ["document", "interview"],
    },
    id: "project-readiness",
    title: "Project readiness and controls",
  }),
  defineSection({
    category: "site-conditions",
    controls: [
      {
        hazards: ["public-interface"],
        id: "res-site-001",
        prompt:
          "Site boundaries, access restrictions, and public protections are appropriate for the location and current work.",
        risk: { priority: "high" },
      },
      {
        hazards: ["struck-by", "public-interface"],
        id: "res-site-002",
        prompt:
          "Vehicle routes, delivery areas, backing controls, and pedestrian paths are separated or actively controlled.",
        risk: { priority: "critical", stopWorkCandidate: true },
      },
      {
        hazards: ["fall", "struck-by"],
        id: "res-site-003",
        prompt:
          "Access routes and working areas are stable, reasonably level, adequately illuminated, and clear of uncontrolled openings or debris.",
        risk: { priority: "high" },
      },
      {
        hazards: ["fall", "struck-by"],
        id: "res-site-004",
        prompt:
          "Scrap, protruding nails, cords, hoses, packaging, and waste are controlled as work progresses.",
        sourceRefs: [ref("osha-1926-general", "1926.25")],
      },
      {
        hazards: ["struck-by", "caught-between"],
        id: "res-site-005",
        prompt:
          "Stored materials are stable, secured against displacement, and do not overload floors, platforms, or soil edges.",
        risk: { priority: "high" },
        sourceRefs: [ref("osha-1926-general", "1926 Subpart H")],
      },
      {
        hazards: ["fire-explosion"],
        id: "res-site-006",
        prompt:
          "Combustible waste, ignition sources, fuel, compressed-gas cylinders, and temporary heating are separated and controlled.",
        risk: { priority: "critical", stopWorkCandidate: true },
        sourceRefs: [ref("osha-1926-fire", "1926.150 through 1926.155")],
      },
      {
        hazards: ["fire-explosion"],
        id: "res-site-007",
        prompt:
          "Suitable fire extinguishers are accessible, identified, inspected, and located for the work and temporary facilities.",
        risk: { priority: "high" },
        sourceRefs: [ref("osha-1926-fire", "1926.150 and 1926.152")],
      },
      {
        hazards: ["fall", "fire-explosion"],
        id: "res-site-008",
        prompt:
          "Required emergency exits and travel paths remain unobstructed and usable from occupied work areas.",
        risk: { priority: "critical", stopWorkCandidate: true },
        sourceRefs: [ref("osha-1926-general", "1926.34")],
      },
      {
        hazards: ["chemical-exposure", "heat-cold"],
        id: "res-site-009",
        prompt:
          "Potable water, toilets, handwashing provisions, and sanitation are available and maintained for the workforce.",
        sourceRefs: [ref("osha-1926-general", "1926.51")],
      },
      {
        hazards: ["heat-cold"],
        id: "res-site-010",
        prompt:
          "Current weather conditions are addressed, including heat, cold, lightning, wind, ice, rain, and reduced visibility.",
        risk: { priority: "high" },
      },
      {
        hazards: ["struck-by", "falling-object"],
        id: "res-site-011",
        prompt:
          "Signs, tags, barricades, and warnings are visible, legible, and matched to the current hazard.",
        sourceRefs: [ref("osha-1926-general", "1926 Subpart G")],
      },
      {
        hazards: ["chemical-exposure", "struck-by"],
        id: "res-site-012",
        prompt:
          "First-aid supplies and prompt medical-response arrangements are available for the site and crew size.",
        risk: { priority: "high" },
        sourceRefs: [ref("osha-1926-general", "1926.50")],
      },
    ],
    defaults: {
      ...baselineQualityDefaults,
      applicability: "Apply while the construction site is active.",
      domains: ["worker-safety", "public-safety"],
      evidence: ["Field observation"],
      guidance:
        "Evaluate actual site conditions and current operations; correct imminent hazards immediately under the employer's safety program.",
      phases: ["daily", "in-progress"],
      questionClass: "field-observation",
      risk: { priority: "medium", stopWorkCandidate: false },
      sourceRefs: [ref("osha-1926-general", "1926 Subparts C, D, and G")],
      verificationMethods: ["observation", "interview"],
    },
    id: "site-conditions",
    title: "Site conditions and public protection",
  }),
  defineSection({
    category: "tools-equipment-exposures",
    controls: [
      {
        id: "res-tools-001",
        prompt:
          "Required personal protective equipment is selected for the hazard, fits the worker, is serviceable, and is used correctly.",
        sourceRefs: [ref("osha-1926-ppe", "1926.95")],
      },
      {
        hazards: ["struck-by"],
        id: "res-tools-002",
        prompt:
          "Workers exposed to flying particles, splashes, harmful light, or similar hazards use suitable eye and face protection.",
        sourceRefs: [ref("osha-1926-ppe", "1926.102")],
      },
      {
        hazards: ["falling-object", "struck-by"],
        id: "res-tools-003",
        prompt:
          "Workers exposed to head injury use suitable head protection in serviceable condition.",
        sourceRefs: [ref("osha-1926-ppe", "1926.100")],
      },
      {
        hazards: ["noise"],
        id: "res-tools-004",
        prompt:
          "Noise exposure is evaluated and required engineering controls, hearing protection, and hearing-conservation measures are implemented.",
        sourceRefs: [
          ref("osha-1926-general", "1926.52"),
          ref("osha-1926-ppe", "1926.101"),
        ],
      },
      {
        hazards: ["chemical-exposure", "respiratory", "silica-dust"],
        id: "res-tools-005",
        prompt:
          "When respirators are required, the written program, medical evaluation, fit testing, selection, inspection, and worker training are current.",
        risk: { priority: "critical" },
        sourceRefs: [
          ref(
            "osha-respiratory-protection",
            "1926.103 and incorporated 1910.134 requirements",
          ),
        ],
      },
      {
        hazards: ["respiratory", "silica-dust"],
        id: "res-tools-006",
        prompt:
          "Silica-generating tasks use the applicable Table 1 controls or a compliant alternative exposure-control method.",
        risk: { priority: "critical", stopWorkCandidate: true },
        sourceRefs: [ref("osha-1926-silica", "1926.1153(c) or (d)")],
      },
      {
        hazards: ["respiratory", "silica-dust"],
        id: "res-tools-007",
        prompt:
          "Silica housekeeping avoids prohibited dry sweeping, dry brushing, and compressed-air cleaning unless the stated exceptions are met.",
        risk: { priority: "high" },
        sourceRefs: [ref("osha-1926-silica", "1926.1153(f)")],
      },
      {
        hazards: ["caught-between", "struck-by"],
        id: "res-tools-008",
        prompt:
          "Hand and power tools are maintained in safe condition with required guards, controls, handles, and accessories installed.",
        risk: { priority: "high" },
        sourceRefs: [ref("osha-1926-tools", "1926.300")],
      },
      {
        hazards: ["caught-between", "struck-by"],
        id: "res-tools-009",
        prompt:
          "Circular, table, miter, and other saws have functioning guards and are used with the correct blade, support, and work practices.",
        risk: { priority: "critical", stopWorkCandidate: true },
        sourceRefs: [ref("osha-1926-tools", "1926.304")],
      },
      {
        hazards: ["struck-by"],
        id: "res-tools-010",
        prompt:
          "Powder-actuated tools are used only by trained workers and are inspected, loaded, stored, and fired using the required safeguards.",
        risk: { priority: "critical" },
        sourceRefs: [ref("osha-1926-tools", "1926.302(e)")],
      },
      {
        hazards: ["caught-between", "struck-by"],
        id: "res-tools-011",
        prompt:
          "Pneumatic tools, hoses, couplings, safety devices, and pressure settings are suitable and secured against accidental disconnection or discharge.",
        risk: { priority: "high" },
        sourceRefs: [ref("osha-1926-tools", "1926.302(b)")],
      },
      {
        hazards: ["caught-between", "electrical"],
        id: "res-tools-012",
        prompt:
          "Tools and equipment are de-energized or otherwise controlled before blade changes, clearing jams, adjustment, or maintenance.",
        risk: { priority: "critical", stopWorkCandidate: true },
        sourceRefs: [
          ref("osha-1926-tools", "Applicable tool and equipment controls"),
        ],
      },
      {
        hazards: ["ergonomics", "struck-by"],
        id: "res-tools-013",
        prompt:
          "Material size, weight, route, grip, team lifting, and mechanical assistance are planned to avoid uncontrolled handling and overexertion.",
        risk: { priority: "high" },
        sourceRefs: [
          ref(
            "osha-1926-material-handling",
            "1926.250 and applicable handling provisions",
          ),
        ],
      },
      {
        hazards: ["caught-between", "mobile-equipment", "struck-by"],
        id: "res-tools-014",
        prompt:
          "Motor vehicles and mechanized equipment receive required inspections and have functioning brakes, alarms, lights, controls, and seat belts.",
        risk: { priority: "critical", stopWorkCandidate: true },
        sourceRefs: [ref("osha-1926-motor-equipment", "1926.601 and 1926.602")],
      },
      {
        hazards: ["mobile-equipment", "public-interface", "struck-by"],
        id: "res-tools-015",
        prompt:
          "Equipment swing areas, blind spots, backing paths, spotters, exclusion zones, and pedestrian interfaces are controlled.",
        risk: { priority: "critical", stopWorkCandidate: true },
        sourceRefs: [
          ref("osha-1926-motor-equipment", "1926.600 through 1926.602"),
        ],
      },
      {
        hazards: ["collapse", "falling-object", "struck-by"],
        id: "res-tools-016",
        prompt:
          "Crane or hoisting work uses required operator qualifications, inspections, setup, signaling, lift planning, and power-line controls.",
        risk: { priority: "critical", stopWorkCandidate: true },
        sourceRefs: [
          ref("osha-1926-cranes", "Applicable 1926 Subpart CC provisions"),
        ],
      },
      {
        hazards: ["falling-object", "struck-by"],
        id: "res-tools-017",
        prompt:
          "Rigging and lifting accessories are identified, inspected, suitable for the load, protected from damage, and used without workers beneath suspended loads.",
        risk: { priority: "critical", stopWorkCandidate: true },
        sourceRefs: [
          ref("osha-1926-material-handling", "1926.251"),
          ref("osha-1926-cranes", "Applicable rigging and hoisting provisions"),
        ],
      },
      {
        hazards: ["chemical-exposure", "fire-explosion", "respiratory"],
        id: "res-tools-018",
        prompt:
          "Welding, cutting, and brazing control cylinders, combustibles, ventilation, screens, fire watch, and required protective equipment.",
        risk: { priority: "critical", stopWorkCandidate: true },
        sourceRefs: [ref("osha-1926-welding", "1926.350 through 1926.354")],
      },
      {
        hazards: ["chemical-exposure", "confined-space", "respiratory"],
        id: "res-tools-019",
        prompt:
          "Potential confined spaces are identified before entry and required coordination, evaluation, permits, controls, and rescue provisions are implemented.",
        risk: { priority: "critical", stopWorkCandidate: true },
        sourceRefs: [
          ref(
            "osha-1926-confined-spaces",
            "1926.1203 and applicable Subpart AA provisions",
          ),
        ],
      },
      {
        hazards: ["heat-cold"],
        id: "res-tools-020",
        prompt:
          "The work plan addresses temperature stress through acclimatization, hydration, rest, shelter, clothing, monitoring, and emergency response as conditions require.",
        risk: { priority: "high" },
        sourceRefs: [
          ref(
            "osha-1926-general",
            "Applicable health and recognized-hazard controls",
          ),
        ],
      },
    ],
    defaults: {
      ...baselineQualityDefaults,
      applicability:
        "Apply to the tools, equipment, materials, and occupational exposures present during the current work.",
      domains: ["worker-safety"],
      evidence: [
        "Field observation",
        "Inspection, training, or program record when required",
      ],
      guidance:
        "Confirm the control for the specific tool, material, exposure duration, and equipment configuration; remove unsafe equipment from service.",
      hazards: ["caught-between", "struck-by"],
      phases: ["pre-task", "daily", "in-progress"],
      questionClass: "field-observation",
      risk: { priority: "high", stopWorkCandidate: false },
      sourceRefs: [
        ref("osha-1926-ppe", "1926 Subpart E"),
        ref("osha-1926-tools", "1926 Subpart I"),
        ref("osha-1926-material-handling", "1926 Subpart H"),
      ],
      verificationMethods: ["observation", "document", "interview"],
    },
    id: "tools-equipment-exposures",
    title: "PPE, tools, equipment, and health exposures",
  }),
  defineSection({
    category: "demolition-existing",
    controls: [
      {
        hazards: ["collapse"],
        id: "res-demo-001",
        prompt:
          "Before demolition begins, a competent person has documented the condition of framing, floors, walls, and possible unplanned collapse hazards.",
        risk: { priority: "critical", stopWorkCandidate: true },
        sourceRefs: [ref("osha-1926-demolition", "1926.850(a)")],
      },
      {
        hazards: ["electrical", "fire-explosion"],
        id: "res-demo-002",
        prompt:
          "Electric, gas, water, sewer, and other services are shut off, capped, relocated, or otherwise controlled before affected work.",
        risk: { priority: "critical", stopWorkCandidate: true },
        sourceRefs: [
          ref("osha-1926-demolition", "1926.850(b) and 1926.850(c)"),
        ],
      },
      {
        domains: ["environmental-health", "worker-safety"],
        hazards: ["asbestos", "lead", "chemical-exposure"],
        id: "res-demo-003",
        prompt:
          "The pre-work assessment addresses asbestos, lead, mold, silica-containing materials, refrigerants, and other suspect hazardous materials.",
        risk: { priority: "critical", stopWorkCandidate: true },
        sourceRefs: [
          ref(
            "osha-1926-general",
            "1926.1101, 1926.62, and 1926.1153 as applicable",
          ),
          ref("epa-lead-rrp", "RRP applicability"),
        ],
      },
      {
        hazards: ["collapse", "struck-by"],
        id: "res-demo-004",
        prompt:
          "Load-bearing members are removed only in the planned sequence with required temporary support installed.",
        risk: { priority: "critical", stopWorkCandidate: true },
      },
      {
        hazards: ["fall", "falling-object"],
        id: "res-demo-005",
        prompt:
          "Floor openings, wall openings, shafts, and weakened walking surfaces are guarded, covered, or access-controlled.",
        risk: { priority: "critical", stopWorkCandidate: true },
        sourceRefs: [
          ref(
            "osha-1926-fall",
            "1926.501(b)(4), (b)(14), and applicable demolition provisions",
          ),
        ],
      },
      {
        hazards: ["falling-object", "public-interface", "struck-by"],
        id: "res-demo-006",
        prompt:
          "Debris handling, chutes, drop zones, and disposal routes prevent uncontrolled falling material and public exposure.",
        risk: { priority: "high" },
        sourceRefs: [ref("osha-1926-demolition", "1926.852")],
      },
      {
        hazards: ["respiratory", "silica-dust"],
        id: "res-demo-007",
        prompt:
          "Dust-producing demolition uses the required engineering controls, work practices, housekeeping, and respiratory protection.",
        risk: { priority: "high" },
        sourceRefs: [ref("osha-1926-silica", "1926.1153")],
      },
      {
        hazards: ["collapse", "struck-by"],
        id: "res-demo-008",
        prompt:
          "Workers and stored materials are kept clear of unstable walls, unsupported floors, and active mechanical-demolition zones.",
        risk: { priority: "critical", stopWorkCandidate: true },
      },
      {
        hazards: ["chemical-exposure", "fire-explosion"],
        id: "res-demo-009",
        prompt:
          "Removed hazardous components, fuel containers, batteries, lamps, and chemicals are segregated and disposed of through approved channels.",
        domains: ["environmental-health", "worker-safety"],
      },
      {
        domains: ["installation-quality", "project-controls"],
        hazards: [],
        id: "res-demo-010",
        prompt:
          "Conditions exposed by demolition are documented and design conflicts are resolved before reconstruction conceals them.",
        risk: { priority: "high" },
      },
    ],
    defaults: {
      ...baselineQualityDefaults,
      applicability:
        "Apply to demolition, selective demolition, renovation, and work that disturbs existing assemblies.",
      domains: ["worker-safety", "public-safety"],
      evidence: ["Pre-work assessment", "Field observation", "Photo"],
      guidance:
        "Stop and obtain qualified evaluation when concealed conditions differ materially from the plan or could affect stability or hazardous-material controls.",
      hazards: ["collapse", "struck-by"],
      phases: ["pre-task", "in-progress"],
      questionClass: "field-observation",
      risk: { priority: "high", stopWorkCandidate: false },
      sourceRefs: [ref("osha-1926-demolition", "1926 Subpart T"), projectRef],
      verificationMethods: ["document", "observation", "photo"],
    },
    id: "demolition-existing",
    title: "Demolition and existing conditions",
  }),
  defineSection({
    category: "earthwork-utilities",
    controls: [
      {
        hazards: ["electrical", "fire-explosion", "struck-by"],
        id: "res-earth-001",
        prompt:
          "Utility owners have been contacted and underground installations are located, marked, and protected before excavation.",
        risk: { priority: "critical", stopWorkCandidate: true },
        sourceRefs: [ref("osha-1926-excavations", "1926.651(b)")],
      },
      {
        hazards: ["collapse"],
        id: "res-earth-002",
        prompt:
          "A competent person inspects excavations, adjacent areas, and protective systems before work, daily, and after hazard-increasing events.",
        risk: { priority: "critical", stopWorkCandidate: true },
        sourceRefs: [ref("osha-1926-excavations", "1926.651(k)")],
      },
      {
        hazards: ["collapse"],
        id: "res-earth-003",
        prompt:
          "Each employee exposed to a cave-in hazard is protected by an applicable sloping, benching, shoring, or shielding system.",
        risk: { priority: "critical", stopWorkCandidate: true },
        sourceRefs: [ref("osha-1926-excavations", "1926.652(a)")],
      },
      {
        hazards: ["fall", "collapse"],
        id: "res-earth-004",
        prompt:
          "Safe access and egress are provided for trenches four feet or more deep so workers travel no more than 25 feet laterally.",
        risk: { priority: "critical", stopWorkCandidate: true },
        sourceRefs: [ref("osha-1926-excavations", "1926.651(c)(2)")],
      },
      {
        hazards: ["collapse", "falling-object"],
        id: "res-earth-005",
        prompt:
          "Spoil, materials, and equipment are kept at least two feet from excavation edges or retained against falling or rolling in.",
        risk: { priority: "high" },
        sourceRefs: [ref("osha-1926-excavations", "1926.651(j)(2)")],
      },
      {
        hazards: ["collapse", "caught-between"],
        id: "res-earth-006",
        prompt:
          "Water accumulation, runoff, dewatering, and changing soil conditions are controlled before employees enter an excavation.",
        risk: { priority: "critical", stopWorkCandidate: true },
        sourceRefs: [ref("osha-1926-excavations", "1926.651(h)")],
      },
      {
        hazards: ["collapse"],
        id: "res-earth-007",
        prompt:
          "Excavation work does not undermine adjacent foundations, pavements, utilities, or structures without an approved support system.",
        risk: { priority: "critical", stopWorkCandidate: true },
        sourceRefs: [ref("osha-1926-excavations", "1926.651(i)")],
      },
      {
        hazards: ["chemical-exposure", "confined-space", "respiratory"],
        id: "res-earth-008",
        prompt:
          "Where a hazardous atmosphere could exist, testing and required ventilation, respiratory protection, and rescue precautions are in place before entry.",
        risk: { priority: "critical", stopWorkCandidate: true },
        sourceRefs: [ref("osha-1926-excavations", "1926.651(g)")],
      },
      {
        hazards: ["mobile-equipment", "struck-by"],
        id: "res-earth-009",
        prompt:
          "Mobile equipment approaching an excavation edge has a clear view, barricade, stop log, or signaler appropriate to the condition.",
        risk: { priority: "critical", stopWorkCandidate: true },
        sourceRefs: [ref("osha-1926-excavations", "1926.651(f)")],
      },
      {
        hazards: [],
        id: "res-earth-010",
        prompt:
          "Subgrade elevation, bearing condition, unsuitable-material removal, and required compaction are accepted before foundations or slabs proceed.",
      },
      {
        hazards: ["water-intrusion"],
        id: "res-earth-011",
        prompt:
          "Foundation drainage, granular fill, drainage outlets, and waterproofing access are coordinated before backfill.",
        risk: { priority: "high" },
      },
      {
        hazards: ["collapse", "water-intrusion"],
        id: "res-earth-012",
        prompt:
          "Backfill material, lift placement, compaction, and timing do not damage or overload foundation walls, drainage, utilities, or waterproofing.",
        risk: { priority: "high" },
      },
      {
        hazards: ["water-intrusion"],
        id: "res-earth-013",
        phases: ["closeout"],
        prompt:
          "Final grading and drainage elevations direct water to approved discharge locations without trapping it against the dwelling.",
        risk: { priority: "high" },
      },
    ],
    defaults: {
      ...baselineQualityDefaults,
      applicability:
        "Apply when excavation, trenching, grading, or buried-utility work is present.",
      domains: ["worker-safety", "installation-quality"],
      evidence: [
        "Field observation",
        "Competent-person record",
        "Survey or test record when required",
      ],
      guidance:
        "Use the competent person's current soil classification and inspection; N/A is appropriate only when the exposure or work is absent.",
      hazards: ["collapse", "struck-by"],
      phases: ["pre-task", "daily", "pre-cover"],
      questionClass: "field-observation",
      risk: { priority: "high", stopWorkCandidate: false },
      sourceRefs: [
        ref("osha-1926-excavations", "1926 Subpart P"),
        projectRef,
        ahjRef,
      ],
      verificationMethods: ["observation", "document", "measurement"],
    },
    id: "earthwork-utilities",
    title: "Earthwork, grading, and underground utilities",
  }),
  defineSection({
    category: "foundations-concrete-masonry",
    controls: [
      {
        id: "res-found-001",
        prompt:
          "Footing excavations are on accepted bearing material at the required dimensions, elevations, and locations before placement.",
      },
      {
        hazards: ["collapse"],
        id: "res-found-002",
        prompt:
          "Forms, shores, reshores, and braces are installed and maintained for anticipated vertical and lateral loads.",
        risk: { priority: "critical", stopWorkCandidate: true },
        sourceRefs: [ref("osha-1926-concrete", "1926.703")],
      },
      {
        id: "res-found-003",
        prompt:
          "Reinforcing size, grade, spacing, laps, supports, cleanliness, and concrete cover match the approved documents.",
      },
      {
        hazards: ["struck-by"],
        id: "res-found-004",
        prompt:
          "Exposed reinforcing steel that could impale workers is guarded against the hazard.",
        risk: { priority: "critical", stopWorkCandidate: true },
        sourceRefs: [ref("osha-1926-concrete", "1926.701(b)")],
      },
      {
        id: "res-found-005",
        prompt:
          "Anchor bolts, hold-downs, embeds, sleeves, beam pockets, and utility penetrations are correctly located and secured before placement.",
      },
      {
        hazards: ["water-intrusion"],
        id: "res-found-006",
        prompt:
          "Required capillary breaks, granular base, vapor retarder, and sealed penetrations are complete before slab placement.",
        risk: { priority: "high" },
      },
      {
        id: "res-found-007",
        prompt:
          "Concrete delivery documentation confirms the approved mix and prohibited field water or admixture changes have not occurred.",
        questionClass: "material-verification",
      },
      {
        id: "res-found-008",
        prompt:
          "Required concrete sampling, temperature, slump, air, and strength specimens are taken and documented by the designated testing party.",
        questionClass: "test-result",
        sourceRefs: [
          ref("astm-construction", "Project-specified concrete test methods"),
        ],
        verificationMethods: ["test-record", "document"],
      },
      {
        id: "res-found-009",
        prompt:
          "Concrete is placed without harmful segregation, cold joints, displaced reinforcement, or unplanned interruption.",
      },
      {
        id: "res-found-010",
        prompt:
          "Consolidation, finishing, jointing, surface tolerances, and curing match the approved placement plan and weather conditions.",
      },
      {
        hazards: ["heat-cold"],
        id: "res-found-011",
        prompt:
          "Hot- or cold-weather concrete protections and curing controls are in place when conditions require them.",
        risk: { priority: "high" },
      },
      {
        hazards: ["water-intrusion"],
        id: "res-found-012",
        prompt:
          "Foundation dampproofing or waterproofing is continuous, undamaged, correctly terminated, and integrated with drainage before backfill.",
        risk: { priority: "high" },
      },
      {
        hazards: ["collapse"],
        id: "res-found-013",
        prompt:
          "Masonry walls under construction are braced and limited-access zones are established where required.",
        risk: { priority: "critical", stopWorkCandidate: true },
        sourceRefs: [ref("osha-1926-concrete", "1926.706")],
      },
      {
        id: "res-found-014",
        prompt:
          "Foundation dimensions, elevations, diagonals, wall alignment, openings, and top-of-wall condition are accepted before framing begins.",
        phases: ["testing", "pre-installation"],
        questionClass: "measurement",
        verificationMethods: ["measurement", "document"],
      },
    ],
    defaults: {
      ...baselineQualityDefaults,
      sourceRefs: [
        projectRef,
        ahjRef,
        ref("icc-2024-irc", "Chapters 4 and 5; verify local adoption"),
      ],
    },
    id: "foundations-concrete-masonry",
    title: "Foundations, concrete, and masonry",
  }),
  defineSection({
    category: "framing-structure",
    controls: [
      {
        id: "res-frame-001",
        prompt:
          "Lumber, engineered wood, connectors, and fasteners match approved grades, sizes, treatments, exposure ratings, and product documents.",
        questionClass: "material-verification",
      },
      {
        hazards: ["water-intrusion"],
        id: "res-frame-002",
        prompt:
          "Sill plates, capillary breaks or gaskets, anchors, hold-downs, and corrosion protection are complete and correctly located.",
      },
      {
        hazards: ["collapse"],
        id: "res-frame-003",
        prompt:
          "Floor joists, beams, girders, posts, bearings, hangers, and connections match the approved structural documents.",
        risk: { priority: "critical" },
      },
      {
        hazards: ["collapse"],
        id: "res-frame-004",
        prompt:
          "Field holes, notches, cuts, and alterations in structural members are permitted by approved documents or written repair details.",
        risk: { priority: "critical", stopWorkCandidate: true },
      },
      {
        id: "res-frame-005",
        prompt:
          "Subfloor and sheathing panels have the required orientation, edge support, spacing, adhesive, and fastening without avoidable damage.",
      },
      {
        hazards: ["collapse"],
        id: "res-frame-006",
        prompt:
          "Walls are correctly located, plumb, aligned, connected, and temporarily braced until the permanent load path is complete.",
        risk: { priority: "critical" },
      },
      {
        hazards: ["collapse"],
        id: "res-frame-007",
        prompt:
          "Headers, lintels, posts, jack studs, bearing points, and concentrated-load paths match the approved design.",
        risk: { priority: "critical" },
      },
      {
        hazards: ["collapse"],
        id: "res-frame-008",
        prompt:
          "Shear walls, braced-wall panels, straps, hold-downs, blocking, and nailing match the approved lateral design.",
        risk: { priority: "critical" },
      },
      {
        hazards: ["collapse", "falling-object"],
        id: "res-frame-009",
        prompt:
          "Trusses are installed, restrained, braced, and connected according to the approved truss package and erection plan.",
        risk: { priority: "critical", stopWorkCandidate: true },
      },
      {
        hazards: ["collapse"],
        id: "res-frame-010",
        prompt:
          "Trusses and engineered members have no unapproved cuts, drilled holes, damaged plates, or field modifications.",
        risk: { priority: "critical", stopWorkCandidate: true },
      },
      {
        hazards: ["collapse"],
        id: "res-frame-011",
        prompt:
          "Roof rafters, ceiling joists, ridge elements, ties, uplift connectors, and point-load supports are complete and correctly connected.",
        risk: { priority: "critical" },
      },
      {
        domains: ["building-life-safety", "installation-quality"],
        hazards: ["fire-explosion"],
        id: "res-frame-012",
        prompt:
          "Required fireblocking and draftstopping are complete at concealed vertical and horizontal pathways before cover.",
        risk: { priority: "high" },
      },
      {
        id: "res-frame-013",
        prompt:
          "Rough openings for stairs, windows, doors, attic access, chimneys, and equipment match approved dimensions and required clearances.",
      },
      {
        hazards: ["collapse", "struck-by"],
        id: "res-frame-014",
        prompt:
          "Material bundles and equipment are placed only where the incomplete structure can safely support them.",
        domains: ["worker-safety", "installation-quality"],
        risk: { priority: "critical", stopWorkCandidate: true },
      },
      {
        id: "res-frame-015",
        prompt:
          "The framing inspection documents moisture damage, decay, splits, missing fasteners, and unresolved structural corrections before concealment.",
        phases: ["pre-cover"],
        questionClass: "pre-cover-hold-point",
      },
    ],
    defaults: {
      ...baselineQualityDefaults,
      sourceRefs: [
        projectRef,
        ahjRef,
        manufacturerRef,
        ref("icc-2024-irc", "Chapters 5 through 8; verify local adoption"),
      ],
    },
    id: "framing-structure",
    title: "Structural framing",
  }),
  defineSection({
    category: "falls-ladders-scaffolds",
    controls: [
      {
        id: "res-fall-001",
        prompt:
          "Workers engaged in residential construction at six feet or more above lower levels have compliant fall protection for the specific activity.",
        sourceRefs: [
          ref(
            "osha-1926-fall",
            "1926.501(b)(13) and applicable activity-specific provisions",
          ),
          ref(
            "osha-residential-fall-guidance",
            "Applicable residential work method",
          ),
        ],
      },
      {
        hazards: ["fall", "falling-object"],
        id: "res-fall-002",
        prompt:
          "Floor holes, skylights, stair openings, and other openings are covered or guarded for both fall and falling-object exposure.",
        sourceRefs: [ref("osha-1926-fall", "1926.501(b)(4) and 1926.502(i)")],
      },
      {
        id: "res-fall-003",
        prompt:
          "Personal fall-arrest or restraint equipment is inspected before use and removed from service when damaged or previously impact-loaded.",
        sourceRefs: [ref("osha-1926-fall", "1926.502(d)")],
      },
      {
        id: "res-fall-004",
        prompt:
          "Fall-protection anchors, connectors, compatibility, clearance, swing-fall exposure, and rescue arrangements match the selected system.",
        sourceRefs: [ref("osha-1926-fall", "1926.502(d) and 1926.503")],
      },
      {
        id: "res-fall-005",
        prompt:
          "Guardrail systems are complete, stable, correctly configured, and free of openings or conditions that defeat their protection.",
        sourceRefs: [ref("osha-1926-fall", "1926.502(b)")],
      },
      {
        id: "res-fall-006",
        prompt:
          "Portable ladders are inspected and defective ladders are tagged or removed from service.",
        sourceRefs: [
          ref("osha-1926-ladders", "1926.1053(b)(15) through (b)(18)"),
        ],
      },
      {
        id: "res-fall-007",
        prompt:
          "The ladder type, length, duty rating, material, and setup are suitable for the task and surrounding electrical conditions.",
        sourceRefs: [ref("osha-1926-ladders", "1926.1053(a) and (b)")],
      },
      {
        id: "res-fall-008",
        prompt:
          "A portable ladder used for access extends at least three feet above the landing or has an equivalent secure grasping arrangement.",
        sourceRefs: [ref("osha-1926-ladders", "1926.1053(b)(1)")],
      },
      {
        id: "res-fall-009",
        prompt:
          "Non-self-supporting ladders are set at the required angle on stable footing and secured against displacement where needed.",
        sourceRefs: [
          ref("osha-1926-ladders", "1926.1053(b)(5) through (b)(8)"),
        ],
      },
      {
        id: "res-fall-010",
        prompt:
          "Workers face the ladder, maintain a secure grasp, and do not carry loads that could cause loss of balance.",
        sourceRefs: [
          ref("osha-1926-ladders", "1926.1053(b)(20) through (b)(22)"),
        ],
      },
      {
        hazards: ["collapse", "fall"],
        id: "res-fall-011",
        prompt:
          "Scaffolds are erected, moved, altered, inspected, and dismantled under the required competent-person supervision.",
        sourceRefs: [ref("osha-1926-scaffolds", "1926.451(f) and 1926.454")],
      },
      {
        hazards: ["collapse", "fall"],
        id: "res-fall-012",
        prompt:
          "Scaffold foundations, supports, ties, bracing, platforms, and load capacity are complete for the current configuration.",
        sourceRefs: [
          ref("osha-1926-scaffolds", "1926.451(a), (b), (c), and (f)"),
        ],
      },
      {
        id: "res-fall-013",
        prompt:
          "Scaffold users have safe access and do not climb cross-braces or use improvised access.",
        sourceRefs: [ref("osha-1926-scaffolds", "1926.451(e)")],
      },
      {
        hazards: ["fall", "falling-object"],
        id: "res-fall-014",
        prompt:
          "Required scaffold fall protection and falling-object protection are installed and maintained.",
        sourceRefs: [ref("osha-1926-scaffolds", "1926.451(g) and (h)")],
      },
      {
        hazards: ["electrical", "fall"],
        id: "res-fall-015",
        prompt:
          "Ladders, scaffolds, lifts, and workers maintain required clearance from energized overhead conductors.",
        sourceRefs: [
          ref("osha-1926-ladders", "1926.1053(b)(12)"),
          ref("osha-1926-scaffolds", "1926.451(f)(6)"),
        ],
      },
    ],
    defaults: {
      ...baselineQualityDefaults,
      applicability:
        "Apply whenever workers can be exposed to falls, ladders, or scaffolds.",
      domains: ["worker-safety"],
      evidence: [
        "Field observation",
        "Equipment inspection or training record when required",
      ],
      guidance:
        "Use the activity-specific rule. A critical finding is a candidate for immediate work suspension under the employer's authorized safety process.",
      hazards: ["fall"],
      phases: ["pre-task", "daily", "in-progress"],
      questionClass: "field-observation",
      risk: { priority: "critical", stopWorkCandidate: true },
      sourceRefs: [
        ref("osha-1926-fall", "1926 Subpart M"),
        ref("osha-1926-ladders", "1926 Subpart X"),
        ref("osha-1926-scaffolds", "1926 Subpart L"),
      ],
      verificationMethods: ["observation", "document"],
    },
    id: "falls-ladders-scaffolds",
    title: "Falls, ladders, and scaffolds",
  }),
  defineSection({
    category: "roofing",
    controls: [
      {
        domains: ["worker-safety", "project-controls"],
        hazards: ["fall", "falling-object", "heat-cold"],
        id: "res-roof-001",
        phases: ["pre-task"],
        prompt:
          "The roofing pre-task plan addresses access, fall protection, openings, weather, material staging, debris, and rescue.",
        risk: { priority: "critical", stopWorkCandidate: true },
        sourceRefs: [
          ref("osha-residential-fall-guidance", "Roofing and weatherproofing"),
        ],
      },
      {
        domains: ["worker-safety"],
        hazards: ["fall"],
        id: "res-roof-002",
        prompt:
          "Roof-edge, steep-roof, low-slope-roof, and residential fall protection matches the roof and activity being performed.",
        risk: { priority: "critical", stopWorkCandidate: true },
        sourceRefs: [
          ref(
            "osha-1926-fall",
            "1926.501(b)(10), (b)(11), and (b)(13) as applicable",
          ),
        ],
      },
      {
        domains: ["worker-safety"],
        hazards: ["fall", "falling-object"],
        id: "res-roof-003",
        prompt:
          "Skylights, roof holes, access openings, and fragile surfaces are identified and protected before workers enter the roof area.",
        risk: { priority: "critical", stopWorkCandidate: true },
        sourceRefs: [ref("osha-1926-fall", "1926.501(b)(4)")],
      },
      {
        domains: ["worker-safety"],
        hazards: ["collapse", "falling-object", "struck-by"],
        id: "res-roof-004",
        prompt:
          "Material bundles and equipment are secured and distributed within the verified capacity of the roof structure.",
        risk: { priority: "critical", stopWorkCandidate: true },
      },
      {
        domains: ["worker-safety"],
        hazards: ["fall", "heat-cold"],
        id: "res-roof-005",
        prompt:
          "Roof work is suspended or modified when wind, rain, frost, snow, lightning, heat, or visibility makes the planned controls ineffective.",
        risk: { priority: "critical", stopWorkCandidate: true },
      },
      {
        domains: ["worker-safety"],
        hazards: ["fire-explosion"],
        id: "res-roof-006",
        prompt:
          "Torch-applied roofing, hot work, adhesives, and heated equipment use the required permit, fire watch, extinguishers, and combustible controls.",
        risk: { priority: "critical", stopWorkCandidate: true },
        sourceRefs: [
          ref(
            "osha-1926-fire",
            "1926 Subpart F and applicable hot-work provisions",
          ),
        ],
      },
      {
        hazards: ["water-intrusion"],
        id: "res-roof-007",
        prompt:
          "The roof deck is accepted as sound, dry, clean, properly fastened, and within substrate tolerances before roofing is installed.",
        risk: { priority: "high" },
      },
      {
        hazards: ["water-intrusion"],
        id: "res-roof-008",
        prompt:
          "Roof slope, crickets, saddles, drainage paths, and penetrations match approved drawings without unintended ponding locations.",
        risk: { priority: "high" },
      },
      {
        hazards: ["water-intrusion"],
        id: "res-roof-009",
        prompt:
          "Underlayment, ice-barrier, starter, edge metal, and valley materials are the approved products and are installed in the required sequence.",
        risk: { priority: "high" },
        sourceRefs: [manufacturerRef],
      },
      {
        hazards: ["water-intrusion"],
        id: "res-roof-010",
        prompt:
          "Eave, rake, valley, wall, chimney, step, kick-out, and counterflashing details shed water onto the layer below.",
        risk: { priority: "high" },
      },
      {
        hazards: ["water-intrusion"],
        id: "res-roof-011",
        prompt:
          "Roof penetrations use compatible, approved flashing assemblies integrated with the drainage plane.",
        risk: { priority: "high" },
        sourceRefs: [manufacturerRef],
      },
      {
        id: "res-roof-012",
        prompt:
          "Roof-covering fastener type, location, spacing, embedment, and installation pressure match the approved system and wind requirements.",
        questionClass: "measurement",
        risk: { priority: "high" },
        verificationMethods: ["observation", "measurement", "document"],
      },
      {
        hazards: ["water-intrusion"],
        id: "res-roof-013",
        prompt:
          "Shingle offsets or membrane laps, seams, terminations, and repairs meet the approved installation instructions without fishmouths or voids.",
        risk: { priority: "high" },
      },
      {
        hazards: ["water-intrusion"],
        id: "res-roof-014",
        prompt:
          "Roof-to-wall, roof-to-deck, dormer, sidewall, and lower-roof intersections include the approved drainage and flashing details.",
        risk: { priority: "high" },
      },
      {
        domains: ["installation-quality", "building-life-safety"],
        hazards: ["combustion", "water-intrusion"],
        id: "res-roof-015",
        prompt:
          "Attic intake, exhaust, unvented-assembly details, and clearance from heat-producing equipment match the approved design.",
        risk: { priority: "high" },
      },
      {
        id: "res-roof-016",
        prompt:
          "Roofing accessories, sealants, adhesives, metals, and membranes are mutually compatible and within shelf-life and weather limitations.",
        questionClass: "material-verification",
        sourceRefs: [manufacturerRef],
      },
      {
        id: "res-roof-017",
        phases: ["closeout"],
        prompt:
          "Completed roofing is free of open seams, exposed unapproved fasteners, damaged surfacing, debris, blocked drainage, and unresolved punch items.",
        questionClass: "closeout-verification",
      },
      {
        id: "res-roof-018",
        phases: ["closeout"],
        prompt:
          "Required roofing inspection records, concealed-condition photos, product documentation, and warranty submissions are complete.",
        questionClass: "closeout-verification",
        verificationMethods: ["document", "photo"],
      },
    ],
    defaults: {
      ...baselineQualityDefaults,
      evidence: [
        "Field observation",
        "Approved roof-system documents",
        "Photo before concealment",
      ],
      hazards: ["water-intrusion"],
      phases: ["pre-installation", "in-progress", "pre-cover"],
      risk: { priority: "medium", stopWorkCandidate: false },
      sourceRefs: [
        projectRef,
        ahjRef,
        manufacturerRef,
        ref("icc-2024-irc", "Chapters 8 and 9; verify local adoption"),
      ],
      verificationMethods: ["observation", "document", "photo"],
    },
    id: "roofing",
    title: "Roofing safety and quality",
  }),
  defineSection({
    category: "building-envelope",
    controls: [
      {
        hazards: ["water-intrusion"],
        id: "res-env-001",
        prompt:
          "The water-resistive barrier is continuous, correctly lapped, repaired at damage, and integrated with openings and adjacent assemblies.",
        risk: { priority: "high" },
      },
      {
        hazards: ["water-intrusion"],
        id: "res-env-002",
        prompt:
          "Exterior layers are sequenced in shingle fashion so each upper drainage component discharges onto the layer below.",
        risk: { priority: "high" },
      },
      {
        id: "res-env-003",
        prompt:
          "Window and door rough openings have the required size, support, surface condition, and drainage preparation before installation.",
      },
      {
        hazards: ["water-intrusion"],
        id: "res-env-004",
        prompt:
          "Sill pans, end dams, jamb flashing, head flashing, and corner patches match the approved opening detail.",
        risk: { priority: "high" },
      },
      {
        hazards: ["water-intrusion"],
        id: "res-env-005",
        prompt:
          "Windows and exterior doors are the approved units and are installed plumb, level, square, anchored, sealed, and operable.",
        risk: { priority: "high" },
        sourceRefs: [manufacturerRef],
      },
      {
        hazards: ["water-intrusion"],
        id: "res-env-006",
        prompt:
          "Sealant joints have compatible materials, clean substrates, required backing, suitable geometry, and continuous adhesion.",
        risk: { priority: "high" },
        sourceRefs: [manufacturerRef],
      },
      {
        hazards: ["water-intrusion"],
        id: "res-env-007",
        prompt:
          "Cladding, trim, furring, and attachments maintain required clearances, fastening, movement joints, and drainage or ventilation spaces.",
      },
      {
        hazards: ["water-intrusion"],
        id: "res-env-008",
        prompt:
          "Masonry veneer flashing, end dams, weeps, drainage space, ties, and base-of-wall discharge are complete before concealment.",
        risk: { priority: "high" },
      },
      {
        hazards: ["water-intrusion"],
        id: "res-env-009",
        prompt:
          "Exterior penetrations for utilities, fixtures, vents, and fasteners are supported, flashed, and sealed without blocking drainage.",
        risk: { priority: "high" },
      },
      {
        hazards: ["water-intrusion"],
        id: "res-env-010",
        prompt:
          "Deck ledgers, porch roofs, exterior stairs, landings, and intersecting roofs do not interrupt the wall drainage plane.",
        risk: { priority: "high" },
      },
      {
        hazards: ["water-intrusion"],
        id: "res-env-011",
        prompt:
          "Exterior materials and fasteners are compatible with treated wood, dissimilar metals, sealants, and expected exposure.",
        questionClass: "material-verification",
      },
      {
        hazards: ["water-intrusion"],
        id: "res-env-012",
        prompt:
          "Below-grade and above-grade air, water, vapor, and thermal control layers connect continuously at transitions.",
        risk: { priority: "high" },
        sourceRefs: [
          ref(
            "doe-building-america",
            "Moisture control and wall-assembly guidance",
          ),
        ],
      },
      {
        id: "res-env-013",
        prompt:
          "Required envelope mockups or field water tests use the approved procedure and all failures are corrected and retested.",
        questionClass: "test-result",
        risk: { priority: "high" },
        sourceRefs: [
          ref("astm-construction", "Project-specified envelope test method"),
        ],
        verificationMethods: ["test-record", "document", "observation"],
      },
      {
        id: "res-env-014",
        phases: ["pre-cover"],
        prompt:
          "Concealed flashing, membrane transitions, penetrations, and repairs are photographed and accepted before cladding covers them.",
        questionClass: "pre-cover-hold-point",
        verificationMethods: ["photo", "observation", "document"],
      },
    ],
    defaults: {
      ...baselineQualityDefaults,
      evidence: [
        "Field observation",
        "Approved details",
        "Manufacturer instructions",
        "Photo before concealment",
      ],
      hazards: ["water-intrusion"],
      risk: { priority: "high", stopWorkCandidate: false },
      sourceRefs: [
        projectRef,
        ahjRef,
        manufacturerRef,
        ref(
          "icc-2024-irc",
          "Chapter 7 and applicable opening provisions; verify local adoption",
        ),
        ref("doe-building-america", "Moisture-management guidance"),
      ],
      verificationMethods: ["observation", "document", "photo"],
    },
    id: "building-envelope",
    title: "Exterior walls, windows, doors, and flashing",
  }),
  defineSection({
    category: "plumbing",
    controls: [
      {
        id: "res-plumb-001",
        prompt:
          "Pipe, fittings, valves, fixtures, and equipment are approved for the service and match the accepted submittals.",
        questionClass: "material-verification",
      },
      {
        hazards: ["water-intrusion"],
        id: "res-plumb-002",
        prompt:
          "Water piping is supported, protected from damage, isolated from incompatible materials, and arranged for thermal movement.",
      },
      {
        hazards: ["water-intrusion"],
        id: "res-plumb-003",
        prompt:
          "Drain, waste, and vent piping has the approved sizing, slope, support, fittings, cleanouts, and routing.",
        questionClass: "measurement",
        verificationMethods: ["observation", "measurement", "document"],
      },
      {
        hazards: ["combustion"],
        id: "res-plumb-004",
        prompt:
          "Traps, trap arms, vents, primers, and prohibited cross-connections have been checked before concealment.",
        risk: { priority: "high" },
      },
      {
        hazards: ["water-intrusion"],
        id: "res-plumb-005",
        prompt:
          "Required water-supply, drainage, vent, and gas-system tests are completed with accepted results before concealment.",
        questionClass: "test-result",
        risk: { priority: "high" },
        verificationMethods: ["test-record", "observation"],
      },
      {
        hazards: ["electrical", "water-intrusion"],
        id: "res-plumb-006",
        prompt:
          "Piping near framing faces is protected from fastener damage and does not contain unauthorized structural penetrations.",
        risk: { priority: "high" },
      },
      {
        hazards: ["water-intrusion"],
        id: "res-plumb-007",
        prompt:
          "Fixtures and supports are secure, aligned, accessible, and sealed at water-exposed transitions.",
      },
      {
        hazards: ["combustion", "water-intrusion"],
        id: "res-plumb-008",
        prompt:
          "Water-heater support, pan and drain, temperature-pressure relief discharge, clearances, and access match approved requirements.",
        risk: { priority: "critical" },
      },
      {
        hazards: ["combustion", "fire-explosion"],
        id: "res-plumb-009",
        prompt:
          "Fuel-fired water-heater combustion air, venting, draft, shutoff, and protection from vehicle impact are complete.",
        domains: ["building-life-safety", "installation-quality"],
        risk: { priority: "critical", stopWorkCandidate: true },
      },
      {
        hazards: ["water-intrusion"],
        id: "res-plumb-010",
        prompt:
          "Required backflow protection, pressure control, thermal-expansion control, and accessible shutoffs are installed.",
        risk: { priority: "high" },
      },
      {
        hazards: ["heat-cold", "water-intrusion"],
        id: "res-plumb-011",
        prompt:
          "Water and drainage piping exposed to freezing or damaging heat is routed, insulated, or otherwise protected.",
        risk: { priority: "high" },
      },
      {
        domains: ["building-life-safety", "installation-quality"],
        hazards: ["fire-explosion"],
        id: "res-plumb-012",
        prompt:
          "Plumbing penetrations maintain required fireblocking, draftstopping, fire-resistance, and air or water control layers.",
        risk: { priority: "high" },
        sourceRefs: [
          ref("product-listings", "Applicable listed penetration system"),
        ],
      },
      {
        hazards: ["water-intrusion"],
        id: "res-plumb-013",
        phases: ["testing", "closeout"],
        prompt:
          "The completed plumbing system is checked under operating conditions for leakage, drainage, fixture operation, temperature, and pressure.",
        questionClass: "test-result",
        risk: { priority: "high" },
        verificationMethods: ["test-record", "observation", "measurement"],
      },
    ],
    defaults: {
      ...baselineQualityDefaults,
      sourceRefs: [
        projectRef,
        ahjRef,
        manufacturerRef,
        ref(
          "icc-2024-irc",
          "Parts VII and applicable fuel-gas provisions; verify local adoption",
        ),
      ],
    },
    id: "plumbing",
    title: "Plumbing",
  }),
  defineSection({
    category: "hvac-fuel-gas",
    controls: [
      {
        id: "res-hvac-001",
        prompt:
          "HVAC, ventilation, and fuel-gas equipment match approved selections, capacities, efficiencies, and listed applications.",
        questionClass: "material-verification",
      },
      {
        id: "res-hvac-002",
        prompt:
          "Heating and cooling loads, equipment sizing, duct design, and ventilation design are available and coordinated with the installed system.",
        questionClass: "document-review",
      },
      {
        id: "res-hvac-003",
        prompt:
          "Equipment and ducts are independently supported, protected from damage, and provided with required service access and clearances.",
      },
      {
        id: "res-hvac-004",
        prompt:
          "Duct joints, seams, boots, plenums, air-handler connections, and building penetrations are sealed with approved materials.",
        sourceRefs: [ref("doe-building-america", "HVAC and duct guidance")],
      },
      {
        hazards: ["water-intrusion"],
        id: "res-hvac-005",
        prompt:
          "Duct and refrigerant-line insulation is continuous, correctly rated, protected, and sealed against condensation.",
        risk: { priority: "high" },
      },
      {
        hazards: ["water-intrusion"],
        id: "res-hvac-006",
        prompt:
          "Primary and auxiliary condensate management is sloped, trapped where required, terminated visibly or acceptably, and tested.",
        risk: { priority: "high" },
      },
      {
        domains: ["building-life-safety", "installation-quality"],
        hazards: ["combustion", "fire-explosion", "respiratory"],
        id: "res-hvac-007",
        prompt:
          "Fuel-burning appliances have required combustion air, venting, clearances, draft provisions, and garage or vehicle-impact protection.",
        risk: { priority: "critical", stopWorkCandidate: true },
      },
      {
        domains: ["building-life-safety", "installation-quality"],
        hazards: ["fire-explosion"],
        id: "res-hvac-008",
        prompt:
          "Fuel-gas pipe material, sizing, support, protection, bonding, valves, and equipment connections match approved requirements.",
        risk: { priority: "critical" },
      },
      {
        domains: ["building-life-safety", "installation-quality"],
        hazards: ["fire-explosion"],
        id: "res-hvac-009",
        prompt:
          "The fuel-gas system has passed the required pressure test before concealment or connection to service.",
        questionClass: "test-result",
        risk: { priority: "critical", stopWorkCandidate: true },
        verificationMethods: ["test-record", "observation"],
      },
      {
        hazards: ["chemical-exposure", "water-intrusion"],
        id: "res-hvac-010",
        prompt:
          "Refrigerant piping is correctly joined, supported, protected, insulated, pressure-tested, evacuated, and documented.",
        questionClass: "test-result",
        risk: { priority: "high" },
        verificationMethods: ["test-record", "observation", "document"],
      },
      {
        domains: ["building-life-safety", "installation-quality"],
        hazards: ["combustion", "water-intrusion"],
        id: "res-hvac-011",
        prompt:
          "Bathroom, kitchen, and dryer exhaust systems discharge outdoors through approved, weather-protected terminations.",
        risk: { priority: "high" },
      },
      {
        domains: ["building-life-safety", "installation-quality"],
        hazards: ["combustion", "respiratory"],
        id: "res-hvac-012",
        prompt:
          "Whole-house mechanical ventilation components, controls, intake locations, and airflow settings match the approved design.",
        risk: { priority: "high" },
      },
      {
        domains: ["building-life-safety", "installation-quality"],
        hazards: ["fire-explosion"],
        id: "res-hvac-013",
        prompt:
          "Mechanical and fuel-gas penetrations maintain required fireblocking, draftstopping, fire-resistance, and envelope layers.",
        risk: { priority: "high" },
        sourceRefs: [
          ref("product-listings", "Applicable listed penetration system"),
        ],
      },
      {
        id: "res-hvac-014",
        phases: ["testing", "closeout"],
        prompt:
          "Startup, controls, airflow, balance, combustion safety, and functional test results are accepted and deficiencies are closed.",
        questionClass: "test-result",
        risk: { priority: "high" },
        verificationMethods: ["test-record", "document", "measurement"],
      },
    ],
    defaults: {
      ...baselineQualityDefaults,
      sourceRefs: [
        projectRef,
        ahjRef,
        manufacturerRef,
        ref("icc-2024-irc", "Parts V and VI; verify local adoption"),
      ],
    },
    id: "hvac-fuel-gas",
    title: "HVAC, ventilation, and fuel gas",
  }),
  defineSection({
    category: "electrical",
    controls: [
      {
        domains: ["worker-safety"],
        hazards: ["electrical"],
        id: "res-elec-001",
        prompt:
          "Temporary 120-volt, 15- and 20-amp receptacle outlets used by employees have required GFCI protection or an implemented assured equipment grounding program.",
        risk: { priority: "critical", stopWorkCandidate: true },
        sourceRefs: [ref("osha-1926-electrical", "1926.404(b)(1)")],
      },
      {
        domains: ["worker-safety"],
        hazards: ["electrical"],
        id: "res-elec-002",
        prompt:
          "Extension cords and portable electrical equipment are approved for the service, inspected, grounded when required, and free of improvised repairs.",
        risk: { priority: "critical", stopWorkCandidate: true },
        sourceRefs: [
          ref("osha-1926-electrical", "1926.403, 1926.404, and 1926.405"),
        ],
      },
      {
        domains: ["worker-safety"],
        hazards: ["electrical", "fire-explosion"],
        id: "res-elec-003",
        prompt:
          "Temporary panels, boxes, covers, knockouts, splices, and live parts are enclosed and protected from weather and physical damage.",
        risk: { priority: "critical", stopWorkCandidate: true },
        sourceRefs: [ref("osha-1926-electrical", "1926.403 and 1926.405")],
      },
      {
        domains: ["worker-safety"],
        hazards: ["electrical"],
        id: "res-elec-004",
        prompt:
          "Energized electrical work is avoided or controlled by authorized procedures, qualified workers, boundaries, and suitable protective equipment.",
        risk: { priority: "critical", stopWorkCandidate: true },
        sourceRefs: [ref("osha-1926-electrical", "1926.416 and 1926.417")],
      },
      {
        hazards: ["electrical", "fire-explosion"],
        id: "res-elec-005",
        prompt:
          "Service equipment, panels, disconnects, grounding electrodes, and bonding components match approved utility and project requirements.",
        risk: { priority: "critical" },
        sourceRefs: [
          ref("utility-requirements", "Approved service requirements"),
        ],
      },
      {
        hazards: ["electrical", "fire-explosion"],
        id: "res-elec-006",
        prompt:
          "Panel working space, access, identification, enclosure integrity, and protection from storage or damage are maintained.",
        risk: { priority: "critical" },
      },
      {
        hazards: ["electrical", "fire-explosion"],
        id: "res-elec-007",
        prompt:
          "Cable and raceway type, support, protection, bend, fill, and routing match approved requirements and environmental conditions.",
        risk: { priority: "high" },
      },
      {
        hazards: ["electrical"],
        id: "res-elec-008",
        prompt:
          "Cables and raceways near framing faces are protected from fasteners and do not use unauthorized structural openings.",
        risk: { priority: "high" },
      },
      {
        hazards: ["electrical", "fire-explosion"],
        id: "res-elec-009",
        prompt:
          "Boxes are approved, secure, accessible, correctly sized, and set for the finished surface without damaged entries or missing clamps.",
        risk: { priority: "high" },
      },
      {
        hazards: ["electrical", "fire-explosion"],
        id: "res-elec-010",
        prompt:
          "Conductor size, insulation, identification, terminations, splices, and torque values match the circuit and equipment requirements.",
        risk: { priority: "critical" },
      },
      {
        hazards: ["electrical"],
        id: "res-elec-011",
        prompt:
          "Required permanent GFCI, AFCI, tamper-resistant, weather-resistant, and in-use protections are installed for the adopted code and location.",
        risk: { priority: "critical" },
      },
      {
        id: "res-elec-012",
        prompt:
          "Receptacle, switch, lighting, appliance, disconnect, and dedicated-circuit locations match the approved plans and equipment instructions.",
      },
      {
        domains: ["building-life-safety", "installation-quality"],
        hazards: ["fire-explosion"],
        id: "res-elec-013",
        prompt:
          "Smoke and carbon-monoxide alarm power, interconnection, locations, and listing match the adopted requirements and approved plans.",
        risk: { priority: "critical" },
      },
      {
        hazards: ["electrical", "water-intrusion"],
        id: "res-elec-014",
        prompt:
          "Equipment and luminaires in wet, damp, exterior, closet, attic, and insulated locations are listed and installed for the environment.",
        risk: { priority: "high" },
      },
      {
        domains: ["building-life-safety", "installation-quality"],
        hazards: ["fire-explosion"],
        id: "res-elec-015",
        prompt:
          "Electrical penetrations maintain required fireblocking, draftstopping, fire-resistance, and air or water control layers.",
        risk: { priority: "high" },
        sourceRefs: [
          ref("product-listings", "Applicable listed penetration system"),
        ],
      },
      {
        hazards: ["electrical", "fire-explosion"],
        id: "res-elec-016",
        phases: ["testing", "closeout"],
        prompt:
          "Required electrical inspections and functional tests are accepted, directories are accurate, and temporary wiring is removed when no longer needed.",
        questionClass: "test-result",
        risk: { priority: "critical" },
        verificationMethods: ["test-record", "observation", "document"],
      },
    ],
    defaults: {
      ...baselineQualityDefaults,
      domains: ["installation-quality", "building-life-safety"],
      hazards: ["electrical"],
      risk: { priority: "high", stopWorkCandidate: false },
      sourceRefs: [
        projectRef,
        ahjRef,
        manufacturerRef,
        ref(
          "nfpa-70-nec",
          "Edition adopted by the authority having jurisdiction",
        ),
        ref("icc-2024-irc", "Part VIII; verify local adoption"),
      ],
    },
    id: "electrical",
    title: "Electrical and temporary power",
  }),
  defineSection({
    category: "insulation-air-moisture",
    controls: [
      {
        hazards: ["water-intrusion"],
        id: "res-insul-001",
        prompt:
          "The primary air barrier is identified and continuous at exterior assemblies, attached garages, ceilings, floors, and transitions.",
        risk: { priority: "high" },
      },
      {
        hazards: ["water-intrusion"],
        id: "res-insul-002",
        prompt:
          "Penetrations, top and bottom plates, rim areas, chases, dropped soffits, and service openings are sealed with durable compatible materials.",
        risk: { priority: "high" },
      },
      {
        id: "res-insul-003",
        prompt:
          "Insulation type, R-value, depth, density, and location match the approved energy design and product instructions.",
        questionClass: "material-verification",
      },
      {
        id: "res-insul-004",
        prompt:
          "Insulation is in full contact with the intended air barrier and has no avoidable gaps, voids, compression, wind washing, or misalignment.",
      },
      {
        hazards: ["combustion", "fire-explosion"],
        id: "res-insul-005",
        prompt:
          "Insulation and air-sealing materials maintain required clearance from flues, chimneys, heat-producing devices, and non-rated fixtures.",
        domains: ["building-life-safety", "installation-quality"],
        risk: { priority: "critical" },
      },
      {
        hazards: ["water-intrusion"],
        id: "res-insul-006",
        prompt:
          "Attic ventilation baffles, insulation dams, access weatherstripping, and ventilation paths are complete for the approved assembly.",
        risk: { priority: "high" },
      },
      {
        hazards: ["water-intrusion"],
        id: "res-insul-007",
        prompt:
          "Vapor retarders and vapor-open or vapor-closed materials match the climate-specific approved wall, roof, floor, and crawlspace assemblies.",
        risk: { priority: "high" },
      },
      {
        hazards: ["water-intrusion"],
        id: "res-insul-008",
        prompt:
          "Walls behind tubs, showers, fireplaces, stairs, and other inaccessible areas have the required air barrier and insulation before closure.",
        risk: { priority: "high" },
      },
      {
        domains: ["building-life-safety", "installation-quality"],
        hazards: ["fire-explosion"],
        id: "res-insul-009",
        prompt:
          "Foam plastics, sealants, and penetration materials have the required listing, flame or thermal protection, and installation thickness.",
        risk: { priority: "critical" },
        sourceRefs: [
          ref("product-listings", "Applicable listed product or assembly"),
        ],
      },
      {
        hazards: ["water-intrusion"],
        id: "res-insul-010",
        prompt:
          "Framing and concealed cavities are acceptably dry and free of unresolved bulk-water intrusion before insulation and interior cover.",
        risk: { priority: "high" },
      },
      {
        id: "res-insul-011",
        phases: ["testing"],
        prompt:
          "Required blower-door and duct-leakage tests use the approved procedure and meet the project-specific target.",
        questionClass: "test-result",
        risk: { priority: "high" },
        verificationMethods: ["test-record", "document"],
      },
      {
        id: "res-insul-012",
        phases: ["pre-cover"],
        prompt:
          "The insulation and air-sealing inspection is complete before concealed assemblies are covered.",
        questionClass: "pre-cover-hold-point",
      },
    ],
    defaults: {
      ...baselineQualityDefaults,
      evidence: [
        "Field observation",
        "Approved energy documents",
        "Photo before concealment",
      ],
      hazards: ["water-intrusion"],
      risk: { priority: "high", stopWorkCandidate: false },
      sourceRefs: [
        projectRef,
        ahjRef,
        manufacturerRef,
        ref(
          "icc-2024-iecc-residential",
          "Adopted compliance path and climate-zone provisions",
        ),
        ref(
          "doe-building-america",
          "Air-sealing, insulation, and moisture guidance",
        ),
      ],
      verificationMethods: ["observation", "document", "photo"],
    },
    id: "insulation-air-moisture",
    title: "Insulation, air sealing, and moisture control",
  }),
  defineSection({
    category: "fire-life-safety",
    controls: [
      {
        hazards: ["fire-explosion"],
        id: "res-life-001",
        prompt:
          "Required smoke alarms are listed, correctly located, powered, interconnected, unobstructed, and tested.",
      },
      {
        hazards: ["combustion"],
        id: "res-life-002",
        prompt:
          "Required carbon-monoxide alarms are listed, correctly located, powered, interconnected where required, and tested.",
      },
      {
        hazards: ["fire-explosion"],
        id: "res-life-003",
        prompt:
          "Sleeping rooms and basements have the required emergency escape and rescue openings with operable, unobstructed clearances.",
        questionClass: "measurement",
        verificationMethods: ["measurement", "observation", "document"],
      },
      {
        hazards: ["fire-explosion"],
        id: "res-life-004",
        prompt:
          "Required egress doors, landings, locks, and travel paths are operable from the egress side without prohibited obstruction.",
      },
      {
        hazards: ["combustion", "fire-explosion"],
        id: "res-life-005",
        prompt:
          "Garage-to-dwelling separation, protected openings, duct limitations, and floor or ceiling protection are complete.",
        risk: { priority: "critical" },
      },
      {
        hazards: ["fire-explosion"],
        id: "res-life-006",
        prompt:
          "Fireblocking and draftstopping close concealed pathways at required stories, soffits, chases, stairs, tubs, fireplaces, and penetrations.",
        risk: { priority: "critical" },
      },
      {
        hazards: ["fire-explosion"],
        id: "res-life-007",
        prompt:
          "Penetrations and joints in fire-resistance-rated or smoke-resisting assemblies match a complete approved listed system.",
        risk: { priority: "critical" },
        sourceRefs: [
          ref("product-listings", "Complete applicable listed system"),
        ],
      },
      {
        hazards: ["fire-explosion"],
        id: "res-life-008",
        prompt:
          "Required dwelling-unit separation walls, townhouse separation, continuity, and protected openings are complete and documented.",
        risk: { priority: "critical" },
      },
      {
        hazards: ["combustion", "fire-explosion"],
        id: "res-life-009",
        prompt:
          "Chimneys, fireplaces, vents, and heat-producing appliances maintain approved clearances and termination conditions.",
        risk: { priority: "critical" },
      },
      {
        hazards: ["combustion", "fire-explosion"],
        id: "res-life-010",
        prompt:
          "Foam plastic and other combustible insulation have the required thermal or ignition barrier and protected terminations.",
        risk: { priority: "critical" },
        sourceRefs: [
          manufacturerRef,
          ref("product-listings", "Applicable listed assembly"),
        ],
      },
      {
        hazards: ["fire-explosion", "public-interface"],
        id: "res-life-011",
        prompt:
          "The street address is visible as required and emergency responders have usable access to the completed dwelling.",
        risk: { priority: "high" },
      },
      {
        hazards: ["combustion", "fire-explosion"],
        id: "res-life-012",
        phases: ["testing", "closeout"],
        prompt:
          "Final life-safety testing verifies alarms, egress components, garage protection, and other required systems without unresolved critical defects.",
        questionClass: "test-result",
        verificationMethods: ["test-record", "observation", "document"],
      },
    ],
    defaults: {
      ...baselineQualityDefaults,
      domains: ["building-life-safety"],
      evidence: [
        "Field observation",
        "Measurement or functional test",
        "Approved project documents",
      ],
      hazards: ["fire-explosion"],
      risk: { priority: "critical", stopWorkCandidate: false },
      sourceRefs: [
        projectRef,
        ahjRef,
        ref(
          "icc-2024-irc",
          "Chapter 3 and applicable assembly provisions; verify local adoption",
        ),
      ],
      verificationMethods: ["observation", "document", "measurement"],
    },
    id: "fire-life-safety",
    title: "Fire and life safety",
  }),
  defineSection({
    category: "interior-finishes",
    controls: [
      {
        id: "res-int-001",
        prompt:
          "Gypsum panel type, thickness, edge condition, orientation, support, and fastening match the approved assembly.",
      },
      {
        hazards: ["fire-explosion"],
        id: "res-int-002",
        prompt:
          "Fire-resistance-rated gypsum assemblies use the complete listed layer sequence, joints, fasteners, backing, and penetrations.",
        domains: ["building-life-safety", "installation-quality"],
        risk: { priority: "critical" },
        sourceRefs: [
          ref("product-listings", "Complete applicable listed assembly"),
        ],
      },
      {
        id: "res-int-003",
        prompt:
          "Required backing and blocking are installed for cabinets, guards, handrails, accessories, fixtures, and wall-mounted equipment.",
      },
      {
        hazards: ["water-intrusion"],
        id: "res-int-004",
        prompt:
          "Wet-area substrates, membranes, seams, corners, penetrations, and transitions form the approved continuous water-control assembly.",
        risk: { priority: "high" },
      },
      {
        hazards: ["water-intrusion"],
        id: "res-int-005",
        prompt:
          "Shower receptors, curbs, drains, and waterproofing pass the required test before tile or finish installation.",
        questionClass: "test-result",
        risk: { priority: "high" },
        verificationMethods: ["test-record", "observation"],
      },
      {
        id: "res-int-006",
        prompt:
          "Floor substrates meet the finish manufacturer's flatness, dryness, cleanliness, fastening, and movement-joint requirements.",
        questionClass: "measurement",
      },
      {
        hazards: ["collapse"],
        id: "res-int-007",
        prompt:
          "Cabinets, countertops, shelving, and heavy architectural components are securely anchored to suitable support.",
        risk: { priority: "high" },
      },
      {
        id: "res-int-008",
        prompt:
          "Interior doors, hardware, trim, and access panels operate correctly and maintain required clearances and access.",
      },
      {
        hazards: ["chemical-exposure", "fire-explosion"],
        id: "res-int-009",
        prompt:
          "Coatings, adhesives, solvents, and finish materials are stored, ventilated, mixed, and applied within their safety and environmental limits.",
        domains: ["worker-safety", "installation-quality"],
        risk: { priority: "high" },
        sourceRefs: [
          ref("osha-hazard-communication", "1910.1200 and product SDS"),
        ],
      },
      {
        id: "res-int-010",
        phases: ["closeout"],
        prompt:
          "Interior finishes are clean, complete, protected from damage, and free of unresolved functional or workmanship defects.",
        questionClass: "closeout-verification",
      },
    ],
    defaults: {
      ...baselineQualityDefaults,
      sourceRefs: [projectRef, ahjRef, manufacturerRef, ircRef],
    },
    id: "interior-finishes",
    title: "Interior finishes and wet areas",
  }),
  defineSection({
    category: "stairs-decks-guards",
    controls: [
      {
        hazards: ["collapse", "water-intrusion"],
        id: "res-deck-001",
        prompt:
          "Deck ledgers have approved attachment, flashing, spacing, and connection to structurally suitable framing.",
        risk: { priority: "critical" },
      },
      {
        hazards: ["collapse"],
        id: "res-deck-002",
        prompt:
          "Deck footings, posts, beams, joists, bearings, hangers, and load paths match the approved structural design.",
        risk: { priority: "critical" },
      },
      {
        hazards: ["collapse"],
        id: "res-deck-003",
        prompt:
          "Required lateral-load, uplift, diagonal-bracing, and positive-connection details are complete.",
        risk: { priority: "critical" },
      },
      {
        hazards: ["collapse"],
        id: "res-deck-004",
        prompt:
          "Exterior connectors and fasteners are compatible with treated wood, other metals, and the exposure classification.",
        risk: { priority: "high" },
        questionClass: "material-verification",
      },
      {
        hazards: ["fall"],
        id: "res-deck-005",
        prompt:
          "Stair risers, treads, winders, nosings, and landings are within approved dimensions and are uniform throughout each flight.",
        risk: { priority: "critical" },
        questionClass: "measurement",
        verificationMethods: ["measurement", "document"],
      },
      {
        hazards: ["fall"],
        id: "res-deck-006",
        prompt:
          "Required stair headroom, width, illumination, and clear travel path are maintained.",
        risk: { priority: "critical" },
        questionClass: "measurement",
      },
      {
        hazards: ["fall"],
        id: "res-deck-007",
        prompt:
          "Required handrails are continuous where required, graspable, correctly located, securely anchored, and properly returned or terminated.",
        risk: { priority: "critical" },
        questionClass: "measurement",
      },
      {
        hazards: ["fall"],
        id: "res-deck-008",
        prompt:
          "Required guards have approved height, opening limitations, attachment, continuity, and resistance to foreseeable loads.",
        risk: { priority: "critical" },
        questionClass: "measurement",
      },
      {
        hazards: ["fall"],
        id: "res-deck-009",
        prompt:
          "Decking, porch flooring, and walking surfaces are securely fastened, slip-conscious, drained, and free of hazardous projections.",
        risk: { priority: "high" },
      },
      {
        hazards: ["fall", "water-intrusion"],
        id: "res-deck-010",
        prompt:
          "Exterior landings, thresholds, stairs, and ramps have approved geometry, support, drainage, and weather-resistant construction.",
        risk: { priority: "high" },
      },
      {
        hazards: ["collapse", "fall"],
        id: "res-deck-011",
        phases: ["testing", "closeout"],
        prompt:
          "Completed stairs, decks, guards, and handrails have no movement, damage, missing connectors, or unresolved structural corrections.",
        questionClass: "closeout-verification",
        risk: { priority: "critical" },
      },
    ],
    defaults: {
      ...baselineQualityDefaults,
      domains: ["building-life-safety", "installation-quality"],
      evidence: [
        "Field observation",
        "Measurement",
        "Approved structural detail",
      ],
      hazards: ["fall", "collapse"],
      risk: { priority: "critical", stopWorkCandidate: false },
      sourceRefs: [
        projectRef,
        ahjRef,
        manufacturerRef,
        ref(
          "icc-2024-irc",
          "Chapter 3 and applicable deck provisions; verify local adoption",
        ),
      ],
      verificationMethods: ["observation", "measurement", "document"],
    },
    id: "stairs-decks-guards",
    title: "Stairs, decks, guards, and handrails",
  }),
  defineSection({
    category: "exterior-drainage",
    controls: [
      {
        hazards: ["water-intrusion"],
        id: "res-ext-001",
        prompt:
          "Final grade, swales, drains, and hardscape direct surface water to approved locations without trapping it against the dwelling.",
        risk: { priority: "high" },
      },
      {
        hazards: ["water-intrusion"],
        id: "res-ext-002",
        prompt:
          "Gutters, downspouts, leaders, splash blocks, and underground connections are complete, secure, and discharge as designed.",
        risk: { priority: "high" },
      },
      {
        hazards: ["water-intrusion"],
        id: "res-ext-003",
        prompt:
          "Exterior slabs, walks, stoops, patios, and driveways have approved elevation, slope, joints, support, and separation from the structure.",
      },
      {
        hazards: ["collapse"],
        id: "res-ext-004",
        prompt:
          "Retaining walls, site walls, and freestanding exterior structures match approved footing, drainage, reinforcement, and height requirements.",
        risk: { priority: "critical" },
      },
      {
        hazards: ["electrical", "fire-explosion", "water-intrusion"],
        id: "res-ext-005",
        prompt:
          "Water, sewer, gas, electric, communications, and drainage services have approved separation, cover, protection, identification, and test records.",
        risk: { priority: "critical" },
        sourceRefs: [
          ref("utility-requirements", "Approved utility service requirements"),
        ],
      },
      {
        hazards: ["water-intrusion"],
        id: "res-ext-006",
        prompt:
          "Irrigation, hose connections, condensate, sump discharge, and roof drainage do not direct water into foundations or vulnerable assemblies.",
        risk: { priority: "high" },
      },
      {
        hazards: ["public-interface", "water-intrusion"],
        id: "res-ext-007",
        prompt:
          "Landscape soil, mulch, vegetation, and irrigation maintain approved clearances from cladding, weeps, equipment, and wood framing.",
      },
      {
        hazards: ["fall", "public-interface"],
        id: "res-ext-008",
        prompt:
          "Completed exterior routes are stable, drained, illuminated where required, and free of abrupt hazards or unprotected changes in elevation.",
        risk: { priority: "high" },
      },
      {
        hazards: ["public-interface", "struck-by"],
        id: "res-ext-009",
        prompt:
          "Construction fencing, temporary protections, dumpsters, and stored materials are removed or left in an approved safe turnover condition.",
      },
      {
        hazards: ["water-intrusion"],
        id: "res-ext-010",
        phases: ["testing", "closeout"],
        prompt:
          "Where required, drainage testing or a documented rain observation confirms positive flow without leakage, erosion, or unintended ponding.",
        questionClass: "test-result",
        risk: { priority: "high" },
        verificationMethods: ["test-record", "observation", "photo"],
      },
    ],
    defaults: {
      ...baselineQualityDefaults,
      domains: ["installation-quality", "public-safety"],
      hazards: ["water-intrusion", "public-interface"],
      phases: ["in-progress", "testing", "closeout"],
      sourceRefs: [projectRef, ahjRef, utilityRequirementsRef(), ircRef],
    },
    id: "exterior-drainage",
    title: "Exterior improvements and drainage",
  }),
  defineSection({
    category: "commissioning-closeout",
    controls: [
      {
        id: "res-close-001",
        prompt:
          "Required building, trade, special, utility, and third-party inspections have accepted results or documented approved resolution.",
      },
      {
        id: "res-close-002",
        prompt:
          "Open punch-list, nonconformance, failed-test, and corrective-action items are assigned, tracked, and verified closed.",
        risk: { priority: "high" },
      },
      {
        id: "res-close-003",
        prompt:
          "Required structural, envelope, plumbing, gas, HVAC, electrical, energy, and life-safety test reports are complete and accepted.",
        questionClass: "test-result",
        verificationMethods: ["test-record", "document"],
      },
      {
        id: "res-close-004",
        prompt:
          "Mechanical equipment, plumbing fixtures, appliances, controls, exhaust systems, and safety devices operate through their intended modes.",
        questionClass: "test-result",
        risk: { priority: "high" },
        verificationMethods: ["test-record", "observation"],
      },
      {
        id: "res-close-005",
        prompt:
          "Final electrical, gas, water, drainage, and combustion-safety checks show no leakage, unsafe energization, or unresolved critical condition.",
        domains: ["building-life-safety", "installation-quality"],
        questionClass: "test-result",
        risk: { priority: "critical", stopWorkCandidate: true },
        verificationMethods: ["test-record", "observation"],
      },
      {
        id: "res-close-006",
        prompt:
          "Operation manuals, maintenance instructions, product data, test reports, and warranty documents are organized for turnover.",
      },
      {
        id: "res-close-007",
        prompt:
          "Record drawings, approved changes, concealed-condition photos, equipment data, and finish selections reflect the completed work.",
      },
      {
        id: "res-close-008",
        prompt:
          "Required certificates, approvals, permit closeout, and occupancy authorization are complete before occupancy or use.",
        domains: ["building-life-safety", "project-controls"],
        risk: { priority: "critical" },
      },
      {
        id: "res-close-009",
        prompt:
          "Labels, panel directories, shutoff identification, filter sizes, equipment access, keys, and remotes are complete and accurate.",
      },
      {
        id: "res-close-010",
        prompt:
          "The owner orientation covers emergency shutoffs, alarms, ventilation, equipment operation, drainage maintenance, and warranty procedures.",
        questionClass: "closeout-verification",
        verificationMethods: ["document", "interview"],
      },
      {
        id: "res-close-011",
        prompt:
          "The dwelling and site are clean, secure, weather-tight, and free of construction debris, temporary hazards, and abandoned materials.",
      },
      {
        id: "res-close-012",
        prompt:
          "No unresolved critical safety, structural, fire, electrical, fuel-gas, egress, or water-intrusion finding remains at turnover.",
        domains: [
          "building-life-safety",
          "installation-quality",
          "project-controls",
        ],
        risk: { priority: "critical", stopWorkCandidate: true },
      },
    ],
    defaults: {
      ...baselineQualityDefaults,
      domains: ["project-controls", "installation-quality"],
      evidence: [
        "Accepted inspection or test record",
        "Field observation",
        "Turnover document",
      ],
      phases: ["testing", "closeout"],
      questionClass: "closeout-verification",
      sourceRefs: [projectRef, ahjRef, manufacturerRef, ircRef],
      verificationMethods: ["document", "test-record", "observation"],
    },
    id: "commissioning-closeout",
    title: "Testing, commissioning, and closeout",
  }),
];

function utilityRequirementsRef() {
  return ref(
    "utility-requirements",
    "Applicable approved utility requirements",
  );
}

const controls = sections.flatMap((section) => section.controls);

export const residentialCoreStarter = {
  description:
    "A comprehensive U.S. baseline for detached one- and two-family homes and townhouses. It combines federal construction-safety controls with model-code, project-document, manufacturer, and workmanship checks. It is not a code-compliance certification; verify State Plan, state, local, project, utility, and product-specific requirements before use.",
  id: "us_residential_core_global",
  name: "U.S. residential construction — comprehensive baseline",
  definition: {
    sections: sections.map((section) => ({
      id: section.id,
      items: section.controls.map((control) => ({
        id: control.id,
        prompt: control.prompt,
        required: true,
        responseType: "check" as const,
      })),
      title: section.title,
    })),
    version: 1,
  } satisfies AuditDefinition,
};

export const residentialLibraryStats = {
  controls: controls.length,
  criticalControls: controls.filter(
    (control) => control.risk.priority === "critical",
  ).length,
  sections: sections.length,
  sources: sources.length,
};

export function validateResidentialLibrary() {
  const errors: string[] = [];
  const sourceIds = validateSources(errors);
  validateSections(errors, sourceIds);
  return errors;
}

function validateSources(errors: string[]) {
  const ids = new Set<string>();
  for (const source of sources) {
    if (ids.has(source.id)) {
      errors.push(`Duplicate source id: ${source.id}`);
    }
    ids.add(source.id);
    if (source.reviewedAt !== reviewedAt) {
      errors.push(`Unexpected review date for source: ${source.id}`);
    }
    if (source.url && !source.url.startsWith("https://")) {
      errors.push(`Source URL must use HTTPS: ${source.id}`);
    }
    if (!source.title || !source.version || !source.notes) {
      errors.push(`Incomplete source metadata: ${source.id}`);
    }
  }
  return ids;
}

function validateSections(errors: string[], sourceIds: Set<string>) {
  const categories = new Set<WorkCategory>();
  const sectionIds = new Set<string>();
  const controlIds = new Set<string>();
  const referencedSourceIds = new Set<string>();
  for (const section of sections) {
    if (sectionIds.has(section.id)) {
      errors.push(`Duplicate section id: ${section.id}`);
    }
    sectionIds.add(section.id);
    if (!taxonomy.workCategories.includes(section.category)) {
      errors.push(`Unknown category for section: ${section.id}`);
    }
    if (categories.has(section.category)) {
      errors.push(`Duplicate category section: ${section.category}`);
    }
    categories.add(section.category);
    if (section.controls.length === 0 || section.controls.length > 100) {
      errors.push(`Invalid control count for section: ${section.id}`);
    }
    for (const control of section.controls) {
      validateControl(
        errors,
        sourceIds,
        referencedSourceIds,
        controlIds,
        control,
      );
    }
  }
  for (const category of taxonomy.workCategories) {
    if (!categories.has(category)) errors.push(`Missing category: ${category}`);
  }
  for (const sourceId of sourceIds) {
    if (!referencedSourceIds.has(sourceId)) {
      errors.push(`Unused source: ${sourceId}`);
    }
  }
}

function validateControl(
  errors: string[],
  sourceIds: Set<string>,
  referencedSourceIds: Set<string>,
  controlIds: Set<string>,
  control: ResidentialControl,
) {
  if (controlIds.has(control.id)) {
    errors.push(`Duplicate control id: ${control.id}`);
  }
  controlIds.add(control.id);
  if (!/^res-[a-z]+-[0-9]{3}$/.test(control.id)) {
    errors.push(`Invalid control id: ${control.id}`);
  }
  if (control.prompt.length === 0 || control.prompt.length > 500) {
    errors.push(`Invalid prompt length: ${control.id}`);
  }
  if (control.sourceRefs.length === 0) {
    errors.push(`Missing source: ${control.id}`);
  }
  for (const sourceReference of control.sourceRefs) {
    referencedSourceIds.add(sourceReference.sourceId);
    if (!sourceIds.has(sourceReference.sourceId)) {
      errors.push(
        `Unknown source ${sourceReference.sourceId} on ${control.id}`,
      );
    }
    if (!sourceReference.locator) {
      errors.push(`Missing source locator on ${control.id}`);
    }
  }
  if (control.domains.length === 0 || control.phases.length === 0) {
    errors.push(`Missing taxonomy assignment: ${control.id}`);
  }
  if (
    control.verificationMethods.length === 0 ||
    control.evidence.length === 0 ||
    !control.applicability ||
    !control.guidance
  ) {
    errors.push(`Incomplete control metadata: ${control.id}`);
  }
  if (control.risk.stopWorkCandidate && control.risk.priority !== "critical") {
    errors.push(`Stop-work candidate is not critical: ${control.id}`);
  }
}
