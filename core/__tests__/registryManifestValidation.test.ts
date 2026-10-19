import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  renderManifests,
  renderPanels,
  renderRegistry,
  validateManifestMetadata
} from "../../scripts/generate-registry.mjs";

/**
 * Feature-manifest metadata validation (issue #141).
 *
 * The generator already refused a *missing* field, but a field with a wrong
 * value was written straight through into the generated registry. Manifest
 * metadata reaches navigation, the command palette, search filtering and page
 * headings, so a bad entry surfaces far from the file that caused it — a status
 * of "prod" renders as an unknown badge, a bogus network renders as a filter
 * that matches nothing, a duplicate keyword is invisible, and an `http://` or
 * `javascript:` link is followed from navigation.
 *
 * These fixtures are `.txt` rather than `.ts` on purpose: a manifest declaring
 * an invalid status or network is exactly what the type system rejects, and
 * `tsconfig.json` includes every TypeScript file, so typed fixtures could not express the
 * invalid shapes at all.
 */
const FIXTURE_DIR = path.resolve(process.cwd(), "scripts/__tests__/fixtures/registry-manifests");

function readFixture(name: string): string {
  return readFileSync(path.join(FIXTURE_DIR, `${name}.txt`), "utf8");
}

const REJECTED: ReadonlyArray<readonly [string, string, RegExp]> = [
  [
    "invalid-status",
    "a status outside the FeatureStatus union",
    /features\/invalid-status-slice\/manifest\.ts status: "prod" is not a valid feature status/
  ],
  [
    "invalid-network",
    "a network the app cannot query",
    /features\/invalid-network-slice\/manifest\.ts networks: "futurenet" is not a supported Stellar network/
  ],
  [
    "duplicate-keywords",
    "a keyword repeated, differing only in case or padding",
    /features\/duplicate-keywords-slice\/manifest\.ts keywords: duplicate keyword "Price"/
  ],
  [
    "unsafe-link",
    "an insecure external link in manifest metadata",
    /features\/unsafe-link-slice\/manifest\.ts link: "http:\/\/legacy\.example\.com\/docs" uses the forbidden scheme "http:"/
  ]
];

describe("feature manifest metadata validation", () => {
  it("has a fixture for every rejected shape", () => {
    const fixtures = readdirSync(FIXTURE_DIR).map((file) => file.replace(/\.txt$/, ""));
    expect(fixtures).toContain("valid");
    for (const [name] of REJECTED) {
      expect(fixtures, `missing fixture for ${name}`).toContain(name);
    }
  });

  it("accepts a manifest whose metadata is all valid", () => {
    const slug = readFixture("valid").match(/slug:\s*"([^"]+)"/)?.[1] ?? "valid-slice";
    expect(validateManifestMetadata(slug, readFixture("valid"))).toBe(true);
  });

  it.each(REJECTED)("rejects %s (%s)", (_name, _reason, expected) => {
    // The slug is the directory name, which is what the error message must
    // name so the author knows which file to open.
    const slug = readFixture(_name).match(/slug:\s*"([^"]+)"/)?.[1] ?? _name;

    expect(() => validateManifestMetadata(slug, readFixture(_name))).toThrow(expected);
  });

  it("names the offending field, not just the registry", () => {
    for (const [name] of REJECTED) {
      const slug = readFixture(name).match(/slug:\s*"([^"]+)"/)?.[1] ?? name;
      let message = "";
      try {
        validateManifestMetadata(slug, readFixture(name));
      } catch (error) {
        message = (error as Error).message;
      }

      // Every rejection identifies the slice and the field, so the error points
      // at a line rather than at "the registry".
      expect(message).toContain(`features/${slug}/manifest.ts`);
      expect(message).toMatch(/(status|networks|keywords|link):/);
    }
  });

  it("rejects a keyword repeated with different casing", () => {
    // "Price" is the repeat, and it is the repeat that is reported, because the
    // first spelling is the one that was kept.
    expect(() => validateManifestMetadata("cased", readFixture("duplicate-keywords"))).toThrow(
      /duplicate keyword "Price" \(also declared as "price"\)/
    );
  });

  it("rejects a keyword repeated with different padding", () => {
    // "fixture" and " fixture " differ only in padding, so this pair is a real
    // duplicate that a naive string comparison would miss.
    const padded = readFixture("valid").replace(
      'keywords: ["valid", "fixture", "baseline"]',
      'keywords: ["fixture", " fixture "]'
    );

    expect(() => validateManifestMetadata("padded", padded)).toThrow(
      /duplicate keyword " fixture " \(also declared as "fixture"\)/
    );
  });

  it("rejects every forbidden link scheme, and allows https", () => {
    const base = readFixture("valid");
    const withDoc = (url: string) => base.replace('keywords:', `docs: "${url}", keywords:`);

    for (const url of [
      "http://example.com",
      "javascript:alert(1)",
      "data:text/html,<b>x",
      "file:///etc/passwd"
    ]) {
      expect(() => validateManifestMetadata("linky", withDoc(url)), url).toThrow(
        /uses the forbidden scheme/
      );
    }

    expect(validateManifestMetadata("linky", withDoc("https://example.com/docs"))).toBe(true);
  });

  it("rejects an empty status, not only a wrong one", () => {
    const source = readFixture("valid").replace('status: "beta"', 'status: ""');

    expect(() => validateManifestMetadata("empty-status", source)).toThrow(
      /status: "" is not a valid feature status/
    );
  });

  it("leaves a non-literal value alone rather than guessing", () => {
    // A computed `networks: pick()` cannot be checked by reading the source.
    // Reporting it as valid would be a false claim, and reporting it as invalid
    // would break a legitimate manifest, so it is left to the type system and
    // this check stays out of its way.
    const computed = readFixture("valid").replace(
      'networks: ["testnet", "mainnet"]',
      "networks: pick()"
    );

    expect(validateManifestMetadata("computed", computed)).toBe(true);
  });
});

describe("valid generated output is preserved", () => {
  it("still renders a manifest module for a valid slug list", () => {
    const rendered = renderManifests(["valid-slice", "invalid-status-slice"]);

    expect(rendered).toContain('import { manifest as validSlice } from "@/features/valid-slice/manifest";');
    expect(rendered).toContain("export const generatedRegistrySchemaVersion = 1 as const;");
    expect(rendered).toContain("validSlice");
  });

  it("still renders registry and panel modules unchanged", () => {
    expect(renderRegistry(["valid-slice"])).toContain(
      '{ manifest: validSlice, load: async () => { const mod = await import("@/features/valid-slice/panel"); return mod.default as ComponentType; } }'
    );
    expect(renderPanels(["valid-slice"])).toContain(
      '"valid-slice": () => import("@/features/valid-slice/panel").then((mod) => mod.default as ComponentType)'
    );
  });

  it("renders an empty registry without inventing entries", () => {
    // The empty body is two newlines: the template puts the join on its own
    // line, so the output is "[\n\n];".
    expect(renderRegistry([])).toContain("export const generatedFeatures: FeatureEntry[] = [\n\n];");
    expect(renderManifests([])).toContain("export const generatedManifests: FeatureManifest[] = [\n\n];");
  });
});
