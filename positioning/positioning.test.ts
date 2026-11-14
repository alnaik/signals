import { afterAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { paths } from "../core/paths.ts";
import { tempData } from "../core/testing.ts";
import { itemId, portfolioHtml, setPublic } from "./page.ts";

const data = tempData();
afterAll(data.cleanup);
const MD = `# Positioning

## Who I'm for
Series A-C product teams.
- Developer-tool companies with 10-80 people

## Problems I solve
- Activation and onboarding ([invite rebuild](https://github.com/example/invite-flow))

## Not for
- Ad tech

## Proofs
- Invite-flow rebuild, activation +18%
`;

test("the portfolio export holds public items only", () => {
  writeFileSync(paths.me("positioning.md"), MD);
  setPublic(itemId("Invite-flow rebuild, activation +18%"), true);
  const html = portfolioHtml("Sam Example");
  expect(html).toContain("Invite-flow rebuild, activation +18%");
  expect(html).not.toContain("Ad tech");
  expect(html).not.toContain("Developer-tool companies");
});
