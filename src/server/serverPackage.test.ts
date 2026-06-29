import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error The packaging script is a Node ESM utility verified by this Vitest test.
import { createServerPackage } from "../../scripts/serverPackage.mjs";

describe("server deployment package", () => {
  it("creates a lean deployable server package without node_modules", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-approval-server-package-"));
    fs.mkdirSync(path.join(workspaceRoot, "src", "server"), { recursive: true });
    fs.mkdirSync(path.join(workspaceRoot, "src", "client"), { recursive: true });
    fs.mkdirSync(path.join(workspaceRoot, "dist", "client"), { recursive: true });
    fs.mkdirSync(path.join(workspaceRoot, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, "src", "server", "index.ts"), "console.log('server');");
    fs.writeFileSync(path.join(workspaceRoot, "dist", "client", "index.html"), "<div>client</div>");
    fs.writeFileSync(path.join(workspaceRoot, "scripts", "dev-server.mjs"), "console.log('dev');");
    fs.writeFileSync(path.join(workspaceRoot, "scripts", "start-server.ps1"), "npm run start");
    fs.writeFileSync(path.join(workspaceRoot, "package-lock.json"), "{}");
    fs.writeFileSync(
      path.join(workspaceRoot, "package.json"),
      JSON.stringify({
        dependencies: { "@pdf-lib/fontkit": "^1.1.1", express: "^4.0.0", chokidar: "^4.0.0", "pdf-lib": "^1.17.1" },
        devDependencies: { electron: "^42.0.0", tsx: "^4.0.0", vite: "^6.0.0" }
      })
    );

    const result = createServerPackage({
      workspaceRoot,
      outputRoot: path.join(workspaceRoot, "dist", "server-package")
    });

    expect(path.basename(result.packageDir)).toBe("PDF图纸审批服务端");
    expect(fs.existsSync(path.join(result.packageDir, "src", "server", "index.ts"))).toBe(true);
    expect(fs.existsSync(path.join(result.packageDir, "dist", "client", "index.html"))).toBe(true);
    expect(fs.existsSync(path.join(result.packageDir, "scripts", "start-server.ps1"))).toBe(true);
    expect(fs.existsSync(path.join(result.packageDir, "node_modules"))).toBe(false);
    expect(fs.existsSync(path.join(result.packageDir, "package-lock.json"))).toBe(false);

    const packagedJson = JSON.parse(fs.readFileSync(path.join(result.packageDir, "package.json"), "utf8"));
    expect(packagedJson.scripts.start).toBe("node scripts/dev-server.mjs");
    expect(packagedJson.dependencies.express).toBe("^4.0.0");
    expect(packagedJson.dependencies["pdf-lib"]).toBe("^1.17.1");
    expect(packagedJson.dependencies["@pdf-lib/fontkit"]).toBe("^1.1.1");
    expect(packagedJson.dependencies.tsx).toBe("^4.0.0");
    expect(packagedJson.dependencies.electron).toBeUndefined();
    expect(packagedJson.dependencies.react).toBeUndefined();
    expect(packagedJson.dependencies["react-dom"]).toBeUndefined();
    expect(packagedJson.dependencies["pdfjs-dist"]).toBeUndefined();
    expect(fs.existsSync(path.join(result.packageDir, "部署说明.txt"))).toBe(true);
  });
});
