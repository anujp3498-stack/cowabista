import { Router, type IRouter } from "express";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { contactsTable, db } from "@workspace/db";
import {
  CreateContactBody,
  CreateContactResponse,
  DeleteContactParams,
  ListContactsQueryParams,
  ListContactsResponse,
  UpdateContactBody,
  UpdateContactParams,
  UpdateContactResponse,
} from "@workspace/api-zod";
import {
  attachOrgContext,
  requireAuth,
  requireRole,
} from "../middlewares/auth";

const router: IRouter = Router();

// Contacts list is server-paginated with trigram-indexed search (see
// contacts_org_created_at_idx / contacts_*_trgm_idx) so it stays fast as an
// organization's address book grows -- never load the whole table client-side.
router.get(
  "/contacts",
  requireAuth,
  attachOrgContext,
  async (req, res): Promise<void> => {
    const query = ListContactsQueryParams.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: query.error.message });
      return;
    }
    const limit = Math.min(Math.max(query.data.limit ?? 25, 1), 100);
    const offset = Math.max(query.data.offset ?? 0, 0);
    const conditions = [eq(contactsTable.organizationId, req.organizationId!)];
    if (query.data.search) {
      const term = `%${query.data.search}%`;
      conditions.push(or(
        ilike(contactsTable.name, term),
        ilike(contactsTable.phone, term),
        ilike(contactsTable.email, term),
      )!);
    }

    const whereClause = and(...conditions);
    // total rides a window function on the same query instead of a
    // separate count(*) query, so a page with results only pays for one
    // scan of the (index-backed) matching set, not two.
    const rows = await db.select({
      id: contactsTable.id,
      organizationId: contactsTable.organizationId,
      name: contactsTable.name,
      phone: contactsTable.phone,
      email: contactsTable.email,
      tags: contactsTable.tags,
      status: contactsTable.status,
      source: contactsTable.source,
      lastContactedAt: contactsTable.lastContactedAt,
      isSample: contactsTable.isSample,
      createdAt: contactsTable.createdAt,
      updatedAt: contactsTable.updatedAt,
      total: sql<number>`count(*) over()::int`,
    }).from(contactsTable).where(whereClause)
      .orderBy(desc(contactsTable.createdAt)).limit(limit).offset(offset);
    // The window function only carries a total on returned rows -- an
    // empty page (offset past the end of the matching set, or no matches
    // at all) still needs the real total, so that one edge case falls back
    // to a plain count query rather than reporting a false zero.
    const total = rows.length > 0
      ? rows[0].total
      : (await db.select({ count: sql<number>`count(*)::int` }).from(contactsTable).where(whereClause))[0]?.count ?? 0;

    res.json(ListContactsResponse.parse({
      total,
      limit,
      offset,
      contacts: rows.map(({ total: _total, ...contact }) => contact),
    }));
  },
);

router.post(
  "/contacts",
  requireAuth,
  attachOrgContext,
  requireRole("manager"),
  async (req, res): Promise<void> => {
    const body = CreateContactBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }

    const [contact] = await db
      .insert(contactsTable)
      .values({ ...body.data, organizationId: req.organizationId! })
      .returning();

    res.status(201).json(CreateContactResponse.parse(contact));
  },
);

router.patch(
  "/contacts/:contactId",
  requireAuth,
  attachOrgContext,
  requireRole("manager"),
  async (req, res): Promise<void> => {
    const params = UpdateContactParams.safeParse(req.params);
    const body = UpdateContactBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res
        .status(400)
        .json({ error: params.error?.message ?? body.error?.message });
      return;
    }

    const [updated] = await db
      .update(contactsTable)
      .set(body.data)
      .where(
        and(
          eq(contactsTable.id, params.data.contactId),
          eq(contactsTable.organizationId, req.organizationId!),
        ),
      )
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Contact not found" });
      return;
    }

    res.json(UpdateContactResponse.parse(updated));
  },
);

router.delete(
  "/contacts/:contactId",
  requireAuth,
  attachOrgContext,
  requireRole("manager"),
  async (req, res): Promise<void> => {
    const params = DeleteContactParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const [deleted] = await db
      .delete(contactsTable)
      .where(
        and(
          eq(contactsTable.id, params.data.contactId),
          eq(contactsTable.organizationId, req.organizationId!),
        ),
      )
      .returning();

    if (!deleted) {
      res.status(404).json({ error: "Contact not found" });
      return;
    }

    res.status(204).send();
  },
);

export default router;
