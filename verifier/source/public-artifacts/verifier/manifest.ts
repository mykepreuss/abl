import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  PublicationManifestSchema,
  type PublicationManifest,
} from "../../packages/schemas/src/publication.js";
export { PublicationManifestSchema, type PublicationManifest };

export const digest = (bytes: string | Uint8Array): string =>
  `0x${createHash("sha256").update(bytes).digest("hex")}`;

export function assertSafePath(path: string): void {
  if (
    isAbsolute(path) ||
    path.includes("\\") ||
    path
      .split("/")
      .some((part) => part === ".." || part === "." || part === "") ||
    path === "publication-manifest.json" ||
    path.startsWith(".git/")
  )
    throw new Error(`Unsafe or self-referential artifact path: ${path}`);
}

export function assertAllowlistedPath(path: string): void {
  assertSafePath(path);
  const fixed = [
    "README.md",
    "TERMS.md",
    "THIRD_PARTY_NOTICES.md",
    "docs/PROTOCOL.md",
    "docs/PARTICIPATION.md",
    "docs/governance/FOUNDING_CONSTITUTION.md",
    "docs/governance/DISCLOSURE_CONSTITUTION.md",
    "docs/architecture/VERIFIER_RULES.md",
    "skills/abl-league/SKILL.md",
    "skills/abl-league/agents/openai.yaml",
    "skills/abl-league/references/founding-join.md",
    "skills/abl-league/dist/abl-join.mjs",
    "skills/abl-league/dist/abl-runner.mjs",
    "skills/abl-league/dist/manifest.json",
    "skills/abl-league/dist/runner-manifest.json",
    "verifier/abl-verifier.mjs",
    "verifier/test-vectors.json",
    "verifier/schemas/publication-manifest.json",
    "verifier/schemas/event-packet.json",
    "verifier/schemas/recognition-packet.json",
  ];
  const source =
    /^verifier\/source\/(?:public-artifacts\/verifier\/(?:cli|manifest|recognition|verification)|packages\/(?:recognition|basketball|schemas)\/src\/[a-z0-9-]+|packages\/storage\/src\/crypto)\.ts$/;
  if (!fixed.includes(path) && !source.test(path))
    throw new Error(`File outside the public allowlist: ${path}`);
}

export function scanPublicContent(path: string, bytes: Uint8Array): void {
  const text = Buffer.from(bytes).toString("utf8");
  const forbidden = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,})\b/,
    /(?:postgres(?:ql)?|https?):\/\/[^\s/"'<>]+:[^\s/"'<>]+@/i,
    /https?:\/\/(?:localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|[^\s/"'<>]+\.internal)(?:[:/\s"']|$)/i,
    /(?:github\.com|raw\.githubusercontent\.com)\/mykepreuss\/agent-basketball-league/,
    /(?:github\.com\/mykepreuss\/abl\/(?:blob|tree)|raw\.githubusercontent\.com\/mykepreuss\/abl)\/(?:main|master|HEAD|latest)(?:\/|\b)/,
    /\b(?:BL_API_KEY|NEON_API_KEY|ABL_[A-Z_]*(?:SECRET|TOKEN|PASSWORD))\s*[:=]\s*["'][^"'${}\s]{12,}["']/,
  ];
  if (forbidden.some((pattern) => pattern.test(text)))
    throw new Error(
      `Credential, private origin, or mutable URL in public artifact: ${path}`,
    );
}

export async function artifactFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const name of (await readdir(dir)).sort()) {
      if (dir === root && name === ".git") continue;
      const full = join(dir, name);
      const stat = await lstat(full);
      if (stat.isSymbolicLink())
        throw new Error(`Symlink in artifact: ${full}`);
      if (stat.isDirectory()) await walk(full);
      else if (stat.isFile())
        files.push(relative(root, full).split(sep).join("/"));
      else throw new Error(`Nonregular artifact: ${full}`);
    }
  };
  if ((await lstat(root)).isSymbolicLink())
    throw new Error("Artifact root must not be a symlink");
  await walk(root);
  return files.sort();
}

export async function verifyArtifacts(
  root: string,
  expectedManifestDigest?: string,
): Promise<PublicationManifest> {
  if ((await lstat(resolve(root))).isSymbolicLink())
    throw new Error("Artifact root must not be a symlink");
  const absolute = await realpath(resolve(root));
  const manifestBytes = await readFile(
    join(absolute, "publication-manifest.json"),
  );
  if (
    expectedManifestDigest !== undefined &&
    digest(manifestBytes) !== expectedManifestDigest
  )
    throw new Error("Publication manifest digest mismatch");
  const manifest = PublicationManifestSchema.parse(
    JSON.parse(manifestBytes.toString("utf8")),
  );
  const paths = manifest.files.map((file) => file.path);
  if (
    new Set(paths).size !== paths.length ||
    paths.join("\0") !== [...paths].sort().join("\0")
  )
    throw new Error("Artifact paths must be distinct and sorted");
  for (const file of manifest.files) assertAllowlistedPath(file.path);
  const observed = await artifactFiles(absolute);
  if (
    observed.join("\0") !==
    [...paths, "publication-manifest.json"].sort().join("\0")
  )
    throw new Error("Unexpected or missing public artifact file");
  for (const file of manifest.files) {
    const bytes = await readFile(join(absolute, file.path));
    if (bytes.byteLength !== file.bytes || digest(bytes) !== file.sha256)
      throw new Error(`Artifact digest or size mismatch: ${file.path}`);
    scanPublicContent(file.path, bytes);
  }
  scanPublicContent("publication-manifest.json", manifestBytes);
  return manifest;
}
