import { Type } from "typebox";
import { closedObject } from "./schema/closed-object.js";

const contributionId = Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$" });
const metadata = {
  requiredMethods: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 16 }),
  ),
  search: Type.Optional(
    closedObject({
      label: Type.String({ minLength: 1, maxLength: 200 }),
      hash: Type.String({ maxLength: 200 }),
      aliases: Type.String({ maxLength: 1000 }),
    }),
  ),
};

export const ControlUiSettingsPlacementSchema = Type.Union([
  closedObject({
    ...metadata,
    section: Type.Literal("memory"),
    panel: Type.Union([Type.Literal("overview"), Type.Literal("memories")]),
  }),
  closedObject({
    ...metadata,
    id: contributionId,
    section: Type.Literal("profile"),
    panel: Type.Literal("connections"),
  }),
  closedObject({
    ...metadata,
    id: contributionId,
    section: Type.Literal("agents"),
    panel: Type.Literal("tools"),
  }),
  closedObject({
    ...metadata,
    section: Type.Literal("channels"),
    panel: Type.Literal("detail"),
    channelId: contributionId,
  }),
]);

/** Host-owned Settings destinations with a packaged plugin presentation. */
export type ControlUiSettingsPlacement = (
  | { section: "memory"; panel: "overview" | "memories" }
  | { id: string; section: "profile"; panel: "connections" }
  | { id: string; section: "agents"; panel: "tools" }
  | { section: "channels"; panel: "detail"; channelId: string }
) & {
  /** A presentation is unavailable when its plugin does not advertise these methods. */
  requiredMethods?: string[];
  search?: { label: string; hash: string; aliases: string };
};
