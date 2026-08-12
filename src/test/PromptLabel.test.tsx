// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { PromptLabel } from "@/components/PromptLabel";
import { TERMINAL_USER, TERMINAL_HOST } from "@/config/siteConfig";

/**
 * Smoke test for the DOM test harness (jsdom + @testing-library/react). Renders
 * a real component and asserts on the produced DOM — proving component tests run
 * so the UI refactors that follow can be written test-first.
 */
describe("PromptLabel (harness smoke test)", () => {
  it("renders the env-driven user@host prompt with the default path", () => {
    const { container } = render(<PromptLabel />);
    expect(container).toHaveTextContent(`${TERMINAL_USER}@${TERMINAL_HOST}`);
    expect(container).toHaveTextContent(":~$");
  });

  it("renders a custom working-directory path", () => {
    render(<PromptLabel path="/var/log" />);
    expect(screen.getByText(":/var/log$")).toBeInTheDocument();
  });
});
