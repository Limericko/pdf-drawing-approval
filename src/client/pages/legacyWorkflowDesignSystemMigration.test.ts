import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sources = ["LoginPage.tsx", "ProfilePage.tsx", "SubmitDrawingPage.tsx"]
  .map((file) => readFileSync(new URL(file, import.meta.url), "utf8"));

describe("legacy personal workflow design-system migration", () => {
  it("uses the shared actions, forms and feedback layers", () => {
    for (const source of sources) {
      expect(source).toContain("../ui/actions/index.tsx");
      expect(source).toContain("../ui/forms/index.tsx");
      expect(source).toContain("../ui/feedback/index.tsx");
    }
  });

  it("does not rebuild common controls or semantic feedback in page markup", () => {
    const source = sources.join("\n");
    expect(source).not.toMatch(/<(?:input|select|textarea)\b/);
    expect(source).not.toContain('className="secondary-button"');
    expect(source).not.toContain('className="error"');
    expect(source).not.toContain('className="success"');
    expect(source).not.toContain('className="success-message"');
  });
});
