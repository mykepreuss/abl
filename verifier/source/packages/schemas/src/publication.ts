import { z } from "zod";
import {
  PublicImageBindingsSchema,
  publicImageBindingIssues,
} from "./publication-images.js";

const hash = z.string().regex(/^0x[0-9a-f]{64}$/);
export const PublicBlaxelOriginSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/" &&
      url.hostname.endsWith(".preview.bl.run") &&
      value === url.origin
    );
  }, "An exact credential-free Blaxel origin is required");
export const PublicationOriginsSchema = z.strictObject({
  publicApi: PublicBlaxelOriginSchema,
  arena: PublicBlaxelOriginSchema,
  candidateIntake: PublicBlaxelOriginSchema.nullable(),
});
export const PublicationManifestSchema = z
  .strictObject({
    format: z.literal("ABL-PUBLICATION-MANIFEST-V1"),
    stage: z.enum(["READ_ONLY_BEACON", "FOUNDING_SEASON", "GENESIS"]),
    ablReleaseCommit: z.string().regex(/^[0-9a-f]{40}$/),
    launchStateDigest: hash,
    origins: PublicationOriginsSchema,
    files: z
      .array(
        z.strictObject({
          path: z.string().min(1),
          bytes: z.number().int().nonnegative(),
          mediaType: z.string().min(1),
          sha256: hash,
        }),
      )
      .min(1),
    publicImages: PublicImageBindingsSchema,
    privateDeploymentDigest: hash,
    createdAt: z.iso.datetime(),
    compatibilityVersion: z.literal("3.0.0"),
  })
  .superRefine((manifest, context) => {
    if (publicImageBindingIssues(manifest.stage, manifest.publicImages))
      context.addIssue({
        code: "custom",
        path: ["publicImages"],
        message:
          "Every stage-relevant provider image revision and build-context commitment is required exactly once",
      });
    if (
      manifest.stage === "READ_ONLY_BEACON" &&
      manifest.origins.candidateIntake !== null
    )
      context.addIssue({
        code: "custom",
        path: ["origins", "candidateIntake"],
        message: "Beacon must not advertise candidate mutation ingress",
      });
    if (
      manifest.stage !== "READ_ONLY_BEACON" &&
      manifest.origins.candidateIntake === null
    )
      context.addIssue({
        code: "custom",
        path: ["origins", "candidateIntake"],
        message: "Founding and Genesis require a bound candidate origin",
      });
  });
export type PublicationManifest = z.infer<typeof PublicationManifestSchema>;
