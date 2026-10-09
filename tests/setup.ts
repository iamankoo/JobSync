import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Unmount rendered components between tests (no-op for node-environment tests).
afterEach(() => cleanup());
