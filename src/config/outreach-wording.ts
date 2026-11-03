/**
 * Fallback wording for personalised outreach text when the data has no person name or no company name. Used ONLY in message
 * text and in the Connections form's required name field; never written into PersonName / CompanyName in the Outreach Database.
 */
export const FALLBACK_SALUTATION = "Hiring Team";
export const FALLBACK_COMPANY = "your company";
export const isFallbackCompany = (name: string | undefined) => (name ?? "").trim().toLowerCase() === FALLBACK_COMPANY;
