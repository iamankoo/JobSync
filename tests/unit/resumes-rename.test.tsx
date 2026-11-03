// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ResumesCard } from "@/components/profile/resumes-card";
import type { ResumeInfo } from "@/lib/google-sheets/member-files-service";
import { jsonResponse } from "../helpers/fixtures";

const fetchMock = vi.fn();
beforeEach(() => vi.stubGlobal("fetch", fetchMock));
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

const PDF_A: ResumeInfo = { recordId: "res_a", fileName: "Anni CV.pdf", mimeType: "application/pdf", sizeBytes: 2048, uploadedAt: "2026-10-01T10:00:00.000Z" };
const PDF_B: ResumeInfo = { recordId: "res_b", fileName: "Second.pdf", mimeType: "application/pdf", sizeBytes: 2048, uploadedAt: "2026-10-02T10:00:00.000Z" };
const DOCX: ResumeInfo = { recordId: "res_c", fileName: "Word.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sizeBytes: 2048, uploadedAt: "2026-10-03T10:00:00.000Z" };

describe("renaming an uploaded PDF", () => {
  it("shows a pencil beside each PDF filename (not beside Word files), next to the existing open / download / delete", () => {
    render(<ResumesCard initial={[PDF_A, DOCX]} />);
    expect(screen.getByRole("button", { name: "Rename Anni CV.pdf" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rename Word.docx" })).toBeNull();
    expect(screen.getByRole("link", { name: "Open Anni CV.pdf" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download Anni CV.pdf" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete Anni CV.pdf" })).toBeInTheDocument();
  });

  it("renames in place: the input holds the name without .pdf, the request is a PATCH, and the list shows the new name", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse({ data: { ...PDF_A, fileName: "Anni SDE Resume.pdf" } }));
    render(<ResumesCard initial={[PDF_A]} />);
    await user.click(screen.getByRole("button", { name: "Rename Anni CV.pdf" }));
    const input = screen.getByLabelText("New file name");
    expect(input).toHaveValue("Anni CV");
    await user.clear(input);
    await user.type(input, "  Anni SDE Resume ");
    await user.click(screen.getByRole("button", { name: "Save new name" }));
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("/api/profile/resumes/res_a");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ fileName: "  Anni SDE Resume " });
    expect(await screen.findByText("Anni SDE Resume.pdf")).toBeInTheDocument();
    // the same record keeps working: the open / download links still point at the same id
    expect(screen.getByRole("link", { name: "Open Anni SDE Resume.pdf" })).toHaveAttribute("href", "/api/profile/resumes/res_a");
  });

  it("blocks an empty or invalid name and a duplicate before any request, with a message", async () => {
    const user = userEvent.setup();
    render(<ResumesCard initial={[PDF_A, PDF_B]} />);
    await user.click(screen.getByRole("button", { name: "Rename Anni CV.pdf" }));
    const input = screen.getByLabelText("New file name");
    await user.clear(input);
    await user.click(screen.getByRole("button", { name: "Save new name" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a file name.");
    await user.type(input, "a/b");
    await user.click(screen.getByRole("button", { name: "Save new name" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/cannot contain/);
    await user.clear(input);
    await user.type(input, "second");
    await user.click(screen.getByRole("button", { name: "Save new name" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/already have a resume with that name/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the server's message when it refuses, keeps the old name, and Cancel / Escape leaves everything unchanged", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: "resume_name_taken", message: "You already have a resume with that name. Choose another." } }, 409));
    render(<ResumesCard initial={[PDF_A]} />);
    await user.click(screen.getByRole("button", { name: "Rename Anni CV.pdf" }));
    await user.clear(screen.getByLabelText("New file name"));
    await user.type(screen.getByLabelText("New file name"), "Other");
    await user.click(screen.getByRole("button", { name: "Save new name" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose another");
    await user.click(screen.getByRole("button", { name: "Cancel renaming" }));
    expect(screen.getByText("Anni CV.pdf")).toBeInTheDocument();
    expect(screen.queryByLabelText("New file name")).toBeNull();
  });
});
