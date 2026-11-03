// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConnectionForm } from "@/components/connections/connection-form";
import type { Connection } from "@/types/domain";
import { jsonResponse } from "../helpers/fixtures";

const fetchMock = vi.fn();
beforeEach(() => vi.stubGlobal("fetch", fetchMock));
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

const noop = () => undefined;
const f = {
  name: () => screen.getByLabelText(/^Person Name/),
  designation: () => screen.getByLabelText(/^Person Designation/),
  email: () => screen.getByLabelText(/^Person Email/),
  company: () => screen.getByLabelText(/^Company Name/),
  url: () => screen.getByLabelText(/^Company URL/),
  trigger: () => screen.getByRole("button", { name: /Role to Apply/ }),
  custom: () => screen.getByLabelText("Custom role") as HTMLInputElement,
};

const HISTORICAL: Connection = {
  connectionId: "conn_old", memberId: "lukky", name: "Old Contact", company: "Globex", role: "Recruiter", email: "old@globex.example",
  profileUrl: "https://linkedin.com/in/old", otherUrl: "https://old.dev", message: "Old message", notes: "Role: Machine Learning Engineer",
  status: "Reply", createdAt: "2026-10-01T10:00:00.000Z", updatedAt: "2026-10-01T10:00:00.000Z",
};

type U = ReturnType<typeof userEvent.setup>;
/** Opens the single Role to Apply dropdown, picks a category and (unless Other) a role. */
async function pick(user: U, category: string, role?: string) {
  await user.click(f.trigger());
  await user.click(screen.getByRole("menuitem", { name: category }));
  if (role) await user.click(screen.getByRole("menuitem", { name: role }));
}
const menuItems = () => screen.queryAllByRole("menuitem").map((e) => e.textContent!.trim());
const labelsOf = () => [...document.querySelectorAll('label, [id$="-role-label"]')].map((l) => l.textContent!.replace(/\s*(\*|\(optional\))\s*$/, "").trim());
const SIX = ["Person Name", "Person Designation", "Person Email", "Company Name", "Company URL", "Role to Apply"];

describe("Add and Edit show the same six fields", () => {
  it("Add: exactly the six, with the right required marks", () => {
    render(<ConnectionForm onSaved={noop} onCancel={noop} />);
    expect(labelsOf()).toEqual(SIX);
    for (const [label, required] of [["Person Name", true], ["Person Designation", false], ["Person Email", true], ["Company Name", true], ["Company URL", false]] as const) {
      const el = screen.getByText(label, { selector: "label" });
      expect(Boolean(el.querySelector("[aria-hidden]")), label).toBe(required);
      expect(el.textContent!.includes("(optional)"), label).toBe(!required);
    }
  });
  it("Edit: the same six, prefilled; the removed fields never appear", () => {
    render(<ConnectionForm connection={{ ...HISTORICAL, companyUrl: "https://globex.com/", roleCategory: "AI/ML", applyRole: "Machine Learning Engineer" }} onSaved={noop} onCancel={noop} />);
    expect(labelsOf()).toEqual(SIX);
    expect(f.name()).toHaveValue("Old Contact");
    expect(f.designation()).toHaveValue("Recruiter");
    expect(f.url()).toHaveValue("https://globex.com/");
    expect(f.trigger()).toHaveTextContent("Machine Learning Engineer");
  });
  it.each([["Add", undefined], ["Edit", HISTORICAL]] as const)("%s has no LinkedIn / other URL / message / notes / status fields", (_n, connection) => {
    render(<ConnectionForm connection={connection} onSaved={noop} onCancel={noop} />);
    expect(screen.queryByLabelText(/linkedin|profile url|other profile|contact url/i)).toBeNull();
    expect(screen.queryByLabelText(/message/i)).toBeNull();
    expect(screen.queryByLabelText(/notes/i)).toBeNull();
    expect(screen.queryByLabelText(/^status/i)).toBeNull();
    expect(document.querySelectorAll("textarea")).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/Message to send|LinkedIn \/ profile/);
  });
});

describe("the single two-step Role to Apply dropdown", () => {
  it("starts closed; opening shows exactly the five categories (no placeholder option) and nothing else", async () => {
    const user = userEvent.setup();
    render(<ConnectionForm onSaved={noop} onCancel={noop} />);
    expect(menuItems()).toEqual([]);
    expect(f.trigger()).toHaveTextContent("Select role…");
    await user.click(f.trigger());
    expect(menuItems()).toEqual(["SDE", "AI/ML", "Web D", "Data", "Other"]);
    expect(document.querySelectorAll("select")).toHaveLength(0); // no second dropdown
  });
  it.each([
    ["SDE", ["Software Engineer", "Software Developer", "Backend Engineer"]],
    ["AI/ML", ["AI/ML Engineer", "Applied AI Engineer", "Agentic AI Engineer", "AI Engineer", "Machine Learning Engineer", "Python Developer"]],
    ["Web D", ["Full Stack Engineer", "Front End Developer", "Web Developer", "App Developer"]],
    ["Data", ["Data Engineer", "Data Analyst", "Data Scientist", "Data Entry"]],
  ])("%s replaces the list, in the same dropdown, with Back and its own roles", async (category, roles) => {
    const user = userEvent.setup();
    render(<ConnectionForm onSaved={noop} onCancel={noop} />);
    await user.click(f.trigger());
    await user.click(screen.getByRole("menuitem", { name: category }));
    expect(screen.getAllByRole("menu")).toHaveLength(1); // only one list visible at a time
    expect(menuItems()).toEqual(["Back", ...roles]);
    expect(f.trigger()).toHaveAttribute("aria-expanded", "true"); // still open
  });
  it("Back returns to the categories without closing, so the category can be changed before choosing a role", async () => {
    const user = userEvent.setup();
    render(<ConnectionForm onSaved={noop} onCancel={noop} />);
    await user.click(f.trigger());
    await user.click(screen.getByRole("menuitem", { name: "SDE" }));
    await user.click(screen.getByRole("menuitem", { name: "Back" }));
    expect(menuItems()).toEqual(["SDE", "AI/ML", "Web D", "Data", "Other"]);
    expect(f.trigger()).toHaveAttribute("aria-expanded", "true");
    await user.click(screen.getByRole("menuitem", { name: "Data" }));
    await user.click(screen.getByRole("menuitem", { name: "Data Analyst" }));
    expect(menuItems()).toEqual([]); // choosing a role closes it
    expect(f.trigger()).toHaveTextContent("Data Analyst");
  });
  it("Other closes the menu and shows the custom role input", async () => {
    const user = userEvent.setup();
    render(<ConnectionForm onSaved={noop} onCancel={noop} />);
    await pick(user, "Other");
    expect(menuItems()).toEqual([]);
    expect(f.trigger()).toHaveTextContent("Other");
    expect(f.custom()).toBeEnabled();
  });
  it("a different category always clears the previous specific / custom role", async () => {
    const user = userEvent.setup();
    render(<ConnectionForm onSaved={noop} onCancel={noop} />);
    await pick(user, "SDE", "Backend Engineer");
    expect(f.trigger()).toHaveTextContent("Backend Engineer");
    await pick(user, "Other");
    expect(f.trigger()).not.toHaveTextContent("Backend Engineer");
    await user.type(f.custom(), "Site Reliability Engineer");
    await pick(user, "Web D", "Web Developer");
    expect(screen.queryByLabelText("Custom role")).toBeNull();
    await pick(user, "Other");
    expect(f.custom()).toHaveValue("");
  });
  it("abandoning a half-made change (outside click) keeps the earlier valid selection", async () => {
    const user = userEvent.setup();
    render(<ConnectionForm onSaved={noop} onCancel={noop} />);
    await pick(user, "SDE", "Backend Engineer");
    await user.click(f.trigger());
    await user.click(screen.getByRole("menuitem", { name: "Data" }));
    await user.click(document.body);
    expect(menuItems()).toEqual([]);
    expect(f.trigger()).toHaveTextContent("Backend Engineer");
  });
  it("clicking outside closes it; Escape closes it and returns focus to the field", async () => {
    const user = userEvent.setup();
    render(<ConnectionForm onSaved={noop} onCancel={noop} />);
    await user.click(f.trigger());
    await user.click(f.name());
    expect(menuItems()).toEqual([]);
    await user.click(f.trigger());
    expect(menuItems().length).toBe(5);
    await user.keyboard("{Escape}");
    expect(menuItems()).toEqual([]);
    expect(f.trigger()).toHaveFocus();
  });
  it("is keyboard operable: focus moves into the menu, arrows move, Enter selects", async () => {
    const user = userEvent.setup();
    render(<ConnectionForm onSaved={noop} onCancel={noop} />);
    f.trigger().focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("menuitem", { name: "SDE" })).toHaveFocus();
    await user.keyboard("{ArrowDown}{Enter}"); // AI/ML
    expect(screen.getByRole("menuitem", { name: "Back" })).toHaveFocus();
    await user.keyboard("{ArrowDown}{Enter}"); // AI/ML Engineer
    expect(f.trigger()).toHaveTextContent("AI/ML Engineer");
    expect(f.trigger()).toHaveFocus();
  });
  it("Role to Apply sits to the right of Company URL; Cancel is left, the primary action right", () => {
    render(<ConnectionForm onSaved={noop} onCancel={noop} />);
    const labels = labelsOf();
    expect(labels.indexOf("Role to Apply")).toBe(labels.indexOf("Company URL") + 1);
    const row = screen.getByRole("button", { name: "Cancel" }).parentElement!;
    expect(row.className).toContain("justify-between");
    expect([...row.querySelectorAll("button")].map((b) => b.textContent!.trim())).toEqual(["Cancel", "Add connection"]);
  });
});

describe("validation and saving", () => {
  it("blocks an empty form, names every required field, and sends nothing", async () => {
    const user = userEvent.setup();
    render(<ConnectionForm onSaved={noop} onCancel={noop} />);
    await user.click(screen.getByRole("button", { name: "Add connection" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getAllByText("Required")).toHaveLength(3); // name, email, company
    expect(screen.getByText("Choose a role category")).toBeInTheDocument();
  });
  it("a category chosen without a role (menu abandoned), and Other without a custom role, cannot be saved", async () => {
    const user = userEvent.setup();
    render(<ConnectionForm onSaved={noop} onCancel={noop} />);
    await user.type(f.name(), "Priya");
    await user.type(f.email(), "p@acme.example");
    await user.type(f.company(), "Acme");
    await pick(user, "SDE"); // opened the SDE roles but chose none
    await user.click(screen.getByRole("button", { name: "Add connection" }));
    expect(screen.getByText("Choose a role category")).toBeInTheDocument();
    await pick(user, "Other");
    await user.click(screen.getByRole("button", { name: "Add connection" }));
    expect(screen.getByText("Enter the role")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rejects an invalid Company URL but accepts it empty", async () => {
    const user = userEvent.setup();
    render(<ConnectionForm onSaved={noop} onCancel={noop} />);
    await user.type(f.name(), "Priya");
    await user.type(f.email(), "p@acme.example");
    await user.type(f.company(), "Acme");
    await pick(user, "SDE", "Software Engineer");
    await user.type(f.url(), "javascript:alert(1)");
    await user.click(screen.getByRole("button", { name: "Add connection" }));
    expect(screen.getByText(/valid website address/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("Add posts exactly the seven form values (category and final role included) and nothing historical", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    fetchMock.mockResolvedValue(jsonResponse({ data: { connectionId: "conn_new" } }, 201));
    render(<ConnectionForm onSaved={onSaved} onCancel={noop} />);
    await user.type(f.name(), "Priya Sharma");
    await user.type(f.email(), "priya@acme.example");
    await user.type(f.company(), "Acme Corp");
    await pick(user, "AI/ML", "Machine Learning Engineer");
    await user.click(screen.getByRole("button", { name: "Add connection" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("/api/connections");
    expect(JSON.parse(init.body)).toEqual({ name: "Priya Sharma", role: "", email: "priya@acme.example", company: "Acme Corp", companyUrl: "", roleCategory: "AI/ML", applyRole: "Machine Learning Engineer" });
    expect(onSaved).toHaveBeenCalled();
  });
  it("Other saves the custom role as the final role", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse({ data: { connectionId: "conn_new" } }, 201));
    render(<ConnectionForm onSaved={noop} onCancel={noop} />);
    await user.type(f.name(), "Priya");
    await user.type(f.email(), "p@acme.example");
    await user.type(f.company(), "Acme");
    await user.type(f.url(), "acme.com");
    await pick(user, "Other");
    await user.type(f.custom(), "Site Reliability Engineer");
    await user.click(screen.getByRole("button", { name: "Add connection" }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ roleCategory: "Other", applyRole: "Site Reliability Engineer", companyUrl: "acme.com" });
  });
});

describe("a historical record in Edit", () => {
  it("offers the role its notes named as a suggestion, and sends none of the historical fields when saved", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse({ data: HISTORICAL }));
    render(<ConnectionForm connection={HISTORICAL} onSaved={noop} onCancel={noop} />);
    expect(screen.getByTestId("role-suggestion")).toBeInTheDocument();
    expect(f.trigger()).toHaveTextContent("Machine Learning Engineer");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("/api/connections/conn_old");
    const body = JSON.parse(init.body);
    expect(Object.keys(body).sort()).toEqual(["applyRole", "company", "companyUrl", "email", "name", "role", "roleCategory"]);
    expect(body).not.toHaveProperty("message");
    expect(body).not.toHaveProperty("notes");
    expect(body).not.toHaveProperty("profileUrl");
    expect(body).not.toHaveProperty("otherUrl");
  });
  it("with no recognisable role, nothing is preselected and a role must be chosen before saving", async () => {
    const user = userEvent.setup();
    render(<ConnectionForm connection={{ ...HISTORICAL, notes: "Met at the campus fair", message: undefined }} onSaved={noop} onCancel={noop} />);
    expect(screen.queryByTestId("role-suggestion")).toBeNull();
    expect(f.trigger()).toHaveTextContent("Select role…");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(screen.getByText("Choose a role category")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("shows server field errors next to the field", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: "validation_failed", message: "Some fields are invalid.", details: { fields: { email: "Enter a valid email address" } } } }, 400));
    render(<ConnectionForm connection={{ ...HISTORICAL, roleCategory: "SDE", applyRole: "Software Engineer" }} onSaved={noop} onCancel={noop} />);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    const field = within(f.email().parentElement!);
    expect(await field.findByText("Enter a valid email address")).toBeInTheDocument();
  });
});
