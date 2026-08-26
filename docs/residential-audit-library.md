# U.S. residential audit library

The residential audit library is a jurisdiction-portable baseline for detached
one- and two-family dwellings and townhouses. It combines federal construction
safety controls with model-code, project-document, manufacturer, and
workmanship checks. It does not certify compliance with a state or local code.

The initial library contains 253 controls in 19 field-review sections. The API
publishes those controls as the global **U.S. residential construction —
comprehensive baseline** template. Organizations can copy and customize the
template without changing the shared version.

## Content architecture

Each library control has a stable ID and metadata that remains richer than the
current checklist UI:

- applicability guidance;
- work category and control domain;
- construction phases;
- hazards and risk priority;
- potential stop-work classification;
- question class and verification methods;
- expected evidence and inspector guidance; and
- source references with document locators.

The library compiler projects each control into the existing versioned audit
definition format. Audit runs therefore snapshot the exact prompts used while
the source and classification model can support future filtering, audit-pack
generation, jurisdiction overlays, and richer inspector guidance.

## Authority and jurisdiction

Source authority is explicit:

- `federal-regulation` identifies federal requirements such as OSHA rules or
  the EPA Lead Renovation, Repair and Painting Rule;
- `federal-guidance` identifies nonbinding federal research or compliance
  assistance;
- `model-code` identifies a model baseline that has no independent claim of
  local adoption;
- `industry-reference` identifies a private standard or technical reference;
  and
- `project-requirement` identifies controlling project, product, utility, or
  authority-having-jurisdiction material.

State Plan, state, county, city, utility, and project requirements must be
verified before using the template for a compliance determination. Until an
overlay provides that verification, the appropriate claim is conformance to
the U.S. residential baseline, not code compliance.

Private model codes and standards are reference-only. Controls paraphrase the
inspection intent and retain a document locator; they do not reproduce private
standards. Project-supplied documents and exact product instructions remain
subject to their applicable access and use terms.

## Risk and responses

The current audit UI records `Pass`, `Fail`, or `N/A`. A response describes the
observed baseline control; it does not by itself decide legal compliance.

Critical controls are not intended to be averaged away by lower-risk passes.
The `stopWorkCandidate` field marks conditions that may justify immediate work
suspension under an employer's authorized safety process. It does not grant an
inspector authority or automatically issue a stop-work order.

Use `N/A` only when the activity, system, or exposure is genuinely outside the
observed scope. Use an issue or other project workflow for unverified conditions
rather than converting missing evidence into a pass.

## Validation and updates

Automated validation checks the following before publication:

- unique and correctly formatted control, section, and source IDs;
- prompt limits accepted by the audit API;
- valid source references and HTTPS source URLs;
- required taxonomy and verification assignments;
- section-size limits; and
- consistency between critical priority and potential stop-work treatment.

Source entries include a review date and version description. A future source
change should create a new global template version after technical review; it
must not mutate historical audit runs. State and local support should be added
as overlays that cite the adopted edition and amendments instead of editing the
national baseline in place.

Before production use, affected controls should be reviewed by qualified
residential safety, trade, building-code, and quality professionals for the
target project and jurisdiction.
