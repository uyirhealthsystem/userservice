import { randomUUID } from "node:crypto";
import { RecordType } from "../records/records.schemas";

// Builds the FHIR R4 document bundle ABDM exchanges for one health record,
// following the NRCeS (ABDM) profiles: a Composition of the record's type,
// the Patient, the facility (Organization), the practitioner if known, and
// the content - a DiagnosticReport for reports, DocumentReferences for the
// rest. Files are embedded (base64): an HIU can't reach our storage.

const NRCES = "https://nrces.in/ndhm/fhir/r4/StructureDefinition";
const SNOMED = "http://snomed.info/sct";

// Composition profile + SNOMED CT document type per record type.
const DOCUMENT_TYPES: Record<RecordType, { profile: string; code?: string; display: string }> = {
  DIAGNOSTIC_REPORT: { profile: "DiagnosticReportRecord", code: "721981007", display: "Diagnostic studies report" },
  PRESCRIPTION: { profile: "PrescriptionRecord", code: "440545006", display: "Prescription record" },
  OP_CONSULTATION: { profile: "OPConsultRecord", code: "371530004", display: "Clinical consultation report" },
  DISCHARGE_SUMMARY: { profile: "DischargeSummaryRecord", code: "373942005", display: "Discharge summary" },
  IMMUNIZATION: { profile: "ImmunizationRecord", code: "41000179103", display: "Immunization record" },
  WELLNESS: { profile: "WellnessRecord", display: "Wellness Record" },
  HEALTH_DOCUMENT: { profile: "HealthDocumentRecord", code: "419891008", display: "Record artifact" },
};

const FHIR_GENDER: Record<string, string> = { MALE: "male", FEMALE: "female", OTHER: "other" };

export interface BundleInput {
  record: {
    id: string;
    recordType: string;
    status: string;
    title: string;
    summary: string | null;
    recordedAt: Date;
    updatedAt: Date;
    facilityName: string | null;
    practitionerName: string | null;
  };
  files: { fileName: string; contentType: string; content: Buffer }[];
  patient: { reference: string; name: string; gender: string | null; birthDate: Date | null; abhaNumber: string };
  hip: { id: string; name: string };
}

export function buildDocumentBundle({ record, files, patient, hip }: BundleInput) {
  const type = DOCUMENT_TYPES[record.recordType as RecordType];
  const typeConcept = {
    ...(type.code && { coding: [{ system: SNOMED, code: type.code, display: type.display }] }),
    text: type.display,
  };
  const url = () => `urn:uuid:${randomUUID()}`;
  const ids = { composition: url(), patient: url(), organization: url(), practitioner: url() };
  const ref = (fullUrl: string) => ({ reference: fullUrl });
  const date = record.recordedAt.toISOString();

  const patientResource = {
    resourceType: "Patient",
    meta: { profile: [`${NRCES}/Patient`] },
    identifier: [
      {
        type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0203", code: "MR", display: "Medical record number" }] },
        system: "https://uyir.in/patient",
        value: patient.reference,
      },
      { system: "https://healthid.abdm.gov.in", value: patient.abhaNumber },
    ],
    name: [{ text: patient.name }],
    ...(patient.gender && FHIR_GENDER[patient.gender] && { gender: FHIR_GENDER[patient.gender] }),
    ...(patient.birthDate && { birthDate: patient.birthDate.toISOString().slice(0, 10) }),
  };

  const organization = {
    resourceType: "Organization",
    meta: { profile: [`${NRCES}/Organization`] },
    identifier: [{ system: "https://facility.abdm.gov.in", value: hip.id }],
    name: record.facilityName ?? hip.name,
  };

  const practitioner = record.practitionerName
    ? { resourceType: "Practitioner", meta: { profile: [`${NRCES}/Practitioner`] }, name: [{ text: record.practitionerName }] }
    : undefined;

  const attachments = files.map((f) => ({
    contentType: f.contentType,
    title: f.fileName,
    data: f.content.toString("base64"),
    creation: date,
  }));

  // The content of the record.
  const content: { fullUrl: string; resource: object }[] = [];
  if (record.recordType === "DIAGNOSTIC_REPORT") {
    content.push({
      fullUrl: url(),
      resource: {
        resourceType: "DiagnosticReport",
        status: record.status === "AMENDED" ? "amended" : "final",
        code: { text: record.title },
        subject: ref(ids.patient),
        effectiveDateTime: date,
        issued: record.updatedAt.toISOString(),
        performer: [ref(ids.organization)],
        ...(record.summary && { conclusion: record.summary }),
        ...(attachments.length > 0 && { presentedForm: attachments }),
      },
    });
  } else {
    // A record with no file still carries its summary, as text.
    const docs =
      attachments.length > 0
        ? attachments
        : [{ contentType: "text/plain", title: record.title, data: Buffer.from(record.summary ?? record.title).toString("base64"), creation: date }];
    for (const attachment of docs) {
      content.push({
        fullUrl: url(),
        resource: {
          resourceType: "DocumentReference",
          meta: { profile: [`${NRCES}/DocumentReference`] },
          status: "current",
          docStatus: record.status === "AMENDED" ? "amended" : "final",
          type: typeConcept,
          subject: ref(ids.patient),
          date,
          ...(record.summary && attachments.length > 0 && { description: record.summary }),
          content: [{ attachment }],
        },
      });
    }
  }

  const composition = {
    resourceType: "Composition",
    meta: { profile: [`${NRCES}/${type.profile}`] },
    identifier: { system: "https://uyir.in/health-record", value: record.id },
    status: record.status === "AMENDED" ? "amended" : "final",
    type: typeConcept,
    subject: ref(ids.patient),
    date,
    author: [ref(practitioner ? ids.practitioner : ids.organization)],
    title: record.title,
    custodian: ref(ids.organization),
    section: [{ title: record.title, code: typeConcept, entry: content.map((c) => ref(c.fullUrl)) }],
  };

  return {
    resourceType: "Bundle",
    id: randomUUID(),
    meta: {
      versionId: "1",
      lastUpdated: new Date().toISOString(),
      profile: [`${NRCES}/DocumentBundle`],
      security: [{ system: "http://terminology.hl7.org/CodeSystem/v3-Confidentiality", code: "V", display: "very restricted" }],
    },
    identifier: { system: "https://uyir.in/health-record", value: record.id },
    type: "document",
    timestamp: new Date().toISOString(),
    entry: [
      { fullUrl: ids.composition, resource: composition },
      { fullUrl: ids.patient, resource: patientResource },
      { fullUrl: ids.organization, resource: organization },
      ...(practitioner ? [{ fullUrl: ids.practitioner, resource: practitioner }] : []),
      ...content,
    ],
  };
}
