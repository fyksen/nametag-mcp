import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function createNametagApi(urlValue, token, fetchImpl = globalThis.fetch) {
  if (!token) throw new Error("NAMETAG_API_TOKEN is required. Create a token in Nametag under Settings > API Tokens.");
  const baseUrl = new URL(urlValue);
  if (!["http:", "https:"].includes(baseUrl.protocol)) throw new Error("NAMETAG_URL must use HTTP or HTTPS");
  baseUrl.pathname = baseUrl.pathname.replace(/\/$/, "");
  baseUrl.search = "";
  baseUrl.hash = "";

  return async function api(method, path, { query, body } = {}) {
    const prefix = baseUrl.pathname.replace(/\/+$/, "");
    const url = new URL(`${prefix}${path.startsWith("/") ? path : `/${path}`}`, baseUrl.origin);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, Array.isArray(value) ? value.join(",") : String(value));
      }
    }

    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      return { error: `Nametag request failed: ${error.message}` };
    }

    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { response: text };
    }

    if (!response.ok) {
      return { error: data?.error ?? `Nametag returned HTTP ${response.status}`, status: response.status, details: data?.details };
    }
    return data;
  };
}

export function registerNametagTools(server, api) {
const idSchema = z.string().min(1).describe("Nametag resource ID");
const jsonObject = z.record(z.string(), z.unknown()).describe("Nametag API JSON object");

function register(name, description, schema, handler) {
  server.tool(name, description, schema, async (args) => {
    const result = await handler(args);
    const isError = Boolean(result && typeof result === "object" && "error" in result);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], ...(isError ? { isError: true } : {}) };
  });
}

register("nametag_health", "Check whether the configured Nametag server is reachable.", {}, async () => api("GET", "/api/health"));

register("nametag_list_people", "List people in Nametag. Use include_all for an untruncated data export; otherwise page with limit and offset.", {
  limit: z.number().int().positive().max(500).optional(),
  offset: z.number().int().min(0).optional(),
  group_ids: z.array(z.string()).optional().describe("Filter to people in any of these group IDs"),
  include_details: z.boolean().optional(),
  include_all: z.boolean().optional(),
}, async ({ limit, offset, group_ids, include_details, include_all }) => api("GET", "/api/people", {
  query: { limit, offset, groupIds: group_ids, includeDetails: include_details, includeAll: include_all },
}));

register("nametag_search_people", "Search Nametag people by name, surname, middle name, second last name, or nickname.", {
  query: z.string().min(1).describe("Search text"),
}, async ({ query }) => api("GET", "/api/people/search", { query: { q: query } }));

register("nametag_get_person", "Get one person's full contact details, groups, important dates, and relationships.", { id: idSchema }, async ({ id }) => api("GET", `/api/people/${encodeURIComponent(id)}`));

register("nametag_create_person", "Create a person. This Nametag instance requires name and relationshipToUserId; get a valid relationship type ID with nametag_list_relationship_types. Array-valued fields supplied here are saved as provided.", {
  person: jsonObject.describe("Person fields, for example {name, relationshipToUserId, surname, notes, groupIds, phoneNumbers, emails, importantDates}"),
}, async ({ person }) => api("POST", "/api/people", { body: person }));

register("nametag_update_person", "Update a person. Only provided fields are changed. Supplying groupIds, importantDates, or a multi-value field replaces that entire field's set.", {
  id: idSchema,
  person: jsonObject.describe("Fields to update, e.g. {jobTitle: 'Mathematician'}"),
}, async ({ id, person }) => api("PUT", `/api/people/${encodeURIComponent(id)}`, { body: person }));

register("nametag_delete_person", "Soft-delete a person. This is reversible during Nametag's retention period.", {
  id: idSchema,
  delete_orphans: z.boolean().optional().describe("Also delete disconnected people (defaults to false)"),
  orphan_ids: z.array(z.string()).optional(),
  delete_from_carddav: z.boolean().optional(),
}, async ({ id, delete_orphans, orphan_ids, delete_from_carddav }) => api("DELETE", `/api/people/${encodeURIComponent(id)}`, {
  body: { deleteOrphans: delete_orphans, orphanIds: orphan_ids, deleteFromCardDav: delete_from_carddav },
}));

register("nametag_restore_person", "Restore a soft-deleted person.", { id: idSchema }, async ({ id }) => api("POST", `/api/people/${encodeURIComponent(id)}/restore`));

register("nametag_list_groups", "List Nametag groups and their members.", {}, async () => api("GET", "/api/groups"));
register("nametag_get_group", "Get a group and its member details.", { id: idSchema }, async ({ id }) => api("GET", `/api/groups/${encodeURIComponent(id)}`));
register("nametag_create_group", "Create a group. Fields include required name and optional description, color, and peopleIds.", { group: jsonObject }, async ({ group }) => api("POST", "/api/groups", { body: group }));
register("nametag_update_group", "Update a group. Fields include name, description, and color.", { id: idSchema, group: jsonObject }, async ({ id, group }) => api("PUT", `/api/groups/${encodeURIComponent(id)}`, { body: group }));
register("nametag_delete_group", "Soft-delete a group. Optionally also soft-delete all people in it.", {
  id: idSchema,
  delete_people: z.boolean().optional(),
}, async ({ id, delete_people }) => api("DELETE", `/api/groups/${encodeURIComponent(id)}`, { query: { deletePeople: delete_people } }));
register("nametag_restore_group", "Restore a soft-deleted group.", { id: idSchema }, async ({ id }) => api("POST", `/api/groups/${encodeURIComponent(id)}/restore`));
register("nametag_add_group_member", "Add a person to a group.", { group_id: idSchema, person_id: idSchema }, async ({ group_id, person_id }) => api("POST", `/api/groups/${encodeURIComponent(group_id)}/members`, { body: { personId: person_id } }));
register("nametag_remove_group_member", "Remove a person from a group.", { group_id: idSchema, person_id: idSchema }, async ({ group_id, person_id }) => api("DELETE", `/api/groups/${encodeURIComponent(group_id)}/members/${encodeURIComponent(person_id)}`));

register("nametag_list_relationships", "List person-to-person relationships in the Nametag network.", {}, async () => api("GET", "/api/relationships"));
register("nametag_create_relationship", "Connect two people. Nametag creates the inverse relationship automatically.", {
  person_id: idSchema,
  related_person_id: idSchema,
  relationship_type_id: z.string().nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
}, async ({ person_id, related_person_id, relationship_type_id, notes }) => api("POST", "/api/relationships", {
  body: { personId: person_id, relatedPersonId: related_person_id, relationshipTypeId: relationship_type_id, notes },
}));
register("nametag_update_relationship", "Update a relationship; this Nametag API requires relationship_type_id. The inverse is updated to match.", {
  id: idSchema,
  relationship_type_id: z.string().min(1).describe("Nametag relationship type ID; this API requires a type when updating"),
  notes: z.string().max(1000).nullable().optional(),
}, async ({ id, relationship_type_id, notes }) => api("PUT", `/api/relationships/${encodeURIComponent(id)}`, {
  body: { relationshipTypeId: relationship_type_id, notes },
}));
register("nametag_delete_relationship", "Soft-delete a relationship and its inverse.", { id: idSchema }, async ({ id }) => api("DELETE", `/api/relationships/${encodeURIComponent(id)}`));
register("nametag_restore_relationship", "Restore a soft-deleted relationship and its inverse.", { id: idSchema }, async ({ id }) => api("POST", `/api/relationships/${encodeURIComponent(id)}/restore`));
register("nametag_list_relationship_types", "List available relationship types and inverse-type definitions.", {}, async () => api("GET", "/api/relationship-types"));
register("nametag_create_relationship_type", "Create a relationship type. Use symmetric=true for a type whose inverse is itself, or provide inverseLabel to create an inverse type.", {
  relationship_type: jsonObject.describe("Type fields, e.g. {name: 'PARENT', label: 'Parent', inverseLabel: 'Child'}"),
}, async ({ relationship_type }) => api("POST", "/api/relationship-types", { body: relationship_type }));
register("nametag_update_relationship_type", "Update a relationship type's name, label, color, or inverse definition.", {
  id: idSchema,
  relationship_type: jsonObject,
}, async ({ id, relationship_type }) => api("PUT", `/api/relationship-types/${encodeURIComponent(id)}`, { body: relationship_type }));
register("nametag_delete_relationship_type", "Soft-delete a relationship type. Nametag rejects deletion while it is used by a relationship.", {
  id: idSchema,
}, async ({ id }) => api("DELETE", `/api/relationship-types/${encodeURIComponent(id)}`));
register("nametag_restore_relationship_type", "Restore a soft-deleted relationship type.", {
  id: idSchema,
}, async ({ id }) => api("POST", `/api/relationship-types/${encodeURIComponent(id)}/restore`));

register("nametag_list_journal", "List journal entries, newest first. The API returns 50 entries per page.", {
  page: z.number().int().positive().optional(),
  person_id: z.string().optional(),
  query: z.string().optional().describe("Search title and body text"),
}, async ({ page, person_id, query }) => api("GET", "/api/journal", { query: { page, person: person_id, q: query } }));
register("nametag_get_journal_entry", "Get a journal entry by ID.", { id: idSchema }, async ({ id }) => api("GET", `/api/journal/${encodeURIComponent(id)}`));
register("nametag_create_journal_entry", "Create a journal entry. Provide title, date, body, optional hasTime/personIds/updateLastContact.", { entry: jsonObject }, async ({ entry }) => api("POST", "/api/journal", { body: entry }));
register("nametag_update_journal_entry", "Update a journal entry. Provide the fields to change; Nametag's endpoint accepts the journal-entry JSON payload.", { id: idSchema, entry: jsonObject }, async ({ id, entry }) => api("PUT", `/api/journal/${encodeURIComponent(id)}`, { body: entry }));
register("nametag_delete_journal_entry", "Soft-delete a journal entry.", { id: idSchema }, async ({ id }) => api("DELETE", `/api/journal/${encodeURIComponent(id)}`));

register("nametag_dashboard_stats", "Get Nametag dashboard counts and summary statistics.", {}, async () => api("GET", "/api/dashboard/stats"));
register("nametag_dashboard_graph", "Get graph data. Optionally filter people by group, group match mode, or a people limit.", {
  include_group_ids: z.array(z.string()).optional(),
  exclude_group_ids: z.array(z.string()).optional(),
  group_match_operator: z.enum(["and", "or"]).optional(),
  limit: z.number().int().positive().optional(),
}, async ({ include_group_ids, exclude_group_ids, group_match_operator, limit }) => api("GET", "/api/dashboard/graph", {
  query: { includeGroupIds: include_group_ids, excludeGroupIds: exclude_group_ids, groupMatchOperator: group_match_operator, limit },
}));
register("nametag_map_markers", "Get people with mappable location data.", {}, async () => api("GET", "/api/map/markers"));

}

export function createNametagMcpServer(api) {
  const server = new McpServer({ name: "nametag", version: "0.2.0" });
  registerNametagTools(server, api);
  return server;
}
