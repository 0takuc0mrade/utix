import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const target = path.join(root, specifier.slice(2));
    for (const ext of ["", ".ts", ".tsx", ".mjs", ".js", "/index.ts", "/index.js"]) {
      const candidate = target + ext;
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return {
          shortCircuit: true,
          url: pathToFileURL(candidate).href
        };
      }
    }
  }
  return nextResolve(specifier, context);
}
