import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { type Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { AuthVariables } from "./authMiddleware";
import { getDb } from "./db";
import {
  canManageOrganization,
  countOrganizationOwners,
  listOrganizationMembers,
} from "./organizationMembers";
import {
  member,
  organizationGroupCapability,
  team,
  teamMember,
} from "./schema";
import type { Bindings } from "./types";

const supportedCapabilities = ["finance"] as const;
type OrganizationCapability = (typeof supportedCapabilities)[number];

interface GroupInput {
  capabilities: OrganizationCapability[];
  name: string;
  userIds: string[];
}

interface RawGroupInput {
  capabilities?: unknown;
  name?: unknown;
  userIds?: unknown;
}

type OrganizationEnv = {
  Bindings: Bindings;
  Variables: AuthVariables;
};
type OrganizationContext = Context<OrganizationEnv>;

const organizationGroups = new Hono<OrganizationEnv>();

organizationGroups.get("/access", async (context) => {
  const organizationId = context.get("organizationId");
  const [capabilities, ownerCount] = await Promise.all([
    listUserCapabilities(
      context.env.DB,
      organizationId,
      context.get("authSession").user.id,
    ),
    countOrganizationOwners(context.env.DB, organizationId),
  ]);
  return context.json({
    capabilities,
    memberRole: context.get("organizationRole"),
    ownerCount,
  });
});

organizationGroups.get("/", async (context) => {
  if (!canManageGroups(context)) return managerRequired(context);
  const organizationId = context.get("organizationId");
  const [groups, capabilities, groupMembers, members] = await Promise.all([
    listGroups(context.env.DB, organizationId),
    listGroupCapabilities(context.env.DB, organizationId),
    listGroupMembers(context.env.DB, organizationId),
    listOrganizationMembers(context.env.DB, organizationId),
  ]);
  return context.json({
    groups: groups.map((group) => ({
      capabilities: capabilities
        .filter(({ teamId }) => teamId === group.id)
        .map(({ capability }) => capability),
      createdAt: group.createdAt,
      id: group.id,
      memberUserIds: groupMembers
        .filter(({ teamId }) => teamId === group.id)
        .map(({ userId }) => userId),
      name: group.name,
      updatedAt: group.updatedAt,
    })),
    members,
  });
});

organizationGroups.post("/", async (context) => {
  if (!canManageGroups(context)) return managerRequired(context);
  const input = await groupInput(context);
  if (!input) return invalidGroup(context);
  const organizationId = context.get("organizationId");
  if (
    !(await membersBelongToOrganization(
      context.env.DB,
      organizationId,
      input.userIds,
    ))
  ) {
    return context.json(
      { error: "Every group member must belong to this organization." },
      400,
    );
  }
  if (await groupNameExists(context.env.DB, organizationId, input.name)) {
    return context.json(
      { error: "A group with that name already exists." },
      409,
    );
  }
  const groupId = crypto.randomUUID();
  await writeGroup(context.env.DB, organizationId, groupId, input, true);
  return context.json({ id: groupId }, 201);
});

organizationGroups.patch("/:id", async (context) => {
  if (!canManageGroups(context)) return managerRequired(context);
  const groupId = context.req.param("id");
  const input = await groupInput(context);
  if (!groupId || !input) return invalidGroup(context);
  const organizationId = context.get("organizationId");
  if (!(await groupExists(context.env.DB, organizationId, groupId))) {
    return context.json({ error: "Group not found." }, 404);
  }
  if (
    !(await membersBelongToOrganization(
      context.env.DB,
      organizationId,
      input.userIds,
    ))
  ) {
    return context.json(
      { error: "Every group member must belong to this organization." },
      400,
    );
  }
  if (
    await groupNameExists(context.env.DB, organizationId, input.name, groupId)
  ) {
    return context.json(
      { error: "A group with that name already exists." },
      409,
    );
  }
  await writeGroup(context.env.DB, organizationId, groupId, input, false);
  return context.json({ id: groupId });
});

organizationGroups.delete("/:id", async (context) => {
  if (!canManageGroups(context)) return managerRequired(context);
  const groupId = context.req.param("id");
  const organizationId = context.get("organizationId");
  if (
    !groupId ||
    !(await groupExists(context.env.DB, organizationId, groupId))
  ) {
    return context.json({ error: "Group not found." }, 404);
  }
  const db = getDb(context.env.DB);
  await db.batch([
    db
      .delete(organizationGroupCapability)
      .where(
        and(
          eq(organizationGroupCapability.organizationId, organizationId),
          eq(organizationGroupCapability.teamId, groupId),
        ),
      ),
    db.delete(teamMember).where(eq(teamMember.teamId, groupId)),
    db
      .delete(team)
      .where(
        and(eq(team.id, groupId), eq(team.organizationId, organizationId)),
      ),
  ]);
  return context.body(null, 204);
});

export function requireCapability(capability: OrganizationCapability) {
  return createMiddleware<OrganizationEnv>(async (context, next) => {
    const hasAccess = await userHasCapability(
      context.env.DB,
      context.get("organizationId"),
      context.get("authSession").user.id,
      capability,
    );
    if (!hasAccess) {
      return context.json(
        { error: `${capabilityLabel(capability)} group membership required.` },
        403,
      );
    }
    return next();
  });
}

function canManageGroups(context: OrganizationContext) {
  return canManageOrganization(context.get("organizationRole"));
}

async function listUserCapabilities(
  database: D1Database,
  organizationId: string,
  userId: string,
) {
  const rows = await getDb(database)
    .selectDistinct({ capability: organizationGroupCapability.capability })
    .from(organizationGroupCapability)
    .innerJoin(team, eq(team.id, organizationGroupCapability.teamId))
    .innerJoin(teamMember, eq(teamMember.teamId, team.id))
    .where(
      and(
        eq(organizationGroupCapability.organizationId, organizationId),
        eq(team.organizationId, organizationId),
        eq(teamMember.userId, userId),
      ),
    );
  return rows.map(({ capability }) => capability as OrganizationCapability);
}

export async function userHasCapability(
  database: D1Database,
  organizationId: string,
  userId: string,
  capability: OrganizationCapability,
) {
  return Boolean(
    await getDb(database)
      .select({ one: sql`1` })
      .from(organizationGroupCapability)
      .innerJoin(team, eq(team.id, organizationGroupCapability.teamId))
      .innerJoin(teamMember, eq(teamMember.teamId, team.id))
      .where(
        and(
          eq(organizationGroupCapability.organizationId, organizationId),
          eq(organizationGroupCapability.capability, capability),
          eq(team.organizationId, organizationId),
          eq(teamMember.userId, userId),
        ),
      )
      .limit(1)
      .get(),
  );
}

async function listGroups(database: D1Database, organizationId: string) {
  return getDb(database)
    .select({
      id: team.id,
      name: team.name,
      createdAt: team.createdAt,
      updatedAt: team.updatedAt,
    })
    .from(team)
    .where(eq(team.organizationId, organizationId))
    .orderBy(asc(team.name));
}

async function listGroupCapabilities(
  database: D1Database,
  organizationId: string,
) {
  return getDb(database)
    .select({
      teamId: organizationGroupCapability.teamId,
      capability: organizationGroupCapability.capability,
    })
    .from(organizationGroupCapability)
    .where(eq(organizationGroupCapability.organizationId, organizationId));
}

async function listGroupMembers(database: D1Database, organizationId: string) {
  return getDb(database)
    .select({ teamId: teamMember.teamId, userId: teamMember.userId })
    .from(teamMember)
    .innerJoin(team, eq(team.id, teamMember.teamId))
    .where(eq(team.organizationId, organizationId));
}

async function groupInput(context: OrganizationContext) {
  const value: unknown = await context.req.json().catch(() => null);
  if (!isGroupInputRecord(value) || typeof value.name !== "string") return null;
  const name = value.name.trim();
  const capabilities = uniqueStrings(value.capabilities);
  const userIds = uniqueStrings(value.userIds);
  if (
    !name ||
    name.length > 100 ||
    !capabilities ||
    !userIds ||
    userIds.length > 100 ||
    capabilities.some((item) => !isCapability(item))
  ) {
    return null;
  }
  return { capabilities, name, userIds } as GroupInput;
}

function uniqueStrings(value: unknown) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return null;
  }
  return [
    ...new Set(value.map((item) => (item as string).trim()).filter(Boolean)),
  ];
}

function isCapability(value: string): value is OrganizationCapability {
  return (supportedCapabilities as readonly string[]).includes(value);
}

async function membersBelongToOrganization(
  database: D1Database,
  organizationId: string,
  userIds: string[],
) {
  if (userIds.length === 0) return true;
  const rows = await getDb(database)
    .select({ userId: member.userId })
    .from(member)
    .where(
      and(
        eq(member.organizationId, organizationId),
        inArray(member.userId, userIds),
      ),
    );
  return rows.length === userIds.length;
}

async function groupNameExists(
  database: D1Database,
  organizationId: string,
  name: string,
  excludedId?: string,
) {
  return Boolean(
    await getDb(database)
      .select({ one: sql`1` })
      .from(team)
      .where(
        and(
          eq(team.organizationId, organizationId),
          sql`lower(${team.name}) = lower(${name})`,
          excludedId ? ne(team.id, excludedId) : undefined,
        ),
      )
      .limit(1)
      .get(),
  );
}

async function groupExists(
  database: D1Database,
  organizationId: string,
  groupId: string,
) {
  return Boolean(
    await getDb(database)
      .select({ one: sql`1` })
      .from(team)
      .where(and(eq(team.id, groupId), eq(team.organizationId, organizationId)))
      .get(),
  );
}

async function writeGroup(
  database: D1Database,
  organizationId: string,
  groupId: string,
  input: GroupInput,
  create: boolean,
) {
  const db = getDb(database);
  const now = new Date().toISOString();
  const statements: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] = create
    ? [
        db.insert(team).values({
          id: groupId,
          name: input.name,
          organizationId,
          memberCount: input.userIds.length,
          createdAt: now,
          updatedAt: now,
        }),
      ]
    : [
        db
          .update(team)
          .set({
            name: input.name,
            memberCount: input.userIds.length,
            updatedAt: now,
          })
          .where(
            and(eq(team.id, groupId), eq(team.organizationId, organizationId)),
          ),
        db
          .delete(organizationGroupCapability)
          .where(
            and(
              eq(organizationGroupCapability.organizationId, organizationId),
              eq(organizationGroupCapability.teamId, groupId),
            ),
          ),
        db.delete(teamMember).where(eq(teamMember.teamId, groupId)),
      ];
  statements.push(
    ...input.capabilities.map((capability) =>
      db
        .insert(organizationGroupCapability)
        .values({ organizationId, teamId: groupId, capability }),
    ),
    ...input.userIds.map((userId) =>
      db.insert(teamMember).values({
        id: crypto.randomUUID(),
        teamId: groupId,
        userId,
        membershipKey: null,
        createdAt: now,
      }),
    ),
  );
  await db.batch(statements);
}

function managerRequired(context: OrganizationContext) {
  return context.json(
    { error: "Organization administrator access required." },
    403,
  );
}

function invalidGroup(context: OrganizationContext) {
  return context.json(
    { error: "A valid group name, members, and capabilities are required." },
    400,
  );
}

function capabilityLabel(capability: OrganizationCapability) {
  return capability[0]?.toUpperCase() + capability.slice(1);
}

function isGroupInputRecord(value: unknown): value is RawGroupInput {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export { organizationGroups };
