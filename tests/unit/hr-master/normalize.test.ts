import { describe, expect, it } from "vitest";
import {
  cleanName,
  companyDomainMismatch,
  companyKey,
  contactKindOf,
  emailDomain,
  emailKindOf,
  isPlaceholderName,
  localPartMatchesName,
  nameKey,
  normalizeDomain,
  normalizeEmail,
  registrableDomain,
} from "@/lib/hr-master/normalize";

describe("normalizeEmail", () => {
  it("lower-cases, trims and strips mailto:/wrapping punctuation", () => {
    expect(normalizeEmail("  Mailto:<Jane.Doe@Acme.COM>; ")).toEqual({ email: "jane.doe@acme.com", valid: true });
  });
  it("rejects invalid addresses with a reason", () => {
    for (const bad of ["", "plain", "a@b", "a@@b.com", "a b@c.com", "@c.com", "a@.com", "a..b@c.com", ".a@c.com", "a@c.123"]) {
      expect(normalizeEmail(bad).valid, bad).toBe(false);
    }
    expect(normalizeEmail("nobody@").reason).toBeTruthy();
  });
  it("repairs only whitespace around dots and @ (data-entry artefact), flagging it", () => {
    expect(normalizeEmail("x.y@corp. com")).toEqual({ email: "x.y@corp.com", valid: true, repaired: true });
    expect(normalizeEmail("two words@corp.com").valid).toBe(false);
  });
});

describe("domains", () => {
  it("normalises URLs and addresses to a bare lower-case domain", () => {
    expect(normalizeDomain("https://www.Example.com:443/path?q=1")).toBe("example.com");
    expect(normalizeDomain("HTTP://sub.Example.co.in/")).toBe("sub.example.co.in");
    expect(normalizeDomain("not a domain")).toBe("");
    expect(normalizeDomain("")).toBe("");
    expect(emailDomain("a@WWW.Acme.com")).toBe("acme.com");
  });
  it("registrableDomain keeps three labels for co.in style suffixes", () => {
    expect(registrableDomain("careers.acme.co.in")).toBe("acme.co.in");
    expect(registrableDomain("www.acme.com")).toBe("acme.com");
  });
  it("tells public providers and legacy ISPs from company domains", () => {
    for (const d of ["gmail.com", "yahoo.co.in", "yahoo.com", "hotmail.com", "outlook.com", "rediffmail.com", "live.com", "aol.com", "proton.me"]) expect(emailKindOf(d), d).toBe("public-provider");
    for (const d of ["vsnl.com", "bgl.vsnl.net.in", "satyam.net.in", "usa.net"]) expect(emailKindOf(d), d).toBe("legacy-isp");
    for (const d of ["acme.com", "tcs.com", "zoho.com", "gmail.example.com"]) expect(emailKindOf(d), d).toBe("company");
  });
});

describe("names and companies", () => {
  it("recognises placeholder names but keeps real ones", () => {
    for (const n of ["HR", "Hiring Team", "hr team", "Recruitment", "General", "", "HR Manager"]) expect(isPlaceholderName(n), n).toBe(true);
    for (const n of ["Jane Doe", "Akriti", "Hari Rao"]) expect(isPlaceholderName(n), n).toBe(false);
  });
  it("name keys ignore case, order and punctuation; company keys ignore legal suffixes", () => {
    expect(nameKey("Rao, Anil")).toBe(nameKey("anil rao"));
    expect(cleanName("Dr. Anil  Rao ,")).toBe("Anil Rao");
    expect(companyKey("Acme Software Pvt. Ltd.")).toBe(companyKey("ACME"));
    expect(companyKey("Acme")).not.toBe(companyKey("Globex"));
  });
  it("detects a company that does not match the e-mail domain, and tolerates abbreviations", () => {
    expect(companyDomainMismatch("Tata Digital", "tcs.com")).toBe(true);
    expect(companyDomainMismatch("Acme Software", "acme.com")).toBe(false);
    expect(companyDomainMismatch("Tata Consultancy Services", "tcs.com")).toBe(false);
  });
  it("classifies contact kinds and name/mailbox plausibility", () => {
    expect(contactKindOf("careers@x.com", "")).toBe("role-mailbox");
    expect(contactKindOf("hr@x.com", "HR")).toBe("role-mailbox");
    expect(contactKindOf("jane.doe@x.com", "Jane Doe")).toBe("person");
    expect(contactKindOf("zz9@x.com", "")).toBe("unknown");
    expect(localPartMatchesName("jane.doe@x.com", "Jane Doe")).toBe(true);
    expect(localPartMatchesName("jdoe@x.com", "Jane Doe")).toBe(true);
    expect(localPartMatchesName("zz9@x.com", "Jane Doe")).toBe(false);
  });
});
