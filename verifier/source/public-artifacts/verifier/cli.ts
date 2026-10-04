import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { replayFinalizedGamePayload } from "../../packages/basketball/src/game-finalization.js";
import { digest, verifyArtifacts } from "./manifest.js";
import { verifyPublicEvents, verifyPublicRecognition } from "./verification.js";
export {
  PublicVerifier,
  verifyCheckpointClaim,
  verifyDeploymentAgainstRelease,
} from "../../packages/recognition/src/verifier.js";
export { InstitutionalKeyRegistry } from "../../packages/recognition/src/registry.js";
export { replayFinalizedGamePayload } from "../../packages/basketball/src/game-finalization.js";
export { verifyArtifacts } from "./manifest.js";
export { verifyPublicEvents, verifyPublicRecognition } from "./verification.js";

export async function main(args: string[]): Promise<unknown> {
  const [command, path, expected] = args;
  if (!path)
    throw new Error(
      "Usage: abl-verifier artifacts <directory> <manifest-sha256> | vectors <json> | replay <finalized-game.json> | events <packet.json> <independent-trust-digest> | recognize <packet.json> <independent-profile-digest>",
    );
  if (command === "artifacts") {
    if (!/^0x[0-9a-f]{64}$/.test(expected ?? ""))
      throw new Error("An independently obtained manifest digest is required");
    const manifest = await verifyArtifacts(path, expected);
    return {
      result: "PASS",
      verification: "ARTIFACT_INTEGRITY_ONLY",
      stage: manifest.stage,
      ablReleaseCommit: manifest.ablReleaseCommit,
      canonical: false,
    };
  }
  const input: unknown = JSON.parse(await readFile(path, "utf8"));
  if (command === "events") return verifyPublicEvents(input, expected ?? "");
  if (command === "recognize")
    return verifyPublicRecognition(input, expected ?? "", {
      ...(process.env.ABL_VERIFIER_BASE_RPC_URL === undefined
        ? {}
        : { baseRpcUrl: process.env.ABL_VERIFIER_BASE_RPC_URL }),
    });
  if (command === "vectors") {
    if (!Array.isArray(input) || input.length === 0)
      throw new Error("Nonempty test vectors required");
    for (const vector of input as {
      input: string;
      sha256: string;
      kind?: string;
      packet?: unknown;
      trustDigest?: string;
      expected?: string;
    }[]) {
      if (vector.kind === "SIGNED_EVENTS") {
        if (!["PASS", "FAIL"].includes(vector.expected ?? ""))
          throw new Error("Invalid expected public vector result");
        let passed = false;
        try {
          await verifyPublicEvents(vector.packet, vector.trustDigest ?? "");
          passed = true;
        } catch {}
        if (passed !== (vector.expected === "PASS"))
          throw new Error("Signed public event vector failed");
        continue;
      }
      if (
        typeof vector.input !== "string" ||
        digest(vector.input) !== vector.sha256
      )
        throw new Error("Public hash vector failed");
    }
    return { result: "PASS", vectors: input.length, canonical: false };
  }
  if (command === "replay") {
    const replay = replayFinalizedGamePayload(input);
    return {
      result: "PASS",
      verification: "EXACT_DETERMINISTIC_REPLAY_ONLY",
      gameId: replay.payload.gameId,
      inferenceInvocations: 0,
      canonical: false,
      recognition: "INDEPENDENT_AUTHORITY_AND_FINALITY_REQUIRED",
    };
  }
  throw new Error("Unknown public verifier command");
}
if (
  process.argv[1] &&
  realpathSync(resolve(process.argv[1])) ===
    realpathSync(fileURLToPath(import.meta.url))
) {
  main(process.argv.slice(2))
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error: unknown) => {
      console.error(
        error instanceof Error ? error.message : "Verification failed",
      );
      process.exitCode = 1;
    });
}
