// ABDM's Aadhaar consent for ABHA enrolment, shown to the patient word for
// word before they enter their Aadhaar number, and sent to ABDM as
// `consent: { code, version }` on enrolment.
//
// CHECK BEFORE CERTIFICATION: copy the text and version from ABDM's current
// ABHA enrolment documentation / sandbox - certification compares them
// verbatim. Bump AADHAAR_CONSENT.version whenever the text changes.

export const AADHAAR_CONSENT = {
  code: "abha-enrollment",
  version: "1.4",
  language: "en",
  text:
    "I, hereby declare that I am voluntarily sharing my Aadhaar Number and demographic information issued by UIDAI, " +
    "with National Health Authority (NHA) for the sole purpose of creation of ABHA number. I understand that my ABHA " +
    "number can be used and shared for purposes as may be notified by ABDM from time to time including provision of " +
    "healthcare services. Further, I am aware that my personal identifiable information (Name, Address, Age, Date of " +
    "Birth, Gender and Photograph) may be made available to the entities working in the National Digital Health " +
    "Ecosystem (NDHE) which inter alia includes stakeholders and entities such as healthcare professionals (e.g. " +
    "doctors), facilities (e.g. hospitals, laboratories) and data fiduciaries (e.g. health programmes), which are " +
    "registered with or linked to the Ayushman Bharat Digital Mission (ABDM), and various processes there under. I " +
    "authorize NHA to use my Aadhaar number for performing Aadhaar based authentication with UIDAI as per the " +
    "provisions of the Aadhaar (Targeted Delivery of Financial and other Subsidies, Benefits and Services) Act, 2016 " +
    "for the aforesaid purpose. I understand that UIDAI will share my e-KYC details, or response of \"Yes\" with NHA " +
    "upon successful authentication. I have been duly informed about the option of using other IDs apart from " +
    "Aadhaar; however, I consciously choose to use Aadhaar number for the purpose of availing benefits across the " +
    "NDHE. I am aware that my personal identifiable information excluding Aadhaar number / VID number can be used " +
    "and shared for purposes as mentioned above. I reserve the right to revoke the given consent at any point of " +
    "time as per provisions of Aadhaar Act and Regulations.",
} as const;

// Verhoeff checksum - the last digit of an Aadhaar number. Lets obviously
// mistyped numbers fail here instead of at UIDAI.
const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

export function verhoeffValid(digits: string): boolean {
  let c = 0;
  const reversed = digits.split("").reverse();
  for (let i = 0; i < reversed.length; i++) c = D[c][P[i % 8][Number(reversed[i])]];
  return c === 0;
}

/** 12 digits, not starting with 0 or 1, valid Verhoeff check digit. */
export const isValidAadhaar = (aadhaar: string) => /^[2-9]\d{11}$/.test(aadhaar) && verhoeffValid(aadhaar);
