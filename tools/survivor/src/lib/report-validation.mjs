export const CONSENT_VERSION = "2026-10-20-survivor-v2";
export const ACCOUNT_TYPES = ["Evaluation", "Funded", "Instant funded", "Self-funded", "Other / unsure"];
export const IMPACT_TYPES = ["Failed evaluation", "Lost funded account", "Reduced profit or payout", "Unexpected fill", "Other"];
export function validateReport(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "Please check your report and try again." };
  if (input.website) return { error: "Unable to accept this submission." };
  if (input.consent !== true) return { error: "Please agree to the contact and data-use statement." };
  if (typeof input.email !== "string" || input.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) return { error: "Enter a valid email address." };
  if (!ACCOUNT_TYPES.includes(input.accountType)) return { error: "Choose your account stage." };
  if (!Array.isArray(input.impacts) || !input.impacts.length || input.impacts.length > IMPACT_TYPES.length || input.impacts.some(x => !IMPACT_TYPES.includes(x))) return { error: "Select at least one reported impact." };
  if (typeof input.name !== "string" || input.name.length > 100) return { error: "Name must be 100 characters or fewer." };
  if (typeof input.details !== "string" || input.details.length > 3000) return { error: "Please keep the description to 3,000 characters." };
  if (typeof input.instrument !== "string" || input.instrument.length > 80) return { error: "Instrument must be 80 characters or fewer." };
  if (typeof input.incidentMonth !== "string" || (input.incidentMonth && !/^20\d{2}-(0[1-9]|1[0-2])$/.test(input.incidentMonth))) return { error: "Choose a valid month." };
  if (input.incidentMonth && input.incidentMonth > new Date().toISOString().slice(0,7)) return { error: "The incident month cannot be in the future." };
  if (typeof input.evidenceAvailable !== "boolean") return { error: "Please check your evidence preference." };
  if (typeof input.requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId)) return { error: "Please refresh this page and try again." };
  if (typeof input.withdrawalToken !== "string" || !/^[0-9a-f]{64}$/.test(input.withdrawalToken)) return { error: "Please refresh this page and try again." };
  return { data: { email: input.email.trim().toLowerCase(), name: input.name.trim() || null, accountType: input.accountType, impacts: [...new Set(input.impacts)], details: input.details.trim() || null, instrument: input.instrument.trim() || null, incidentMonth: input.incidentMonth || null, evidenceAvailable: input.evidenceAvailable, requestId: input.requestId, withdrawalToken: input.withdrawalToken, consentVersion: CONSENT_VERSION } };
}
export function toCsv(rows) {
  const fields = ["id", "created_at", "name", "email", "account_type", "impacts", "incident_month", "instrument", "details", "evidence_available", "consent_version"];
  const cell = x => { let s = x == null ? "" : String(x); if (/^[\s]*[=+@-]/.test(s)) s = "'" + s; return '"' + s.replaceAll('"', '""') + '"'; };
  return [fields, ...rows.map(row => fields.map(f => row[f]))].map(row => row.map(cell).join(",")).join("\r\n");
}
