import { z } from "zod";
import {
  createBaseCheckpointRpc,
  ViemBaseCheckpointObservationReader,
  type BaseCheckpointRpc,
} from "../../packages/recognition/src/base-checkpoints.js";
import { PublicVerifier } from "../../packages/recognition/src/verifier.js";
import { InstitutionalKeyRegistry } from "../../packages/recognition/src/registry.js";
import { sha256Commitment } from "../../packages/recognition/src/canonical.js";
import { verifyCheckpointAgainstRatifiedProfile } from "../../packages/recognition/src/recognition-profiles.js";

const hash = z.string().regex(/^0x[0-9a-f]{64}$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const signature = z.string().regex(/^0x[0-9a-fA-F]{130}$/);
const instant = z.iso.datetime();
const roles = z.enum([
  "CAREER_AGENT",
  "COMMISSIONER",
  "INTEGRITY_OFFICER",
  "TRIBUNAL",
  "PREMIER_PLAYER_BOARD",
  "DEVELOPMENT_PLAYER_BOARD",
  "PREMIER_GOVERNOR",
  "DEVELOPMENT_GOVERNOR",
  "REFEREE",
  "REPLAY_OFFICIAL",
  "PROJECTOR",
]);
export const EventPacketSchema = z.strictObject({
  format: z.literal("ABL-PUBLIC-EVENT-PACKET-V1"),
  trust: z.strictObject({
    domain: z.strictObject({
      name: z.string().min(1),
      version: z.string().min(1),
      chainId: z.number().int().positive().optional(),
      verifyingContract: address.optional(),
    }),
    registry: z
      .array(
        z.strictObject({
          address,
          did: z.string().startsWith("did:"),
          role: roles,
          validFrom: instant,
          validUntil: instant.nullable(),
          revokedAt: instant.nullable(),
          purpose: z.literal("SIGNING"),
        }),
      )
      .min(1)
      .max(128),
    threshold: z.strictObject({
      policyId: z.string().min(1),
      groups: z
        .array(
          z.strictObject({
            role: roles,
            required: z.number().int().positive(),
          }),
        )
        .min(1)
        .max(12),
    }),
  }),
  evaluatedAt: instant,
  events: z
    .array(
      z.strictObject({
        event: z.record(z.string(), z.unknown()),
        signatures: z.array(signature).min(1).max(128),
      }),
    )
    .min(1)
    .max(100_000),
});
export async function verifyPublicEvents(
  candidate: unknown,
  independentTrustDigest: string,
) {
  const packet = EventPacketSchema.parse(candidate);
  if (
    !hash.safeParse(independentTrustDigest).success ||
    sha256Commitment(packet.trust) !== independentTrustDigest
  )
    throw new Error("Independent event authority digest mismatch");
  const verifier = new PublicVerifier();
  const registry = new InstitutionalKeyRegistry(
    packet.trust.registry as ConstructorParameters<
      typeof InstitutionalKeyRegistry
    >[0],
  );
  for (const entry of packet.events) {
    const version = entry.event.aggregateVersion;
    if (typeof version !== "string" || !/^[1-9][0-9]*$/.test(version))
      throw new Error(
        "Event aggregate version must be a canonical positive integer string",
      );
    const event = {
      ...entry.event,
      aggregateVersion: BigInt(version),
    } as Parameters<PublicVerifier["verifyAndApply"]>[0]["event"];
    const result = await verifier.verifyAndApply({
      event,
      signatures: entry.signatures as `0x${string}`[],
      domain: packet.trust.domain as Parameters<
        PublicVerifier["verifyAndApply"]
      >[0]["domain"],
      registry,
      threshold: packet.trust.threshold,
      now: packet.evaluatedAt,
    });
    if (result.label !== "CANONICAL")
      throw new Error(
        `Event authority or continuity failed: ${result.reasons.join(", ")}`,
      );
  }
  return {
    result: "PASS",
    verification: "SIGNED_EVENT_AUTHORITY_AND_CONTINUITY_ONLY",
    recognitionLevel: "SIGNED_VALID",
    events: packet.events.length,
    canonical: false,
    genesis: false,
    trustDigest: independentTrustDigest,
  };
}

export const RecognitionPacketSchema = z.strictObject({
  format: z.literal("ABL-PUBLIC-RECOGNITION-PACKET-V1"),
  manifest: z.record(z.string(), z.unknown()),
  manifestDigest: hash,
  profile: z.record(z.string(), z.unknown()),
  evidence: z.record(z.string(), z.unknown()),
});
export async function verifyPublicRecognition(
  candidate: unknown,
  independentProfileDigest: string,
  options: { baseRpc?: BaseCheckpointRpc; baseRpcUrl?: string } = {},
) {
  const packet = RecognitionPacketSchema.parse(candidate);
  if (
    !hash.safeParse(independentProfileDigest).success ||
    sha256Commitment(packet.profile) !== independentProfileDigest
  )
    throw new Error("Independent ratified recognition profile digest mismatch");
  const input = {
    manifest: packet.manifest,
    manifestDigest: packet.manifestDigest,
    profile: packet.profile,
    evidence: structuredClone(packet.evidence),
  };
  let chainEvidenceSource: "VERIFIER_SELECTED_RPC" | null = null;
  if (input.evidence.mechanism === "BASE_FINALIZED") {
    // A submitted observation is a claim. Only this caller's independent RPC
    // can supply observation evidence for a finalized recognition verdict.
    input.evidence.observation = null;
    for (const [section, fields] of [
      ["claim", ["validAfter", "validBefore", "blockNumber"]],
      ["anchor", ["deploymentBlockNumber"]],
    ] as const) {
      const values = input.evidence[section];
      if (values === null || typeof values !== "object")
        throw new Error("Invalid public chain evidence");
      for (const field of fields) {
        const object = values as Record<string, unknown>;
        const value = object[field];
        if (value === null && section === "claim" && field === "blockNumber")
          continue;
        if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))
          throw new Error(
            "Chain integers must be canonical nonnegative strings",
          );
        object[field] = BigInt(value);
      }
    }
    const baseInput = input as unknown as Parameters<
      typeof verifyCheckpointAgainstRatifiedProfile
    >[0];
    const preflight = await verifyCheckpointAgainstRatifiedProfile(baseInput);
    if (!preflight.reasons.includes("CHECKPOINT_CHAIN_OBSERVATION_MISSING"))
      throw new Error(
        `Checkpoint recognition failed: ${preflight.reasons.join(", ")}`,
      );
    const evidence = baseInput.evidence;
    if (
      evidence.mechanism !== "BASE_FINALIZED" ||
      evidence.anchor.state !== "RATIFIED"
    )
      throw new Error("Invalid public chain evidence");
    let rpc = options.baseRpc;
    if (rpc === undefined && options.baseRpcUrl !== undefined) {
      try {
        const url = new URL(options.baseRpcUrl);
        if (url.protocol !== "https:" || url.username || url.password)
          throw new Error("Invalid verifier RPC URL");
        rpc = createBaseCheckpointRpc(
          url.href,
          evidence.anchor.contractAddress,
        );
      } catch {
        throw new Error(
          "Verifier-selected Base RPC requires an HTTPS URL without userinfo",
        );
      }
    }
    if (rpc === undefined)
      throw new Error(
        "Independent Base RPC required; submitted observations are claims only",
      );
    try {
      const reader = new ViemBaseCheckpointObservationReader({
        contractAddress: evidence.anchor.contractAddress,
        rpc,
      });
      input.evidence.observation = await reader.checkpointObservation({
        checkpoint: evidence.claim,
      });
      chainEvidenceSource = "VERIFIER_SELECTED_RPC";
    } catch {
      // Provider errors can contain private endpoint credentials. Fail closed
      // without forwarding their transport details to public output.
      throw new Error(
        "Independent Base RPC observation unavailable; finality unverified",
      );
    }
  }
  const result = await verifyCheckpointAgainstRatifiedProfile(
    input as unknown as Parameters<
      typeof verifyCheckpointAgainstRatifiedProfile
    >[0],
  );
  if (result.label !== "CANONICAL")
    throw new Error(
      `Checkpoint recognition failed: ${result.reasons.join(", ")}`,
    );
  return {
    result: "PASS",
    verification: "CHECKPOINT_AGAINST_INDEPENDENTLY_TRUSTED_RATIFIED_PROFILE",
    canonicalCheckpoint: true,
    canonical: false,
    genesis: false,
    recognitionLevel: result.recognitionLevel,
    mechanism: result.mechanism,
    chainEvidenceSource,
    manifestDigest: packet.manifestDigest,
    trustDigest: independentProfileDigest,
  };
}
