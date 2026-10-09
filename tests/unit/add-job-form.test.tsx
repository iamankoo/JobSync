// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AddJobForm, validateJobForm } from "@/components/jobs/add-job-form";
import { jsonResponse, makeJob, TZ } from "../helpers/fixtures";

const fetchMock = vi.fn();
beforeEach(() => vi.stubGlobal("fetch", fetchMock));
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

const setup = (props: Partial<React.ComponentProps<typeof AddJobForm>> = {}) =>
  render(<AddJobForm recentJobs={[]} locations={["Testville"]} timeZone={TZ} {...props} />);

const f = {
  title: () => screen.getByLabelText(/^Job Title/),
  company: () => screen.getByLabelText(/^Company/),
  link: () => screen.getByLabelText(/^Job Link/),
  location: () => screen.getByLabelText(/^Location/),
  type: () => screen.getByLabelText(/^Job Type/),
  experience: () => screen.getByLabelText(/^Experience Level/),
  salary: () => screen.getByLabelText(/^Stipend/),
  deadline: () => screen.getByLabelText(/^Application Deadline/),
  description: () => screen.getByLabelText(/^Job Description/),
};

async function fillValid(user: ReturnType<typeof userEvent.setup>) {
  await user.type(f.title(), "Test Role");
  await user.type(f.company(), "Synthetic Co");
  await user.type(f.link(), "https://jobs.example.test/new");
  await user.type(f.location(), "Testville");
  await user.selectOptions(f.type(), "Internship");
  await user.selectOptions(f.experience(), "0–1 years");
}

describe("validateJobForm (same schema as the server)", () => {
  const empty = { jobRole: "", company: "", jobUrl: "", location: "", jobType: "", experience: "", stipendSalary: "", deadline: "", description: "", workMode: "" };
  it("requires title, company, link, location, type and experience", () => {
    expect(Object.keys(validateJobForm(empty)).sort()).toEqual(["company", "experience", "jobRole", "jobType", "jobUrl", "location"]);
  });
  it("accepts a complete valid form and rejects bad URL / date", () => {
    const ok = { ...empty, jobRole: "R", company: "C", jobUrl: "https://jobs.example.test/1", location: "L", jobType: "Full-time", experience: "Fresher" };
    expect(validateJobForm(ok)).toEqual({});
    expect(validateJobForm({ ...ok, jobUrl: "not a url" }).jobUrl).toBeTruthy();
    expect(validateJobForm({ ...ok, jobUrl: "javascript:alert(1)" }).jobUrl).toBeTruthy();
    expect(validateJobForm({ ...ok, deadline: "2026-02-30" }).deadline).toBeTruthy();
  });
});

describe("Add Job form", () => {
  it("shows required-field errors on submit, focuses the first invalid field, and does not call the server", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: "Add Job" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(f.title()).toHaveAttribute("aria-invalid", "true");
    expect(screen.getAllByText("This field is required").length).toBeGreaterThanOrEqual(4);
    expect(screen.getByText("Select a job type")).toBeInTheDocument();
    expect(screen.getByText("Select an experience level")).toBeInTheDocument();
    expect(f.title()).toHaveFocus();
  });

  it("validates a field when it loses focus", async () => {
    const user = userEvent.setup();
    setup();
    await user.type(f.link(), "nope");
    await user.tab();
    expect(await screen.findByText("Enter a valid http(s) URL")).toBeInTheDocument();
    await user.clear(f.link());
    await user.type(f.link(), "https://jobs.example.test/ok");
    expect(screen.queryByText("Enter a valid http(s) URL")).not.toBeInTheDocument();
  });

  it("Clear resets every field and message", async () => {
    const user = userEvent.setup();
    setup();
    await fillValid(user);
    await user.type(f.description(), "hello");
    expect(screen.getByText("5/5000")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(f.title()).toHaveValue("");
    expect(f.type()).toHaveValue("");
    expect(f.description()).toHaveValue("");
    expect(screen.getByText("0/5000")).toBeInTheDocument();
  });

  it("submits to the server without any identity or timestamp, then confirms, resets and lists it as recent", async () => {
    const user = userEvent.setup();
    const created = makeJob(7, { jobRole: "Test Role", company: "Synthetic Co", location: "Newtown" });
    fetchMock.mockResolvedValue(jsonResponse({ data: created }, 201));
    setup();
    await fillValid(user);
    await user.type(f.salary(), "Test pay");
    await user.type(f.deadline(), "2026-12-01");
    await user.type(f.description(), "Some details");
    await user.click(screen.getByRole("button", { name: "Add Job" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/jobs");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      company: "Synthetic Co", jobRole: "Test Role", jobType: "Internship", workMode: "", experience: "0–1 years",
      stipendSalary: "Test pay", location: "Testville", jobUrl: "https://jobs.example.test/new", deadline: "2026-12-01",
      description: "Some details",
    });
    for (const forbidden of ["addedBy", "memberId", "jobId", "addedAt"]) expect(body).not.toHaveProperty(forbidden);

    expect(await screen.findByRole("status")).toHaveTextContent(/Added "Test Role" at Synthetic Co/);
    expect(f.title()).toHaveValue("");
    const recent = within(screen.getByRole("region", { name: /Recently Added Jobs/ }));
    expect(recent.getByText("Test Role")).toBeInTheDocument();
    expect(recent.getByText(/Synthetic Co • Newtown/)).toBeInTheDocument();
  });

  it("shows the real recent jobs it is given, or a plain empty message (never invented jobs)", () => {
    const { unmount } = setup({ recentJobs: [makeJob(1), makeJob(2)] });
    const recent = within(screen.getByRole("region", { name: /Recently Added Jobs/ }));
    expect(recent.getAllByRole("listitem")).toHaveLength(2);
    unmount();
    setup({ recentJobs: [] });
    expect(screen.getByText(/No jobs have been added yet/)).toBeInTheDocument();
  });

  it("explains a duplicate link, names the existing job and links to it", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: "duplicate_url", message: "dup", details: { existingJobId: "job_9", company: "Synthetic Co 9", jobRole: "Test Role 9" } } }, 409),
    );
    setup();
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: "Add Job" }));
    const alert = await screen.findByText(/Already added/);
    expect(alert.parentElement).toHaveTextContent("Test Role 9");
    expect(screen.getByRole("link", { name: "Find it in All Jobs" })).toHaveAttribute("href", "/all-jobs?q=Synthetic%20Co%209");
    expect(screen.getByText("This job link has already been added.")).toBeInTheDocument();
    // the typed values are kept so the user can fix them
    expect(f.title()).toHaveValue("Test Role");
  });

  it("maps server-side field errors onto the form", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: "validation_failed", message: "bad", details: { fields: { deadline: "Use a real date in YYYY-MM-DD format" } } } }, 400));
    setup();
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: "Add Job" }));
    expect(await screen.findByText("Use a real date in YYYY-MM-DD format")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Please fix the highlighted fields.");
  });

  it("shows service and network errors without losing the user's input", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { code: "data_service_unavailable", message: "The data service is busy. Please try again shortly." } }, 503));
    setup();
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: "Add Job" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The data service is busy");
    expect(f.company()).toHaveValue("Synthetic Co");

    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    await user.click(screen.getByRole("button", { name: "Add Job" }));
    expect(await screen.findByText(/Network error/)).toBeInTheDocument();
  });

  it("offers real location suggestions and the work-mode option", () => {
    setup({ locations: ["Testville", "Sampleton"] });
    const list = document.querySelector("datalist")!;
    expect([...list.querySelectorAll("option")].map((o) => o.getAttribute("value"))).toEqual(["Remote", "Testville", "Sampleton"]);
    expect(within(screen.getByLabelText(/^Work Mode/)).getAllByRole("option").map((o) => o.textContent)).toEqual(["Not specified", "Remote", "Hybrid", "On-site"]);
  });
});
