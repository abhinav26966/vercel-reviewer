import { z } from "zod";

/**
 * Locator stacks (doc 02 §3): priority `testid` > `role` > `text`/`label`/`placeholder`
 * > `css` (last resort). `xpath` is forbidden — it is deliberately absent from this union.
 */
export const RoleLocatorValueSchema = z.object({
  role: z.string().min(1),
  name: z.string(),
});

export const LocatorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("testid"), value: z.string().min(1) }),
  z.object({ kind: z.literal("role"), value: RoleLocatorValueSchema }),
  z.object({ kind: z.literal("text"), value: z.string().min(1) }),
  z.object({ kind: z.literal("label"), value: z.string().min(1) }),
  z.object({ kind: z.literal("placeholder"), value: z.string().min(1) }),
  z.object({ kind: z.literal("css"), value: z.string().min(1) }),
]);

export type Locator = z.infer<typeof LocatorSchema>;

/** ≥2 locators required for DOM actions (doc 02 §3; compiler-enforced, schema-enforced too). */
export const ActionLocatorStackSchema = z.array(LocatorSchema).min(2);
/** Assertions/lookups may carry a single locator (doc 02 §2 examples). */
export const LocatorStackSchema = z.array(LocatorSchema).min(1);

export const ViewportSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  dpr: z.number().positive(),
});

export type Viewport = z.infer<typeof ViewportSchema>;
