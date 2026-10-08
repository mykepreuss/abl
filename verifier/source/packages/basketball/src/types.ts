import { sha256Commitment, type CanonicalEvent } from "@abl/recognition";
import {
  BasketballPositionSchema,
  CognitionReceiptV2Schema,
  type BasketballPosition,
  type CognitionReceiptV2,
} from "@abl/schemas";
import { z } from "zod";

const Sha256HexSchema = z
  .string()
  .regex(/^0x[0-9a-f]{64}$/) as z.ZodType<`0x${string}`>;

export const POSSESSION_RESOLVED_SCHEMA_DIGEST_V1 = sha256Commitment(
  "PossessionResolved:1.0.0",
);
export const POSSESSION_RESOLVED_SCHEMA_DIGEST_V2 = sha256Commitment({
  protocol: "abl-possession-resolved",
  version: 2,
  snapshotFormat: "ABL-POSSESSION-SNAPSHOT-V1",
  snapshotStateBinding: "EVENT_HASH_STATE_ROOT_AND_SEGMENT_COMMITMENT",
});

export const TeamSchema = z.enum(["HOME", "AWAY"]);
export type Team = z.infer<typeof TeamSchema>;
export const PositionSchema = BasketballPositionSchema;
export type Position = BasketballPosition;

export interface PlayerState {
  playerId: string;
  did: string;
  team: Team;
  position: Position;
  xCm: number;
  yCm: number;
  maxSpeedCmPerWindow: number;
  shootingBps: number;
  passingBps: number;
  defenseBps: number;
  stamina: number;
}

export const PlayerStateSchema = z.strictObject({
  playerId: z.string().min(1).max(100),
  did: z.string().startsWith("did:"),
  team: TeamSchema,
  position: PositionSchema,
  xCm: z.number().int().min(0).max(2_865),
  yCm: z.number().int().min(0).max(1_524),
  maxSpeedCmPerWindow: z.number().int().positive().max(1_000),
  shootingBps: z.number().int().min(0).max(10_000),
  passingBps: z.number().int().min(0).max(10_000),
  defenseBps: z.number().int().min(0).max(10_000),
  stamina: z.number().int().min(0).max(100),
}) satisfies z.ZodType<PlayerState>;

/** The teamwork rules; see rules-v2.ts. */
export const RULES_V2 = "ABL-RULES-V2" as const;

/**
 * Play state that only the teamwork rules (V2) keep. A possession whose state
 * has no `rules` resolves under the original rules, so the roots, events and
 * replays of possessions recorded before V2 are unchanged.
 */
export interface PossessionRules {
  version: typeof RULES_V2;
  /** Decision windows scheduled for this possession. */
  windows: number;
  /** Window in which the current ball handler caught a pass, else null. */
  catchWindow: number | null;
}

export const PossessionRulesSchema = z.strictObject({
  version: z.literal(RULES_V2),
  windows: z.number().int().min(2).max(4),
  catchWindow: z.number().int().nonnegative().max(4).nullable(),
}) satisfies z.ZodType<PossessionRules>;

export interface BasketballState {
  gameId: string;
  possessionId: string;
  quarter: number;
  gameClockMs: number;
  shotClockMs: number;
  score: { home: number; away: number };
  possessionTeam: Team;
  ball: { xCm: number; yCm: number; possessorId: string | null };
  players: PlayerState[];
  window: number;
  phase: "LIVE" | "DEAD" | "FINAL";
  /** Present when the possession is played under the teamwork rules (V2). */
  rules?: PossessionRules;
}

export const BasketballStateSchema = z
  .strictObject({
    gameId: z.string().min(1).max(100),
    possessionId: z.string().min(1).max(100),
    // Overtime is unlimited while teams keep scoring (see FullGameEngine).
    quarter: z.number().int().positive().max(1_000),
    gameClockMs: z.number().int().nonnegative().max(720_000),
    shotClockMs: z.number().int().nonnegative().max(24_000),
    score: z.strictObject({
      home: z.number().int().nonnegative().max(1_000),
      away: z.number().int().nonnegative().max(1_000),
    }),
    possessionTeam: TeamSchema,
    ball: z.strictObject({
      xCm: z.number().int().min(0).max(2_865),
      yCm: z.number().int().min(0).max(1_524),
      possessorId: z.string().min(1).max(100).nullable(),
    }),
    players: z.array(PlayerStateSchema).length(10),
    window: z.number().int().nonnegative().max(1_000),
    phase: z.enum(["LIVE", "DEAD", "FINAL"]),
    rules: PossessionRulesSchema.exactOptional(),
  })
  .refine((state) => {
    const playerIds = state.players.map(({ playerId }) => playerId);
    const careerDids = state.players.map(({ did }) => did);
    return (
      new Set(playerIds).size === state.players.length &&
      new Set(careerDids).size === state.players.length &&
      state.players.filter(({ team }) => team === "HOME").length === 5 &&
      state.players.filter(({ team }) => team === "AWAY").length === 5 &&
      (["HOME", "AWAY"] as const).every((team) =>
        PositionSchema.options.every(
          (position) =>
            state.players.filter(
              (player) => player.team === team && player.position === position,
            ).length === 1,
        ),
      ) &&
      (state.ball.possessorId === null ||
        playerIds.includes(state.ball.possessorId))
    );
  }, "Basketball state identities, position coverage, and possessor must be consistent") satisfies z.ZodType<BasketballState>;

const VectorSchema = z.strictObject({
  dx: z.number().int().min(-1_000).max(1_000),
  dy: z.number().int().min(-1_000).max(1_000),
});

export const ActionIntentSchema = z.discriminatedUnion("action", [
  z.strictObject({
    windowId: z.string().min(1),
    playerId: z.string().min(1),
    action: z.literal("MOVE"),
    vector: VectorSchema,
  }),
  z.strictObject({
    windowId: z.string().min(1),
    playerId: z.string().min(1),
    action: z.literal("PASS"),
    targetPlayerId: z.string().min(1),
    lead: VectorSchema,
  }),
  z.strictObject({
    windowId: z.string().min(1),
    playerId: z.string().min(1),
    action: z.literal("SHOOT"),
    shot: z.enum(["LAYUP", "JUMPER", "THREE"]),
  }),
  z.strictObject({
    windowId: z.string().min(1),
    playerId: z.string().min(1),
    action: z.literal("SCREEN"),
  }),
  z.strictObject({
    windowId: z.string().min(1),
    playerId: z.string().min(1),
    action: z.literal("HOLD"),
  }),
]);
export type ActionIntent = z.infer<typeof ActionIntentSchema>;

/** A decision exactly as a participant returns it (the league adds IDs). */
export type ParticipantPlayerDecision =
  | { action: "MOVE"; vector: { dx: number; dy: number } }
  | {
      action: "PASS";
      targetPlayerId: string;
      lead: { dx: number; dy: number };
    }
  | { action: "SHOOT"; shot: "LAYUP" | "JUMPER" | "THREE" }
  | { action: "SCREEN" }
  | { action: "HOLD" };

const ParticipantPlayerDecisionSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("MOVE"), vector: VectorSchema }),
  z.strictObject({
    action: z.literal("PASS"),
    targetPlayerId: z.string().min(1).max(100),
    lead: VectorSchema,
  }),
  z.strictObject({
    action: z.literal("SHOOT"),
    shot: z.enum(["LAYUP", "JUMPER", "THREE"]),
  }),
  z.strictObject({ action: z.literal("SCREEN") }),
  z.strictObject({ action: z.literal("HOLD") }),
]) satisfies z.ZodType<ParticipantPlayerDecision>;

/** One action a player may take now, ready to return, and what it does. */
export interface LegalActionView {
  decision: ParticipantPlayerDecision;
  effect: string;
  /** Shots: the make chance if the shot went up now with nobody moving. */
  estimatedMakePct?: number;
  points?: 2 | 3;
  /** Passes: the chance the pass is not deflected (a deflection is a turnover). */
  estimatedCompletionPct?: number;
}

export const LegalActionViewSchema = z.strictObject({
  decision: ParticipantPlayerDecisionSchema,
  effect: z.string().min(1).max(400),
  estimatedMakePct: z.number().int().min(0).max(100).exactOptional(),
  points: z.union([z.literal(2), z.literal(3)]).exactOptional(),
  estimatedCompletionPct: z.number().int().min(0).max(100).exactOptional(),
}) satisfies z.ZodType<LegalActionView>;

/** A player on the floor as the teamwork observation describes them. */
export interface CourtPlayerView {
  playerId: string;
  team: Team;
  position: Position;
  xCm: number;
  yCm: number;
  hasBall: boolean;
  distanceFromYouCm: number;
  /** Distance to the basket the offense attacks this possession. */
  distanceToBasketCm: number;
  /** Distance to the nearest player of the other team. */
  nearestOpponentCm: number;
  /** OPEN (3 m or more from any opponent), GUARDED (1.5–3 m) or TIGHT. */
  openness: "OPEN" | "GUARDED" | "TIGHT";
}

const CourtPlayerViewSchema = z.strictObject({
  playerId: z.string().min(1).max(100),
  team: TeamSchema,
  position: PositionSchema,
  xCm: z.number().int().min(0).max(2_865),
  yCm: z.number().int().min(0).max(1_524),
  hasBall: z.boolean(),
  distanceFromYouCm: z.number().int().nonnegative().max(4_000),
  distanceToBasketCm: z.number().int().nonnegative().max(4_000),
  nearestOpponentCm: z.number().int().nonnegative().max(4_000),
  openness: z.enum(["OPEN", "GUARDED", "TIGHT"]),
}) satisfies z.ZodType<CourtPlayerView>;

/** The plain-language situation at the top of a teamwork observation. */
export interface PlayerSituationView {
  summary: string;
  youHaveTheBall: boolean;
  yourTeamIs: "OFFENSE" | "DEFENSE";
  ballHandler: { playerId: string; team: Team; position: Position } | null;
  /** This decision's number in the possession, counted from 1. */
  decision: number;
  decisionsInPossession: number;
  lastDecision: boolean;
  /** You caught a pass last decision: a shot now gets the catch bonus. */
  catchAndShoot: boolean;
  quarter: number;
  gameClockMs: number;
  shotClockMs: number;
  score: { yourTeam: number; opponent: number };
  /** The basket the offense attacks this possession. */
  basket: { xCm: number; yCm: number };
  /** On defense: the attacker you are matched up with (same position). */
  yourAssignment: string | null;
}

const PlayerSituationViewSchema = z.strictObject({
  summary: z.string().min(1).max(1_200),
  youHaveTheBall: z.boolean(),
  yourTeamIs: z.enum(["OFFENSE", "DEFENSE"]),
  ballHandler: z
    .strictObject({
      playerId: z.string().min(1).max(100),
      team: TeamSchema,
      position: PositionSchema,
    })
    .nullable(),
  decision: z.number().int().positive().max(4),
  decisionsInPossession: z.number().int().min(2).max(4),
  lastDecision: z.boolean(),
  catchAndShoot: z.boolean(),
  quarter: z.number().int().positive().max(1_000),
  gameClockMs: z.number().int().nonnegative().max(720_000),
  shotClockMs: z.number().int().nonnegative().max(24_000),
  score: z.strictObject({
    yourTeam: z.number().int().nonnegative().max(1_000),
    opponent: z.number().int().nonnegative().max(1_000),
  }),
  basket: z.strictObject({
    xCm: z.number().int().min(0).max(2_865),
    yCm: z.number().int().min(0).max(1_524),
  }),
  yourAssignment: z.string().min(1).max(100).nullable(),
}) satisfies z.ZodType<PlayerSituationView>;

export interface PlayerObservation {
  /** Teamwork rules (V2) only: the situation first, then the original fields. */
  format?: "ABL-PLAYER-OBSERVATION-V2";
  rules?: typeof RULES_V2;
  situation?: PlayerSituationView;
  legalActions?: LegalActionView[];
  /** Actions that would be ignored or have no effect, and why. */
  notUseful?: string[];
  court?: {
    you: CourtPlayerView;
    teammates: CourtPlayerView[];
    opponents: CourtPlayerView[];
  };
  rulesSummary?: string[];
  observationId: string;
  playerId: string;
  team: Team;
  position: Position;
  window: number;
  gameClockMs: number;
  shotClockMs: number;
  score: { home: number; away: number };
  self: PlayerState;
  visibleTeammates: PlayerState[];
  visibleOpponents: PlayerState[];
  ball: { xCm: number; yCm: number; possessorId: string | null } | null;
  stateCommitment: string;
}

export const PlayerObservationSchema = z.strictObject({
  format: z.literal("ABL-PLAYER-OBSERVATION-V2").exactOptional(),
  rules: z.literal(RULES_V2).exactOptional(),
  situation: PlayerSituationViewSchema.exactOptional(),
  legalActions: z.array(LegalActionViewSchema).min(1).max(16).exactOptional(),
  notUseful: z.array(z.string().min(1).max(400)).max(8).exactOptional(),
  court: z
    .strictObject({
      you: CourtPlayerViewSchema,
      teammates: z.array(CourtPlayerViewSchema).length(4),
      opponents: z.array(CourtPlayerViewSchema).length(5),
    })
    .exactOptional(),
  rulesSummary: z.array(z.string().min(1).max(400)).max(12).exactOptional(),
  observationId: z.string().min(1).max(300),
  playerId: z.string().min(1).max(100),
  team: TeamSchema,
  position: PositionSchema,
  window: z.number().int().nonnegative().max(1_000),
  gameClockMs: z.number().int().nonnegative().max(720_000),
  shotClockMs: z.number().int().nonnegative().max(24_000),
  score: z.strictObject({
    home: z.number().int().nonnegative().max(1_000),
    away: z.number().int().nonnegative().max(1_000),
  }),
  self: PlayerStateSchema,
  visibleTeammates: z.array(PlayerStateSchema).max(4),
  visibleOpponents: z.array(PlayerStateSchema).max(5),
  ball: z
    .strictObject({
      xCm: z.number().int().min(0).max(2_865),
      yCm: z.number().int().min(0).max(1_524),
      possessorId: z.string().min(1).max(100).nullable(),
    })
    .nullable(),
  stateCommitment: Sha256HexSchema,
}) satisfies z.ZodType<PlayerObservation>;

export type CognitionReceipt = CognitionReceiptV2;
export const CognitionReceiptSchema = CognitionReceiptV2Schema;

function deterministicReceiptId(seed: string): string {
  const hash = sha256Commitment(seed).slice(2);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-7${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export function createDeterministicFixtureReceipt(input: {
  careerDid: string;
  role: CognitionReceipt["role"];
  activationId: string;
  observationCommitment: `0x${string}`;
  contextManifestCommitment?: `0x${string}`;
  deadlineMs?: number;
  fallback?: CognitionReceipt["fallback"];
  transportRetries?: number;
  normalizedResourceUnits?: number;
  startedAt?: string;
  completedAt?: string;
}): CognitionReceipt {
  const contextManifestCommitment =
    input.contextManifestCommitment ??
    sha256Commitment({ activationId: input.activationId, source: "fixture" });
  const fallback = input.fallback ?? "NONE";
  return {
    schemaVersion: "1.0.0",
    receiptId: deterministicReceiptId(
      `${input.careerDid}:${input.activationId}:${input.role}`,
    ),
    activationId: input.activationId,
    careerDid: input.careerDid,
    role: input.role,
    cognitionMode: "DETERMINISTIC_FIXTURE",
    activationCommitment: sha256Commitment({
      activationId: input.activationId,
      careerDid: input.careerDid,
      role: input.role,
    }),
    observationCommitment: input.observationCommitment,
    contextManifestCommitment,
    runnerId: "abl-deterministic-fixture",
    runnerBuildDigest: sha256Commitment("abl-deterministic-fixture:v2"),
    adapterBuildDigest: sha256Commitment("structured-policy:v2"),
    providerProductModel: "fixture/deterministic/structured-policy-v2",
    provenanceLevel: "LOCAL_ARTIFACT_VERIFIED",
    ambientProductContext: "NONE",
    kernelHash: sha256Commitment("basketball-kernel-v2"),
    toolHash: sha256Commitment("no-tools"),
    startedAt: input.startedAt ?? "2026-08-26T10:00:00.000Z",
    completedAt: input.completedAt ?? "2026-08-26T10:00:00.001Z",
    deadlineMs: input.deadlineMs ?? 20_000,
    attempts: fallback === "NONE" ? 1 : 0,
    transportRetries: input.transportRetries ?? 0,
    fallback,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      normalizedResourceUnits: input.normalizedResourceUnits ?? 0,
    },
    telemetryContentPolicy: "CONTENT_FREE",
    disclosedPersonalMaterialCommitments: [],
    delegateSignatureCommitment: null,
    finalCareerSignatureCommitment: sha256Commitment({
      activationId: input.activationId,
      signer: input.careerDid,
      classification: fallback === "NONE" ? "FIXTURE_RESULT" : "FALLBACK",
    }),
  };
}

export interface SignedPlayerDecision {
  intent: ActionIntent;
  receipt: CognitionReceipt;
  authorizationEvent: CanonicalEvent<{
    intent: ActionIntent;
    receiptCommitment: `0x${string}`;
  }>;
  eventHash: `0x${string}`;
  signature: `0x${string}`;
  signerAddress: `0x${string}`;
}

export interface DecisionAuthorization<TDecision> {
  receipt: CognitionReceipt;
  authorizationEvent: CanonicalEvent<{
    decision: TDecision;
    receiptCommitment: `0x${string}`;
  }>;
  eventHash: `0x${string}`;
  signature: `0x${string}`;
  signerAddress: `0x${string}`;
}

export interface CoachDecisionBody {
  coachDid: string;
  team: Team;
  windowId: string;
  instruction:
    | "PACE"
    | "SPACE"
    | "SWITCH"
    | "PROTECT_RIM"
    | "RETAIN_CURRENT_TACTIC_AND_LINEUP";
  targetPlayerIds: string[];
}
export const CoachDecisionBodySchema = z.strictObject({
  coachDid: z.string().startsWith("did:"),
  team: TeamSchema,
  windowId: z.string().min(1).max(200),
  instruction: z.enum([
    "PACE",
    "SPACE",
    "SWITCH",
    "PROTECT_RIM",
    "RETAIN_CURRENT_TACTIC_AND_LINEUP",
  ]),
  targetPlayerIds: z.array(z.string().min(1).max(100)).max(10),
}) satisfies z.ZodType<CoachDecisionBody>;
export type CoachDecision = CoachDecisionBody &
  DecisionAuthorization<CoachDecisionBody>;

export interface RefereeDecisionBody {
  refereeDid: string;
  possessionId: string;
  sequence: number;
  call: "NO_CALL" | "PERSONAL_FOUL" | "OUT_OF_BOUNDS" | "SHOT_CLOCK";
  againstPlayerId: string | null;
  confidenceBps: number;
}
export const RefereeDecisionBodySchema = z.strictObject({
  refereeDid: z.string().startsWith("did:"),
  possessionId: z.string().min(1).max(100),
  sequence: z.number().int().nonnegative().max(10),
  call: z.enum(["NO_CALL", "PERSONAL_FOUL", "OUT_OF_BOUNDS", "SHOT_CLOCK"]),
  againstPlayerId: z.string().min(1).max(100).nullable(),
  confidenceBps: z.number().int().min(0).max(10_000),
}) satisfies z.ZodType<RefereeDecisionBody>;
export type RefereeDecision = RefereeDecisionBody &
  DecisionAuthorization<RefereeDecisionBody>;

export interface ReplayDecisionBody {
  replayDid: string;
  possessionId: string;
  reviewable: boolean;
  ruling: "CONFIRM" | "REVERSE" | "NO_REVIEW";
  evidenceCommitment: `0x${string}`;
}
export const ReplayDecisionBodySchema = z.strictObject({
  replayDid: z.string().startsWith("did:"),
  possessionId: z.string().min(1).max(100),
  reviewable: z.boolean(),
  ruling: z.enum(["CONFIRM", "REVERSE", "NO_REVIEW"]),
  evidenceCommitment: Sha256HexSchema,
}) satisfies z.ZodType<ReplayDecisionBody>;
export type ReplayDecision = ReplayDecisionBody &
  DecisionAuthorization<ReplayDecisionBody>;

export interface CompetitionAuthority {
  did: string;
  signerAddress: `0x${string}`;
}

export interface PossessionAuthorities {
  coaches: Readonly<Record<Lowercase<Team>, CompetitionAuthority>>;
  referees: readonly CompetitionAuthority[];
  replayOfficials: readonly CompetitionAuthority[];
}

export interface ResolutionEvent {
  sequence: number;
  type:
    | "WINDOW_RESOLVED"
    | "PASS"
    | "SHOT"
    | "REBOUND"
    | "OUT_OF_BOUNDS"
    | "OFFICIAL_RULING"
    | "POSSESSION_FINAL";
  data: Record<string, string | number | boolean | null>;
  stateRoot: `0x${string}`;
  eventHash: `0x${string}`;
}

export interface PublicPossessionSegment {
  sequence: number;
  previousSegmentHash: `0x${string}` | null;
  eventHashes: `0x${string}`[];
  stateRoot: `0x${string}`;
  payloadCommitment: `0x${string}`;
  segmentHash: `0x${string}`;
}

export interface PublicPossessionSnapshot {
  format: "ABL-POSSESSION-SNAPSHOT-V1";
  sequence: number;
  eventType: ResolutionEvent["type"];
  eventData: ResolutionEvent["data"];
  eventHash: `0x${string}`;
  stateRoot: `0x${string}`;
  gameId: string;
  possessionId: string;
  period: number;
  gameClockMs: number;
  shotClockMs: number;
  score: { home: number; away: number };
  possessionTeam: Team;
  phase: BasketballState["phase"];
  ball: BasketballState["ball"];
  players: Array<
    Pick<PlayerState, "playerId" | "team" | "position" | "xCm" | "yCm">
  >;
}
