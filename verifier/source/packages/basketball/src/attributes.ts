import type { BasketballPosition } from "@abl/schemas";
import { sha256Commitment } from "@abl/recognition";
import { z } from "zod";

/*
 * Player attributes (ABL-RULES-V6).
 *
 * Every player career has eleven attributes, each a rating in hundredths
 * (0-10,000; 5,000 is a league-average 50.00). They belong to the career,
 * not to a roster slot, and they live league-side: careers are never
 * redeployed, so a career never holds or reports its own attributes.
 *
 * - rim: shots at the rim and short shots inside 3 m;
 * - midRange: jump shots from 3 m to the arc;
 * - three: threes;
 * - finishing: finishing through a contest at the rim;
 * - passing: how accurately a pass arrives (deflection risk);
 * - ballSecurity: holding on to the ball (strips, lost dribbles);
 * - onBallDefense: the closest defender's contest, and strips;
 * - helpDefense: other defenders' contests, passing lanes, denial;
 * - speed: how far a player moves in one decision;
 * - stamina: how fast a tired player recovers between possessions;
 * - iq: composure, so a player's results track their shot quality.
 *
 * A career starts from its position's baseline plus a small individual
 * variation (up to BASE_VARIATION either way), derived from its identity
 * commitment (the commitment to the identity receipt its isolated runtime
 * generated), so neither the participant nor the league chooses it.
 *
 * Ceilings are mostly earned. Every career starts with the same modest
 * headroom (START_HEADROOM) plus a small random part (up to
 * RANDOM_HEADROOM, and a per-attribute weight on earned headroom) drawn
 * from the season's secret seed and the identity commitment
 * (ceilingDraw). The league commits to that seed in advance (its
 * fingerprint is published and recorded in every ledger and game) and
 * reveals it when the season ends, so during the season nobody, the
 * career included, can compute a ceiling from public data, and afterwards
 * anyone can verify every one. Sustained high decision quality earns more
 * headroom (the progression ledger, development.ts); low-quality play and
 * auto-played windows earn none.
 */

export const ATTRIBUTE_KEYS = [
  "rim",
  "midRange",
  "three",
  "finishing",
  "passing",
  "ballSecurity",
  "onBallDefense",
  "helpDefense",
  "speed",
  "stamina",
  "iq",
] as const;
export type AttributeKey = (typeof ATTRIBUTE_KEYS)[number];
export type PlayerAttributes = Record<AttributeKey, number>;

/** A rating in hundredths: 5,000 is a league-average 50.00. */
export const LEAGUE_AVERAGE_RATING = 5_000;
/** No attribute (base or ceiling) goes beyond 99.00. */
export const MAX_RATING = 9_900;
/** Nor below 10.00. */
export const MIN_RATING = 1_000;

const RatingSchema = z.number().int().min(0).max(10_000);
export const PlayerAttributesSchema = z.strictObject({
  rim: RatingSchema,
  midRange: RatingSchema,
  three: RatingSchema,
  finishing: RatingSchema,
  passing: RatingSchema,
  ballSecurity: RatingSchema,
  onBallDefense: RatingSchema,
  helpDefense: RatingSchema,
  speed: RatingSchema,
  stamina: RatingSchema,
  iq: RatingSchema,
}) satisfies z.ZodType<PlayerAttributes>;

function attributes(values: readonly number[]): PlayerAttributes {
  return Object.fromEntries(
    ATTRIBUTE_KEYS.map((key, index) => [key, values[index]!]),
  ) as PlayerAttributes;
}

/**
 * Each position's starting ratings, in ATTRIBUTE_KEYS order. Guards shoot
 * and handle, bigs finish and protect the rim; every position averages
 * about 50.
 */
export const POSITION_BASELINES: Readonly<
  Record<BasketballPosition, PlayerAttributes>
> = {
  PG: attributes([
    4_800, 5_200, 5_400, 4_600, 6_200, 6_000, 5_200, 4_600, 6_000, 5_400, 5_400,
  ]),
  SG: attributes([
    4_800, 5_400, 5_600, 4_800, 5_200, 5_200, 5_200, 4_800, 5_600, 5_200, 5_000,
  ]),
  SF: attributes([
    5_200, 5_200, 5_000, 5_200, 5_000, 5_000, 5_200, 5_200, 5_200, 5_200, 5_000,
  ]),
  PF: attributes([
    5_600, 4_800, 4_400, 5_600, 4_600, 4_600, 5_000, 5_400, 4_600, 5_000, 4_800,
  ]),
  C: attributes([
    6_000, 4_400, 3_800, 6_000, 4_400, 4_400, 4_800, 5_800, 4_200, 4_800, 4_800,
  ]),
};

/**
 * How much each attribute counts toward a player's overall rating at each
 * position (percent; each row sums to 100).
 */
export const OVERALL_WEIGHTS: Readonly<
  Record<BasketballPosition, PlayerAttributes>
> = {
  PG: attributes([8, 9, 12, 6, 14, 12, 9, 5, 10, 5, 10]),
  SG: attributes([8, 11, 15, 7, 9, 9, 10, 6, 10, 5, 10]),
  SF: attributes([10, 10, 11, 9, 8, 8, 11, 9, 9, 5, 10]),
  PF: attributes([13, 9, 7, 12, 7, 7, 10, 13, 7, 5, 10]),
  C: attributes([15, 6, 4, 14, 6, 6, 10, 17, 7, 5, 10]),
};

/** An individual variation of at most this much either way. */
export const BASE_VARIATION = 300;
/** Headroom every career starts with, in every attribute. */
export const START_HEADROOM = 300;
/** The random part of a starting ceiling: at most this much more. */
export const RANDOM_HEADROOM = 150;
/** Headroom sustained high decision quality can earn, at most. */
export const MAX_EARNED_HEADROOM = 2_400;
/** Each attribute takes 85-115% of earned headroom (the random weight). */
export const EARNED_WEIGHT_MIN = 8_500;
export const EARNED_WEIGHT_SPAN = 3_000;

function hashBytes(value: `0x${string}`): number[] {
  const bytes: number[] = [];
  for (let index = 2; index < value.length; index += 2)
    bytes.push(Number.parseInt(value.slice(index, index + 2), 16));
  return bytes;
}

/** The anchor a career's attributes are derived from: its identity commitment. */
export interface CareerAttributeSeed {
  identityCommitment: `0x${string}`;
  position: BasketballPosition;
}

/**
 * A career's starting attributes: its position's baseline plus a variation
 * of up to BASE_VARIATION either way per attribute, triangular (most
 * players are near the baseline), drawn from its identity commitment.
 */
export function baseAttributes(seed: CareerAttributeSeed): PlayerAttributes {
  const bytes = hashBytes(
    sha256Commitment({
      format: "ABL-PLAYER-BASE-ATTRIBUTES-V1",
      identityCommitment: seed.identityCommitment,
    }),
  );
  const baseline = POSITION_BASELINES[seed.position];
  return Object.fromEntries(
    ATTRIBUTE_KEYS.map((key, index) => {
      const spread = bytes[2 * index]! + bytes[2 * index + 1]! - 255;
      return [
        key,
        Math.max(
          MIN_RATING,
          Math.min(
            MAX_RATING,
            baseline[key] + Math.trunc((spread * BASE_VARIATION) / 255),
          ),
        ),
      ];
    }),
  ) as PlayerAttributes;
}

/** A season seed: 32 secret bytes, held by the league until the season ends. */
export type SeasonSeed = `0x${string}`;

export const SeasonSeedSchema = z
  .string()
  .regex(/^0x[0-9a-f]{64}$/) as z.ZodType<SeasonSeed>;

/**
 * The published fingerprint of a season seed: SHA-256 (canonical JSON,
 * domain-separated) of the seed. The league commits to it before the
 * season; the seed it fingerprints is revealed when the season ends.
 */
export function seasonSeedCommitment(seed: SeasonSeed): `0x${string}` {
  return sha256Commitment({
    format: "ABL-SEASON-SEED-V1",
    seed: SeasonSeedSchema.parse(seed),
  });
}

/** The random part of a career's ceiling this season. */
export interface CeilingDraw {
  /** Extra starting headroom per attribute (0 to RANDOM_HEADROOM). */
  randomHeadroom: PlayerAttributes;
  /** How much of earned headroom each attribute takes (10,000ths). */
  earnedWeight: PlayerAttributes;
}

/**
 * The random part of a career's ceiling, drawn from the season's secret
 * seed and the career's identity commitment: nobody without the seed can
 * compute it, and nobody (the league included) can choose it once the
 * seed is committed.
 */
export function ceilingDraw(
  seed: SeasonSeed,
  identityCommitment: `0x${string}`,
): CeilingDraw {
  const bytes = hashBytes(
    sha256Commitment({
      format: "ABL-PLAYER-CEILING-DRAW-V2",
      seed: SeasonSeedSchema.parse(seed),
      identityCommitment,
    }),
  );
  return {
    randomHeadroom: Object.fromEntries(
      ATTRIBUTE_KEYS.map((key, index) => [
        key,
        Math.trunc((bytes[index]! * RANDOM_HEADROOM) / 255),
      ]),
    ) as PlayerAttributes,
    earnedWeight: Object.fromEntries(
      ATTRIBUTE_KEYS.map((key, index) => [
        key,
        EARNED_WEIGHT_MIN +
          Math.trunc((bytes[16 + index]! * EARNED_WEIGHT_SPAN) / 255),
      ]),
    ) as PlayerAttributes,
  };
}

/**
 * A career's ceiling: its base, plus the starting headroom, plus its
 * random part, plus its share of the headroom it has earned, never past
 * MAX_RATING.
 */
export function ceilingAttributes(input: {
  base: PlayerAttributes;
  draw: CeilingDraw;
  /** Headroom earned so far (hundredths of a rating point). */
  earned: number;
}): PlayerAttributes {
  return Object.fromEntries(
    ATTRIBUTE_KEYS.map((key) => [
      key,
      Math.min(
        MAX_RATING,
        input.base[key] +
          START_HEADROOM +
          input.draw.randomHeadroom[key] +
          Math.trunc((input.earned * input.draw.earnedWeight[key]) / 10_000),
      ),
    ]),
  ) as PlayerAttributes;
}

/**
 * The overall rating, in hundredths: 50.00 for a player exactly at their
 * position's baseline, plus the position-weighted average of how far each
 * attribute is above (or below) it. Measured against the position's own
 * baseline, so no position starts closer to star.
 */
export function overallRating(
  value: PlayerAttributes,
  position: BasketballPosition,
): number {
  const weights = OVERALL_WEIGHTS[position];
  const baseline = POSITION_BASELINES[position];
  return (
    LEAGUE_AVERAGE_RATING +
    Math.trunc(
      ATTRIBUTE_KEYS.reduce(
        (sum, key) => sum + (value[key] - baseline[key]) * weights[key],
        0,
      ) / 100,
    )
  );
}

/** Overall ratings from which a player is shown as a star or a superstar. */
export const STAR_OVERALL = 5_800;
export const SUPERSTAR_OVERALL = 6_200;

export type PlayerTier = "DEVELOPING" | "STARTER" | "STAR" | "SUPERSTAR";

export function playerTier(overall: number): PlayerTier {
  return overall >= SUPERSTAR_OVERALL
    ? "SUPERSTAR"
    : overall >= STAR_OVERALL
      ? "STAR"
      : overall >= 5_300
        ? "STARTER"
        : "DEVELOPING";
}

/**
 * Ratings as shown to people: whole points from 0 to 100. A rating that has
 * reached its ceiling stops rising, so showing it more precisely would
 * show the ceiling more precisely too.
 */
export function displayRatings(
  value: PlayerAttributes,
): Record<AttributeKey, number> {
  return Object.fromEntries(
    ATTRIBUTE_KEYS.map((key) => [key, Math.trunc(value[key] / 100)]),
  ) as Record<AttributeKey, number>;
}

/** The same average attributes for every player (simulations, tests). */
export function leagueAverageAttributes(
  position: BasketballPosition,
): PlayerAttributes {
  return { ...POSITION_BASELINES[position] };
}
