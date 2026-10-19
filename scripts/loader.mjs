import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import ts from "typescript";

const __dirname = typeof import.meta.dirname !== "undefined"
  ? import.meta.dirname
  : path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

export async function resolve(specifier, context, nextResolve) {
  if ((specifier === "node:util" || specifier === "util") && !context.parentURL?.includes("shims/util.mjs")) {
    return {
      shortCircuit: true,
      url: pathToFileURL(path.join(__dirname, "shims", "util.mjs")).href
    };
  }

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
  } else if (specifier.startsWith(".") && context.parentURL) {
    try {
      const parentPath = new URL(context.parentURL).pathname;
      const parentDir = path.dirname(parentPath);
      const target = path.resolve(parentDir, specifier);
      for (const ext of ["", ".ts", ".tsx", ".mjs", ".js", "/index.ts", "/index.js"]) {
        const candidate = target + ext;
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return {
            shortCircuit: true,
            url: pathToFileURL(candidate).href
          };
        }
      }
    } catch {
      // Fall through to nextResolve
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith(".ts") || url.endsWith(".tsx")) {
    const filePath = fileURLToPath(url);
    const source = await fs.promises.readFile(filePath, "utf8");
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true
      },
      fileName: filePath
    });
    return {
      format: "module",
      shortCircuit: true,
      source: outputText
    };
  }
  return nextLoad(url, context);
}
