#!/usr/bin/env node
/**
 * google-mcp — Gmail + Google Calendar + Google Chat + Google Drive MCP server
 *
 * Uses OAuth2 refresh tokens stored in a local config file.
 * No gcloud required. Works for any Google account.
 * Supports multiple accounts simultaneously.
 *
 * Setup: node setup.js
 * Config file: ~/.config/google-mcp/tokens.json  (override with GOOGLE_MCP_CONFIG env var)
 *
 * Token file format:
 * {
 *   "accounts": {
 *     "you@example.com": {
 *       "client_id": "...",
 *       "client_secret": "...",
 *       "refresh_token": "..."
 *     }
 *   }
 * }
 */

import { createInterface } from "readline";
import { request as httpsRequest } from "https";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ── Config ──────────────────────────────────────────────────────────────────

const CONFIG_PATH =
  process.env.GOOGLE_MCP_CONFIG ||
  join(homedir(), ".config", "google-mcp", "tokens.json");

const DEFAULT_ACCOUNT = process.env.GOOGLE_ACCOUNT || "";

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    throw new Error(
      `Cannot read token config at ${CONFIG_PATH}.\n` +
      `Run the setup wizard first: node setup.js\n` +
      `(original error: ${e.message})`
    );
  }
}

// ── Token cache (in-memory, per account) ────────────────────────────────────

const tokenCache = {}; // { email: { access_token, expires_at } }

async function getAccessToken(account) {
  let email = account || DEFAULT_ACCOUNT;

  // If no account specified, auto-select when exactly one is configured.
  if (!email) {
    const config = loadConfig();
    const emails = Object.keys(config.accounts || {});
    if (emails.length === 1) {
      email = emails[0];
    } else if (emails.length === 0) {
      throw new Error(
        `No accounts configured in ${CONFIG_PATH}. Run the setup wizard: node setup.js`
      );
    } else {
      throw new Error(
        `Multiple accounts configured (${emails.join(", ")}). ` +
        `Pass \`account\` in the tool call or set GOOGLE_ACCOUNT env var.`
      );
    }
  }

  const now = Date.now();
  const cached = tokenCache[email];
  if (cached && cached.expires_at > now + 60_000) {
    return cached.access_token;
  }

  const config = loadConfig();
  const acct = config.accounts?.[email];
  if (!acct) {
    throw new Error(
      `No credentials found for ${email} in ${CONFIG_PATH}.\n` +
      `Run the setup wizard: node setup.js`
    );
  }

  const { client_id, client_secret, refresh_token } = acct;
  const token = await refreshAccessToken(client_id, client_secret, refresh_token);
  tokenCache[email] = { access_token: token.access_token, expires_at: now + token.expires_in * 1000 };
  return token.access_token;
}

function refreshAccessToken(client_id, client_secret, refresh_token) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      client_id,
      client_secret,
      refresh_token,
      grant_type: "refresh_token",
    }).toString();

    const req = httpsRequest(
      {
        hostname: "oauth2.googleapis.com",
        path: "/token",
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(`Token refresh failed: ${parsed.error} — ${parsed.error_description}`));
          } else {
            resolve(parsed);
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

function handleApiResponse(res, data, resolve, reject) {
  let parsed;
  try { parsed = JSON.parse(data); } catch { parsed = { raw: data }; }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    const msg =
      parsed?.error?.message ||
      parsed?.error_description ||
      parsed?.raw ||
      `HTTP ${res.statusCode}`;
    return reject(new Error(`Google API ${res.statusCode}: ${msg}`));
  }
  if (parsed?.error) {
    return reject(new Error(
      `Google API error: ${parsed.error.message || JSON.stringify(parsed.error)}`
    ));
  }
  resolve(parsed);
}

// Raw (non-JSON) responses — Drive exports a Doc as text/plain, not JSON, so it
// needs its own error path rather than relying on handleApiResponse's fallback.
function handleRawResponse(res, data, resolve, reject) {
  if (res.statusCode < 200 || res.statusCode >= 300) {
    let msg = data;
    try { msg = JSON.parse(data)?.error?.message || data; } catch { /* keep raw body */ }
    return reject(new Error(`Google API ${res.statusCode}: ${msg}`));
  }
  resolve(data);
}

/**
 * One request primitive for every verb.
 *
 * opts.contentType — send `body` verbatim under this type (used by multipart
 *                    uploads); otherwise `body` is JSON-encoded.
 * opts.raw         — resolve with the response body as a string, unparsed.
 */
function apiRequest(method, token, host, path, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Authorization: `Bearer ${token}` };
    let payload = null;
    if (body !== undefined && body !== null) {
      if (opts.contentType) {
        payload = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
        headers["Content-Type"] = opts.contentType;
      } else {
        payload = Buffer.from(JSON.stringify(body), "utf8");
        headers["Content-Type"] = "application/json";
      }
      headers["Content-Length"] = payload.length;
    }
    const req = httpsRequest({ hostname: host, path, method, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () =>
        opts.raw
          ? handleRawResponse(res, data, resolve, reject)
          : handleApiResponse(res, data, resolve, reject)
      );
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const apiGet = (token, host, path) => apiRequest("GET", token, host, path);
const apiGetRaw = (token, host, path) => apiRequest("GET", token, host, path, null, { raw: true });
const apiPost = (token, host, path, body) => apiRequest("POST", token, host, path, body);
const apiPatch = (token, host, path, body) => apiRequest("PATCH", token, host, path, body);

// multipart/related upload: one JSON metadata part, one media part. Needed because
// the JSON path above cannot express Drive's upload protocol.
function apiUpload(method, token, path, metadata, media, mediaType) {
  const boundary = "gmcp" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`, "utf8"),
    Buffer.from(JSON.stringify(metadata), "utf8"),
    Buffer.from(`\r\n--${boundary}\r\nContent-Type: ${mediaType}\r\n\r\n`, "utf8"),
    Buffer.isBuffer(media) ? media : Buffer.from(media, "utf8"),
    Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
  ]);
  return apiRequest(method, token, "www.googleapis.com", path, payload, {
    contentType: `multipart/related; boundary=${boundary}`,
  });
}

// POST-bodied pagination (Drive Activity queries are POSTs, not GETs).
async function postListAll(token, host, path, body, key, limit, pageSize = 100) {
  const out = [];
  let pageToken = "";
  do {
    const page = await apiPost(token, host, path, {
      ...body, pageSize, ...(pageToken ? { pageToken } : {}),
    });
    out.push(...(page[key] || []));
    pageToken = page.nextPageToken || "";
  } while (pageToken && out.length < limit);
  return out.slice(0, limit);
}

// Generic pageToken/nextPageToken walker. Chat and Drive share this contract.
async function listAll(token, host, path, key, limit, pageSize = 100) {
  const out = [];
  let pageToken = "";
  do {
    const sep = path.includes("?") ? "&" : "?";
    const page = await apiGet(
      token,
      host,
      `${path}${sep}pageSize=${pageSize}` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "")
    );
    out.push(...(page[key] || []));
    pageToken = page.nextPageToken || "";
  } while (pageToken && out.length < limit);
  return out.slice(0, limit);
}

// ── Tool implementations ─────────────────────────────────────────────────────

async function gmailSearch({ q, maxResults = 20, account }) {
  const token = await getAccessToken(account);
  const params = new URLSearchParams({ q, maxResults });
  const list = await apiGet(token, "gmail.googleapis.com", `/gmail/v1/users/me/messages?${params}`);
  if (!list.messages) return { messages: [], total: 0 };

  const messages = await Promise.all(
    list.messages.map(async ({ id }) => {
      const msg = await apiGet(token, "gmail.googleapis.com", `/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`);
      const headers = {};
      (msg.payload?.headers || []).forEach(({ name, value }) => { headers[name] = value; });
      return {
        messageId: msg.id,
        threadId: msg.threadId,
        snippet: msg.snippet,
        headers,
        labelIds: msg.labelIds,
      };
    })
  );
  return { messages, total: list.resultSizeEstimate };
}

async function gmailRead({ messageId, account }) {
  const token = await getAccessToken(account);
  const msg = await apiGet(token, "gmail.googleapis.com", `/gmail/v1/users/me/messages/${messageId}?format=full`);
  const headers = {};
  (msg.payload?.headers || []).forEach(({ name, value }) => { headers[name] = value; });

  function extractBody(payload) {
    if (!payload) return "";
    if (payload.body?.data) return Buffer.from(payload.body.data, "base64").toString("utf8");
    if (payload.parts) {
      for (const part of payload.parts) {
        if (part.mimeType === "text/plain" && part.body?.data) {
          return Buffer.from(part.body.data, "base64").toString("utf8");
        }
      }
      for (const part of payload.parts) {
        const nested = extractBody(part);
        if (nested) return nested;
      }
    }
    return "";
  }

  return { messageId: msg.id, threadId: msg.threadId, headers, snippet: msg.snippet, body: extractBody(msg.payload), labelIds: msg.labelIds };
}

async function gmailCreateDraft({ to, subject, body, account }) {
  const token = await getAccessToken(account);
  const email = [`To: ${to}`, `Subject: ${subject}`, "Content-Type: text/plain; charset=utf-8", "", body].join("\r\n");
  const encoded = Buffer.from(email).toString("base64url");
  const result = await apiPost(token, "gmail.googleapis.com", "/gmail/v1/users/me/drafts", {
    message: { raw: encoded },
  });
  return { draftId: result.id, message: result.message };
}

async function calendarListEvents({ timeMin, timeMax, maxResults = 20, calendarId = "primary", account }) {
  const token = await getAccessToken(account);
  const params = new URLSearchParams({
    timeMin: timeMin || new Date().toISOString(),
    maxResults,
    singleEvents: "true",
    orderBy: "startTime",
  });
  if (timeMax) params.set("timeMax", timeMax);
  if (calendarId) params.set("calendarId", calendarId);
  return apiGet(token, "www.googleapis.com", `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`);
}

async function calendarGetEvent({ eventId, calendarId = "primary", account }) {
  const token = await getAccessToken(account);
  return apiGet(token, "www.googleapis.com", `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`);
}

// ── Google Chat ──────────────────────────────────────────────────────────────

const CHAT_HOST = "chat.googleapis.com";

// The Chat API drops some entries (membership events and similar) *after* applying
// pageSize, so a small page can come back empty while the space really does have
// messages — pageSize=1 returns 0 where pageSize=3 returns 2. Always page generously.
const CHAT_PAGE_SIZE = 100;

function chatListAll(token, path, key, limit) {
  return listAll(token, CHAT_HOST, path, key, limit, CHAT_PAGE_SIZE);
}

async function mapLimit(items, limit, fn) {
  const results = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

function spaceLabel(space) {
  if (space.displayName) return space.displayName;
  return space.spaceType === "DIRECT_MESSAGE" ? "(direct message)" : space.name;
}

async function chatMemberNames(token, spaceName) {
  const members = await chatListAll(token, `/v1/${spaceName}/members`, "memberships", 50);
  return members
    .map((m) => m.member?.displayName || m.member?.name)
    .filter(Boolean);
}

async function listChatMembers({ spaceId, maxResults = 100, account }) {
  const token = await getAccessToken(account);
  if (!spaceId) {
    throw new Error("spaceId is required, e.g. 'spaces/AAAA2EmISJo'. Use list_chat_spaces to find it.");
  }
  const space = spaceId.startsWith("spaces/") ? spaceId : `spaces/${spaceId}`;
  const members = await chatListAll(token, `/v1/${space}/members`, "memberships", maxResults);
  return {
    spaceId: space,
    total: members.length,
    members: members.map((m) => ({
      displayName: m.member?.displayName || null,
      userId: m.member?.name || null,
      type: m.member?.type,
      role: m.role,
      state: m.state,
    })),
  };
}

async function listChatSpaces({ spaceType, maxResults = 200, includeMembers = false, account }) {
  const token = await getAccessToken(account);
  const path = spaceType
    ? `/v1/spaces?filter=${encodeURIComponent(`spaceType = "${spaceType}"`)}`
    : "/v1/spaces";
  const spaces = await chatListAll(token, path, "spaces", maxResults);

  // DMs and group chats carry no displayName; resolve them from membership so a
  // brief can attribute them to people instead of printing "(direct message)".
  const resolved = new Map();
  if (includeMembers) {
    const unnamed = spaces.filter((sp) => !sp.displayName);
    const pairs = await mapLimit(unnamed, 5, async (sp) => {
      try { return [sp.name, await chatMemberNames(token, sp.name)]; }
      catch { return [sp.name, null]; }
    });
    for (const [name, names] of pairs) if (names && names.length) resolved.set(name, names);
  }

  return {
    total: spaces.length,
    spaces: spaces.map((sp) => ({
      spaceId: sp.name,
      displayName: resolved.has(sp.name)
        ? `${sp.spaceType === "DIRECT_MESSAGE" ? "DM" : "Group"}: ${resolved.get(sp.name).join(", ")}`
        : spaceLabel(sp),
      members: resolved.get(sp.name) || undefined,
      spaceType: sp.spaceType,
      lastActiveTime: sp.lastActiveTime,
      spaceUri: sp.spaceUri,
    })),
  };
}

/**
 * Searches Chat messages by listing spaces and filtering client-side.
 *
 * The Chat API does expose POST /v1/spaces/-/messages:search, but it returns zero
 * results for every well-formed query on this account (verified 2026-09-16 — a search
 * for "muted" returns nothing although a message reads "you are muted"), so it is
 * deliberately not used here.
 */
async function searchChatMessages({
  query,
  spaceId,
  sender,
  after,
  before,
  maxResults = 50,
  maxPerSpace = 200,
  maxSpaces = 100,
  account,
} = {}) {
  const token = await getAccessToken(account);

  for (const [label, value] of [["after", after], ["before", before]]) {
    if (value && Number.isNaN(Date.parse(value))) {
      throw new Error(`Invalid ${label} timestamp: ${value} (expected ISO 8601, e.g. 2026-09-01T00:00:00Z)`);
    }
  }

  let spaces;
  if (spaceId) {
    const name = spaceId.startsWith("spaces/") ? spaceId : `spaces/${spaceId}`;
    spaces = [await apiGet(token, CHAT_HOST, `/v1/${name}`)];
  } else {
    spaces = await chatListAll(token, "/v1/spaces", "spaces", maxSpaces);
  }

  const needle = query ? query.toLowerCase() : null;
  const senderNeedle = sender ? sender.toLowerCase() : null;
  const afterMs = after ? Date.parse(after) : null;
  const beforeMs = before ? Date.parse(before) : null;

  // The Chat API defaults to `create_time ASC`, so a capped fetch would return each
  // space's OLDEST messages and never see recent ones in busy spaces. Always pull newest
  // first. When there is no text/sender filter, the global newest N can only come from
  // each space's newest N, so we never need to read deeper than maxResults per space.
  const messagesPath = `/v1/SPACE/messages?orderBy=${encodeURIComponent("create_time DESC")}`;
  const depth = needle || senderNeedle ? maxPerSpace : Math.min(maxPerSpace, maxResults);

  const skipped = [];
  const perSpace = await mapLimit(spaces, 5, async (sp) => {
    let messages;
    try {
      messages = await chatListAll(token, messagesPath.replace("SPACE", sp.name), "messages", depth);
    } catch (e) {
      skipped.push({ spaceId: sp.name, displayName: spaceLabel(sp), reason: e.message });
      return [];
    }

    return messages
      .filter((m) => {
        const text = m.text || m.formattedText || "";
        if (needle && !text.toLowerCase().includes(needle)) return false;
        if (senderNeedle) {
          const who = `${m.sender?.name || ""} ${m.sender?.displayName || ""}`.toLowerCase();
          if (!who.includes(senderNeedle)) return false;
        }
        if (afterMs || beforeMs) {
          const t = Date.parse(m.createTime || "");
          if (Number.isNaN(t)) return false;
          if (afterMs && t < afterMs) return false;
          if (beforeMs && t >= beforeMs) return false;
        }
        return true;
      })
      .map((m) => ({
        messageId: m.name,
        spaceId: sp.name,
        space: spaceLabel(sp),
        sender: m.sender?.displayName || m.sender?.name,
        createTime: m.createTime,
        text: m.text || m.formattedText || "",
      }));
  });

  const matches = perSpace.flat();
  matches.sort((a, b) => (b.createTime || "").localeCompare(a.createTime || ""));

  const result = {
    total: matches.length,
    returned: Math.min(matches.length, maxResults),
    spacesSearched: spaces.length,
    messages: matches.slice(0, maxResults),
  };
  if (skipped.length) result.skippedSpaces = skipped;
  if (matches.length > maxResults) {
    result.note = `${matches.length} matches found; showing ${maxResults}. Raise maxResults or narrow with spaceId/after/before.`;
  }
  return result;
}

async function sendChatMessage({ spaceId, text, threadName, account } = {}) {
  if (!spaceId) throw new Error("spaceId is required, e.g. 'spaces/AAAA2EmISJo' — use list_chat_spaces to find it");
  if (!text || !text.trim()) throw new Error("text is required and cannot be empty");

  const token = await getAccessToken(account);
  const space = spaceId.startsWith("spaces/") ? spaceId : `spaces/${spaceId}`;

  const body = { text };
  let path = `/v1/${space}/messages`;
  if (threadName) {
    body.thread = { name: threadName.includes("/threads/") ? threadName : `${space}/threads/${threadName}` };
    path += "?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD";
  }

  const sent = await apiPost(token, CHAT_HOST, path, body);
  return {
    messageId: sent.name,
    spaceId: sent.space?.name || space,
    threadName: sent.thread?.name,
    createTime: sent.createTime,
    text: sent.text,
  };
}

// ── Google Drive ─────────────────────────────────────────────────────────────

const DRIVE_HOST = "www.googleapis.com";

const DRIVE_FILE_FIELDS =
  "id,name,mimeType,modifiedTime,createdTime,size,webViewLink,parents,trashed,driveId," +
  "owners(displayName,emailAddress),lastModifyingUser(displayName,emailAddress)";

// Without all of supportsAllDrives / includeItemsFromAllDrives / corpora=allDrives,
// Drive quietly returns My Drive only — no error, just missing shared-drive results.
function allDriveParams(params) {
  params.set("supportsAllDrives", "true");
  params.set("includeItemsFromAllDrives", "true");
  return params;
}

const GOOGLE_EXPORT_MIME = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

async function driveListFiles({ q, orderBy, maxResults = 100, corpora = "allDrives", fields, account }) {
  const token = await getAccessToken(account);
  const params = allDriveParams(new URLSearchParams({
    corpora,
    fields: `nextPageToken,files(${fields || DRIVE_FILE_FIELDS})`,
  }));
  if (q) params.set("q", q);
  // Drive rejects orderBy on cross-drive queries; only send it when scoped.
  if (orderBy && corpora !== "allDrives") params.set("orderBy", orderBy);
  const files = await listAll(
    token, DRIVE_HOST, `/drive/v3/files?${params}`, "files",
    maxResults, Math.min(maxResults, 100)
  );
  return { total: files.length, corpora, files };
}

async function driveGetChanges({ pageToken, maxResults = 200, includeRemoved = false, account }) {
  const token = await getAccessToken(account);

  if (!pageToken) {
    const start = await apiGet(
      token, DRIVE_HOST,
      "/drive/v3/changes/startPageToken?supportsAllDrives=true"
    );
    return {
      startPageToken: start.startPageToken,
      changes: [],
      note: "No pageToken was supplied, so no changes were fetched. Store this startPageToken and pass it as pageToken next time to receive everything that changed since now.",
    };
  }

  const out = [];
  let cursor = pageToken;
  let newStartPageToken = null;
  do {
    const params = allDriveParams(new URLSearchParams({
      pageToken: cursor,
      pageSize: "100",
      includeRemoved: String(includeRemoved),
      fields: `nextPageToken,newStartPageToken,changes(fileId,removed,time,changeType,driveId,file(${DRIVE_FILE_FIELDS}))`,
    }));
    const page = await apiGet(token, DRIVE_HOST, `/drive/v3/changes?${params}`);
    out.push(...(page.changes || []));
    newStartPageToken = page.newStartPageToken || newStartPageToken;
    cursor = page.nextPageToken || "";
  } while (cursor && out.length < maxResults);

  return {
    total: Math.min(out.length, maxResults),
    changes: out.slice(0, maxResults),
    newStartPageToken,
    nextPageToken: cursor || null,
    truncated: out.length > maxResults || Boolean(cursor),
  };
}

async function driveReadFile({ fileId, mimeType, maxChars = 200000, account }) {
  const token = await getAccessToken(account);
  if (!fileId) throw new Error("fileId is required");

  const metaFields = "id,name,mimeType,modifiedTime,webViewLink,lastModifyingUser(displayName,emailAddress)";
  const meta = await apiGet(
    token, DRIVE_HOST,
    `/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=${encodeURIComponent(metaFields)}`
  );

  let text;
  if ((meta.mimeType || "").startsWith("application/vnd.google-apps.")) {
    const exportMime = mimeType || GOOGLE_EXPORT_MIME[meta.mimeType];
    if (!exportMime) {
      throw new Error(
        `Cannot export ${meta.mimeType} as text. Pass mimeType explicitly, or open it: ${meta.webViewLink}`
      );
    }
    text = await apiGetRaw(
      token, DRIVE_HOST,
      `/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportMime)}`
    );
  } else {
    text = await apiGetRaw(
      token, DRIVE_HOST,
      `/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`
    );
  }

  const truncated = text.length > maxChars;
  return {
    fileId: meta.id,
    name: meta.name,
    mimeType: meta.mimeType,
    modifiedTime: meta.modifiedTime,
    lastModifyingUser: meta.lastModifyingUser,
    webViewLink: meta.webViewLink,
    chars: text.length,
    truncated,
    text: truncated ? text.slice(0, maxChars) : text,
  };
}

async function driveCreateFolder({ name, parentId, account }) {
  const token = await getAccessToken(account);
  if (!name) throw new Error("name is required");
  const body = { name, mimeType: "application/vnd.google-apps.folder" };
  if (parentId) body.parents = [parentId];
  const fields = encodeURIComponent("id,name,webViewLink,parents");
  const f = await apiPost(
    token, DRIVE_HOST,
    `/drive/v3/files?supportsAllDrives=true&fields=${fields}`,
    body
  );
  return { folderId: f.id, name: f.name, webViewLink: f.webViewLink, parents: f.parents };
}

async function driveUploadFile({ name, content, parentId, mimeType = "text/markdown", convertToDoc = false, account }) {
  const token = await getAccessToken(account);
  if (!name) throw new Error("name is required");
  if (content === undefined || content === null) throw new Error("content is required");

  const metadata = { name };
  if (parentId) metadata.parents = [parentId];
  // Setting the *target* mimeType to a Google type makes Drive convert the upload.
  if (convertToDoc) metadata.mimeType = "application/vnd.google-apps.document";

  const fields = encodeURIComponent("id,name,mimeType,webViewLink,parents");
  const f = await apiUpload(
    "POST", token,
    `/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=${fields}`,
    metadata, content, mimeType
  );
  return { fileId: f.id, name: f.name, mimeType: f.mimeType, webViewLink: f.webViewLink, parents: f.parents };
}

async function driveUpdateFile({ fileId, name, content, mimeType = "text/markdown", addParents, removeParents, account }) {
  const token = await getAccessToken(account);
  if (!fileId) throw new Error("fileId is required");

  const fields = encodeURIComponent("id,name,mimeType,webViewLink,parents,modifiedTime");
  let query = `?supportsAllDrives=true&fields=${fields}`;
  if (addParents) query += `&addParents=${encodeURIComponent(addParents)}`;
  if (removeParents) query += `&removeParents=${encodeURIComponent(removeParents)}`;

  let f;
  if (content === undefined || content === null) {
    const body = {};
    if (name) body.name = name;
    f = await apiPatch(token, DRIVE_HOST, `/drive/v3/files/${encodeURIComponent(fileId)}${query}`, body);
  } else {
    const metadata = {};
    if (name) metadata.name = name;
    f = await apiUpload(
      "PATCH", token,
      `/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=multipart&${query.slice(1)}`,
      metadata, content, mimeType
    );
  }
  return {
    fileId: f.id, name: f.name, mimeType: f.mimeType,
    webViewLink: f.webViewLink, modifiedTime: f.modifiedTime, parents: f.parents,
  };
}

// ── Drive comments (covered by drive.readonly — no extra scope) ─────────────

async function driveListComments({ fileId, includeResolved = false, maxResults = 100, account }) {
  const token = await getAccessToken(account);
  if (!fileId) throw new Error("fileId is required");
  const fields =
    "nextPageToken,comments(id,author(displayName,me),content,createdTime,modifiedTime," +
    "resolved,quotedFileContent(value),replies(id,author(displayName,me),content,createdTime))";
  const params = new URLSearchParams({ fields, includeDeleted: "false" });
  const comments = await listAll(
    token, DRIVE_HOST,
    `/drive/v3/files/${encodeURIComponent(fileId)}/comments?${params}`,
    "comments", maxResults, Math.min(maxResults, 100)
  );
  const kept = includeResolved ? comments : comments.filter((c) => !c.resolved);
  return { fileId, total: kept.length, includeResolved, comments: kept };
}

// ── Drive Activity ───────────────────────────────────────────────────────────

const ACTIVITY_HOST = "driveactivity.googleapis.com";

function activityActionName(detail) {
  if (!detail || typeof detail !== "object") return "unknown";
  return Object.keys(detail)[0] || "unknown";
}

function activityActors(actors) {
  return (actors || []).map((a) => {
    if (a.user?.knownUser?.personName) {
      return { personName: a.user.knownUser.personName, isCurrentUser: Boolean(a.user.knownUser.isCurrentUser) };
    }
    if (a.user?.deletedUser) return { personName: null, kind: "deletedUser" };
    if (a.user?.unknownUser) return { personName: null, kind: "unknownUser" };
    if (a.system) return { personName: null, kind: "system" };
    if (a.impersonation) return { personName: null, kind: "impersonation" };
    if (a.administrator) return { personName: null, kind: "administrator" };
    return { personName: null, kind: "unknown" };
  });
}

function activityTargets(targets) {
  return (targets || []).map((t) => ({
    title: t.driveItem?.title || t.fileComment?.parent?.title || t.drive?.title || null,
    fileId: (t.driveItem?.name || t.fileComment?.parent?.name || "").replace(/^items\//, "") || null,
    mimeType: t.driveItem?.mimeType || null,
    isComment: Boolean(t.fileComment),
  }));
}

async function driveGetActivity({ fileId, ancestorId = "root", since, maxResults = 100, account }) {
  const token = await getAccessToken(account);
  const body = { consolidationStrategy: { legacy: {} } };
  if (fileId) body.itemName = `items/${fileId}`;
  else body.ancestorName = `items/${ancestorId}`;
  if (since) body.filter = `time >= "${since}"`;

  const activities = await postListAll(
    token, ACTIVITY_HOST, "/v2/activity:query", body, "activities",
    maxResults, Math.min(maxResults, 100)
  );

  return {
    total: activities.length,
    scope: fileId ? `items/${fileId}` : `ancestor items/${ancestorId}`,
    activities: activities.map((a) => ({
      time: a.timestamp || a.timeRange?.endTime || null,
      action: activityActionName(a.primaryActionDetail),
      actors: activityActors(a.actors),
      targets: activityTargets(a.targets),
    })),
  };
}

// ── Workspace directory (People API) ────────────────────────────────────────

const PEOPLE_HOST = "people.googleapis.com";
const PEOPLE_READ_MASK = "names,emailAddresses,organizations,metadata";

function shapePerson(pn) {
  const org = (pn.organizations || [])[0] || {};
  return {
    personName: pn.resourceName,
    displayName: (pn.names || [])[0]?.displayName || null,
    emails: (pn.emailAddresses || []).map((e) => e.value),
    title: org.title || null,
    department: org.department || null,
  };
}

async function directoryLookupPeople({ personId, query, maxResults = 50, account }) {
  const token = await getAccessToken(account);

  if (personId) {
    const id = personId.startsWith("people/") ? personId : `people/${personId}`;
    const pn = await apiGet(
      token, PEOPLE_HOST,
      `/v1/${id}?personFields=${encodeURIComponent("names,emailAddresses,organizations")}`
    );
    return { total: 1, people: [shapePerson(pn)] };
  }

  const sources = "DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE";
  const path = query
    ? `/v1/people:searchDirectoryPeople?query=${encodeURIComponent(query)}&readMask=${PEOPLE_READ_MASK}&sources=${sources}`
    : `/v1/people:listDirectoryPeople?readMask=${PEOPLE_READ_MASK}&sources=${sources}`;
  const people = await listAll(token, PEOPLE_HOST, path, "people", maxResults, Math.min(maxResults, 100));
  return { total: people.length, people: people.map(shapePerson) };
}

// ── Google Meet ──────────────────────────────────────────────────────────────

const MEET_HOST = "meet.googleapis.com";

async function meetListConferenceRecords({ since, maxResults = 20, includeParticipants = true, account }) {
  const token = await getAccessToken(account);
  let path = "/v2/conferenceRecords";
  if (since) path += `?filter=${encodeURIComponent(`start_time >= "${since}"`)}`;
  const records = await listAll(token, MEET_HOST, path, "conferenceRecords", maxResults, Math.min(maxResults, 50));

  const shaped = await mapLimit(records, 5, async (r) => {
    const out = {
      conferenceRecord: r.name,
      conferenceRecordId: (r.name || "").replace(/^conferenceRecords\//, ""),
      startTime: r.startTime,
      endTime: r.endTime,
      space: r.space,
    };
    if (includeParticipants) {
      try {
        const ps = await listAll(token, MEET_HOST, `/v2/${r.name}/participants`, "participants", 100, 100);
        out.participants = ps.map((p) => ({
          displayName: p.signedinUser?.displayName || p.anonymousUser?.displayName || (p.phoneUser ? "(phone)" : null),
          userId: p.signedinUser?.user || null,
          earliestStartTime: p.earliestStartTime,
          latestEndTime: p.latestEndTime,
        }));
      } catch (e) { out.participantsError = e.message; }
    }
    return out;
  });

  return { total: shaped.length, conferenceRecords: shaped };
}

async function meetGetTranscript({ conferenceRecordId, maxEntries = 1500, account }) {
  const token = await getAccessToken(account);
  if (!conferenceRecordId) throw new Error("conferenceRecordId is required — get one from meet_list_conference_records");
  const rec = conferenceRecordId.startsWith("conferenceRecords/")
    ? conferenceRecordId
    : `conferenceRecords/${conferenceRecordId}`;

  const transcripts = await listAll(token, MEET_HOST, `/v2/${rec}/transcripts`, "transcripts", 10, 10);
  if (!transcripts.length) {
    return {
      conferenceRecord: rec, transcripts: [],
      note: "No transcript exists for this conference. Transcripts are only produced when transcription was turned on during the meeting.",
    };
  }

  const out = await mapLimit(transcripts, 2, async (t) => {
    const entries = await listAll(token, MEET_HOST, `/v2/${t.name}/entries`, "transcriptEntries", maxEntries, 100);
    return {
      transcript: t.name,
      state: t.state,
      startTime: t.startTime,
      endTime: t.endTime,
      docsDestination: t.docsDestination || null,
      entryCount: entries.length,
      entries: entries.map((e) => ({
        participant: e.participant,
        text: e.text,
        startTime: e.startTime,
        endTime: e.endTime,
      })),
    };
  });
  return { conferenceRecord: rec, transcripts: out };
}

// ── MCP protocol ─────────────────────────────────────────────────────────────

const ACCOUNT_PROP = {
  account: {
    type: "string",
    description: `Google account email (e.g. you@example.com). Overrides GOOGLE_ACCOUNT env var. Default: "${DEFAULT_ACCOUNT || "(none set)"}"`,
  },
};

const TOOLS = [
  {
    name: "gmail_search",
    description: "Search Gmail messages using standard Gmail search syntax",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Gmail search query (e.g. 'from:alice@example.com is:unread')" },
        maxResults: { type: "number", description: "Max results (default 20)" },
        ...ACCOUNT_PROP,
      },
      required: ["q"],
    },
  },
  {
    name: "gmail_read",
    description: "Read a full Gmail message by ID",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "Gmail message ID" },
        ...ACCOUNT_PROP,
      },
      required: ["messageId"],
    },
  },
  {
    name: "gmail_create_draft",
    description: "Create a Gmail draft email",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Email subject" },
        body: { type: "string", description: "Email body (plain text)" },
        ...ACCOUNT_PROP,
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "calendar_list_events",
    description: "List upcoming Google Calendar events",
    inputSchema: {
      type: "object",
      properties: {
        timeMin: { type: "string", description: "Start time (ISO 8601). Default: now" },
        timeMax: { type: "string", description: "End time (ISO 8601)" },
        maxResults: { type: "number", description: "Max events (default 20)" },
        calendarId: { type: "string", description: "Calendar ID (default: 'primary')" },
        ...ACCOUNT_PROP,
      },
    },
  },
  {
    name: "calendar_get_event",
    description: "Get full details of a Google Calendar event",
    inputSchema: {
      type: "object",
      properties: {
        eventId: { type: "string", description: "Calendar event ID" },
        calendarId: { type: "string", description: "Calendar ID (default: 'primary')" },
        ...ACCOUNT_PROP,
      },
      required: ["eventId"],
    },
  },
  {
    name: "list_chat_spaces",
    description: "List Google Chat spaces, group chats, and direct messages the user belongs to",
    inputSchema: {
      type: "object",
      properties: {
        spaceType: { type: "string", description: "Filter by type: SPACE, GROUP_CHAT, or DIRECT_MESSAGE. Default: all" },
        maxResults: { type: "number", description: "Max spaces to return (default 200)" },
        includeMembers: { type: "boolean", description: "Resolve DM and group-chat names from their membership, so they read as 'DM: Brad Zamft' instead of '(direct message)'. Costs one extra call per unnamed space (default false)" },
        ...ACCOUNT_PROP,
      },
    },
  },
  {
    name: "send_chat_message",
    description: "Post a message to a Google Chat space, group chat, or DM. This WRITES — the message is visible to everyone in the space and cannot be unsent by this tool.",
    inputSchema: {
      type: "object",
      properties: {
        spaceId: { type: "string", description: "Target space, e.g. 'spaces/AAAA2EmISJo'. Use list_chat_spaces to find it" },
        text: { type: "string", description: "Message text. Supports Chat's basic formatting (*bold*, _italic_, `code`)" },
        threadName: { type: "string", description: "Optional. Reply into an existing thread, e.g. 'spaces/AAAA2EmISJo/threads/xyz'. Falls back to a new thread if that thread is gone. Omit to start a new thread" },
        ...ACCOUNT_PROP,
      },
      required: ["spaceId", "text"],
    },
  },
  {
    name: "search_chat_messages",
    description: "Search or browse Google Chat messages across spaces, newest first. All filters are optional and combine (AND). Call it with NO arguments to get your most recent messages across every space — that is the way to answer 'what are my latest Chat messages?'. Add query to search text, or spaceId to scope to one conversation.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Case-insensitive substring to match in message text. Omit to browse recent messages rather than search" },
        spaceId: { type: "string", description: "Restrict to one space, e.g. 'spaces/AAAA2EmISJo'. Much faster than searching all spaces" },
        sender: { type: "string", description: "Case-insensitive substring of the sender's resource name, e.g. 'users/101858108561023185407'. The Chat API does not return sender display names under user auth, so names are not matchable" },
        after: { type: "string", description: "Only messages at or after this ISO 8601 time, e.g. 2026-09-01T00:00:00Z" },
        before: { type: "string", description: "Only messages strictly before this ISO 8601 time" },
        maxResults: { type: "number", description: "Max messages to return, newest first (default 50)" },
        maxPerSpace: { type: "number", description: "Max messages fetched per space before filtering, newest first (default 200). Raise it to search further back in busy spaces" },
        maxSpaces: { type: "number", description: "Max spaces to scan when spaceId is omitted (default 100)" },
        ...ACCOUNT_PROP,
      },
    },
  },
  {
    name: "drive_list_files",
    description: "List or search Google Drive files, including shared drives and files shared with the user. Use the Drive query language in `q`, e.g. \"name contains 'Notes'\", \"modifiedTime > '2026-09-01T00:00:00'\", \"'FOLDER_ID' in parents\", \"mimeType = 'application/vnd.google-apps.document'\". To find a specific known file prefer this over browsing. For 'what changed recently' use drive_get_changes instead — it is far cheaper.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Drive query string. Omit to list everything (newest pages first is NOT guaranteed across all drives)" },
        orderBy: { type: "string", description: "Sort order, e.g. 'modifiedTime desc'. Only applied when corpora is not 'allDrives' — Drive rejects sorting on cross-drive queries" },
        corpora: { type: "string", description: "'allDrives' (default: My Drive + shared-with-me + shared drives), or 'user' to scope to My Drive so orderBy works" },
        maxResults: { type: "number", description: "Max files to return (default 100)" },
        fields: { type: "string", description: "Override the per-file field selection. Default covers id, name, mimeType, times, owners, lastModifyingUser, webViewLink" },
        ...ACCOUNT_PROP,
      },
    },
  },
  {
    name: "drive_get_changes",
    description: "Get everything that changed in Drive since a previous point, using Drive's change feed. Call with NO pageToken to get a startPageToken (a watermark) — store it. Call again later passing that token to receive every file created, edited, renamed or trashed since. This is the right tool for a recurring digest; it is much cheaper and more complete than polling modifiedTime with drive_list_files.",
    inputSchema: {
      type: "object",
      properties: {
        pageToken: { type: "string", description: "Watermark from a previous call (its newStartPageToken, or the startPageToken from a no-arg call). Omit to obtain a fresh starting watermark" },
        maxResults: { type: "number", description: "Max changes to return (default 200)" },
        includeRemoved: { type: "boolean", description: "Include deleted/trashed files (default false)" },
        ...ACCOUNT_PROP,
      },
    },
  },
  {
    name: "drive_read_file",
    description: "Read a Drive file's contents as text. Google Docs, Sheets and Slides are exported (Docs and Slides to plain text, Sheets to CSV); other files are downloaded as-is. Use this to read meeting notes documents.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "Drive file ID" },
        mimeType: { type: "string", description: "Override the export format, e.g. 'text/html' or 'text/markdown' for a Google Doc" },
        maxChars: { type: "number", description: "Truncate the returned text at this many characters (default 200000). The response reports whether it was truncated" },
        ...ACCOUNT_PROP,
      },
      required: ["fileId"],
    },
  },
  {
    name: "drive_create_folder",
    description: "Create a folder in Google Drive. WRITES to Drive. Returns the folder ID to use as parentId for uploads.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Folder name" },
        parentId: { type: "string", description: "Parent folder ID. Omit to create in My Drive root" },
        ...ACCOUNT_PROP,
      },
      required: ["name"],
    },
  },
  {
    name: "drive_upload_file",
    description: "Create a new file in Google Drive from text content. WRITES to Drive. Set convertToDoc=true to have Drive convert markdown into a real Google Doc with headings, lists and links; leave it false to store the raw text file as-is.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "File name as it should appear in Drive" },
        content: { type: "string", description: "File contents (text)" },
        parentId: { type: "string", description: "Destination folder ID. Omit for My Drive root" },
        mimeType: { type: "string", description: "Source content type (default 'text/markdown'). Use 'text/html' for HTML, 'text/plain' for plain text" },
        convertToDoc: { type: "boolean", description: "Convert the upload into a native Google Doc (default false)" },
        ...ACCOUNT_PROP,
      },
      required: ["name", "content"],
    },
  },
  {
    name: "drive_update_file",
    description: "Update an existing Drive file in place, keeping its ID and URL stable. WRITES to Drive. Pass content to replace the body (markdown is converted when the target is a Google Doc), and/or name to rename. Only works on files this app created (drive.file scope).",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "Drive file ID to update" },
        content: { type: "string", description: "New contents. Omit to change metadata only" },
        name: { type: "string", description: "New name" },
        mimeType: { type: "string", description: "Source content type of `content` (default 'text/markdown')" },
        addParents: { type: "string", description: "Folder ID to move the file into" },
        removeParents: { type: "string", description: "Folder ID to move the file out of" },
        ...ACCOUNT_PROP,
      },
      required: ["fileId"],
    },
  },
  {
    name: "drive_list_comments",
    description: "List comment threads on a Drive file (Google Docs especially). Unresolved comments are the highest-signal 'someone is waiting on you' item inside a document. Returns unresolved comments by default, each with its author, the quoted text it is anchored to, and its replies.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "Drive file ID" },
        includeResolved: { type: "boolean", description: "Also return resolved threads (default false)" },
        maxResults: { type: "number", description: "Max comment threads (default 100)" },
        ...ACCOUNT_PROP,
      },
      required: ["fileId"],
    },
  },
  {
    name: "drive_get_activity",
    description: "Ask the Drive Activity API what actually happened to files: edited, commented, renamed, moved, created, deleted, shared or permission-changed, each with the actor who did it. Richer than drive_get_changes, which only reports that a file changed. Scope it to one file with fileId, or to a whole subtree with ancestorId (defaults to the My Drive root). Actors come back as people/<id> — resolve them with directory_lookup_people.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "Restrict to one file's activity" },
        ancestorId: { type: "string", description: "Folder ID whose subtree to report on (default 'root' = My Drive)" },
        since: { type: "string", description: "Only activity at or after this ISO 8601 time, e.g. 2026-09-15T00:00:00Z" },
        maxResults: { type: "number", description: "Max activity records (default 100)" },
        ...ACCOUNT_PROP,
      },
    },
  },
  {
    name: "directory_lookup_people",
    description: "Look up people in the Google Workspace directory — names, email addresses, job titles and departments. Three modes: pass personId to resolve a single 'people/<id>' (as returned by drive_get_activity actors), pass query to search by name or email, or pass neither to list the whole directory. Use it to join the same human across Chat, Calendar, Drive and other tools.",
    inputSchema: {
      type: "object",
      properties: {
        personId: { type: "string", description: "Resolve one person, e.g. 'people/101858108561023185407' or the bare ID" },
        query: { type: "string", description: "Search the directory by name or email" },
        maxResults: { type: "number", description: "Max people to return (default 50)" },
        ...ACCOUNT_PROP,
      },
    },
  },
  {
    name: "meet_list_conference_records",
    description: "List past Google Meet conferences, with who actually attended and for how long (as opposed to who was merely invited on the calendar). Use `since` to scope to a recent window.",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "string", description: "Only conferences starting at or after this ISO 8601 time" },
        maxResults: { type: "number", description: "Max conference records (default 20)" },
        includeParticipants: { type: "boolean", description: "Fetch the attendee list for each (default true)" },
        ...ACCOUNT_PROP,
      },
    },
  },
  {
    name: "meet_get_transcript",
    description: "Fetch the transcript of a past Meet conference, as timed entries per speaker. IMPORTANT: a transcript exists only if transcription was actually turned on for that meeting — otherwise this returns an empty list and says so, which is not an error.",
    inputSchema: {
      type: "object",
      properties: {
        conferenceRecordId: { type: "string", description: "From meet_list_conference_records, e.g. 'conferenceRecords/abc123' or the bare ID" },
        maxEntries: { type: "number", description: "Max transcript entries per transcript (default 1500)" },
        ...ACCOUNT_PROP,
      },
      required: ["conferenceRecordId"],
    },
  },
  {
    name: "list_chat_members",
    description: "List the members of a Google Chat space, group chat or DM. Use it to find out who a DM is actually with — DM spaces have no display name of their own.",
    inputSchema: {
      type: "object",
      properties: {
        spaceId: { type: "string", description: "Space to inspect, e.g. 'spaces/AAAA2EmISJo'" },
        maxResults: { type: "number", description: "Max members (default 100)" },
        ...ACCOUNT_PROP,
      },
      required: ["spaceId"],
    },
  },
];

const HANDLERS = {
  gmail_search: gmailSearch,
  gmail_read: gmailRead,
  gmail_create_draft: gmailCreateDraft,
  calendar_list_events: calendarListEvents,
  calendar_get_event: calendarGetEvent,
  list_chat_spaces: listChatSpaces,
  search_chat_messages: searchChatMessages,
  send_chat_message: sendChatMessage,
  drive_list_files: driveListFiles,
  drive_get_changes: driveGetChanges,
  drive_read_file: driveReadFile,
  drive_create_folder: driveCreateFolder,
  drive_upload_file: driveUploadFile,
  drive_update_file: driveUpdateFile,
  drive_list_comments: driveListComments,
  drive_get_activity: driveGetActivity,
  directory_lookup_people: directoryLookupPeople,
  meet_list_conference_records: meetListConferenceRecords,
  meet_get_transcript: meetGetTranscript,
  list_chat_members: listChatMembers,
};

const rl = createInterface({ input: process.stdin, terminal: false });

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

rl.on("line", async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "google-mcp", version: "2.0.0" } } });
    return;
  }

  if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
    return;
  }

  if (msg.method === "tools/call") {
    const { name, arguments: args } = msg.params;
    const handler = HANDLERS[name];
    if (!handler) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Unknown tool: ${name}` } });
      return;
    }
    try {
      const result = await handler(args || {});
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } });
    } catch (e) {
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true } });
    }
    return;
  }

  if (msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
  }
});
