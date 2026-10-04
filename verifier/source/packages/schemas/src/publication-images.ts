import { z } from "zod";

// A provider revision identifies the built image. The context commitment
// identifies its inputs, not its filesystem content or OCI digest.
export const PublicImageBindingSchema = z.strictObject({
  name: z.enum(["public-api", "arena", "candidate-edge", "career", "broker"]),
  provider: z.literal("BLAXEL"),
  imageReference: z.string().regex(/^sandbox\/[a-z0-9-]+:b[0-9a-f]{20}$/),
  buildContextSha256: z.string().regex(/^0x[0-9a-f]{64}$/),
});

export const PublicImageBindingsSchema = z
  .array(PublicImageBindingSchema)
  .min(2);
export function publicImageBindingIssues(
  stage: "READ_ONLY_BEACON" | "FOUNDING_SEASON" | "GENESIS",
  images: z.infer<typeof PublicImageBindingsSchema>,
): boolean {
  const names = images.map(({ name }) => name);
  const required =
    stage === "READ_ONLY_BEACON"
      ? ["public-api", "arena"]
      : ["public-api", "arena", "candidate-edge", "career", "broker"];
  return (
    new Set(names).size !== names.length ||
    names.length !== required.length ||
    required.some((name) => !names.includes(name as (typeof names)[number]))
  );
}
