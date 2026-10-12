-- ============================================================================
-- Trip Tracker schema (Better Auth)
-- ============================================================================
-- Better Auth's core tables use camelCase columns and quoted identifiers,
-- exactly as Better Auth's `npx @better-auth/cli generate` produces for
-- PostgreSQL. The rest of the app's tables (groups, group_members, messages)
-- reference `"user"(id)`.
-- ============================================================================

-- Better Auth: user
CREATE TABLE IF NOT EXISTS "user" (
  "id"            text PRIMARY KEY NOT NULL,
  "name"          text NOT NULL,
  "email"         text NOT NULL,
  "emailVerified" boolean NOT NULL,
  "image"         text,
  "avatarUrl"     text,
  "createdAt"     timestamptz NOT NULL,
  "updatedAt"     timestamptz NOT NULL,
  CONSTRAINT "user_email_unique" UNIQUE ("email")
);

-- Better Auth: session
CREATE TABLE IF NOT EXISTS "session" (
  "id"        text PRIMARY KEY NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "token"     text NOT NULL,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "userId"    text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  CONSTRAINT "session_token_unique" UNIQUE ("token")
);

-- Better Auth: account (password for the "credential" provider lives here)
CREATE TABLE IF NOT EXISTS "account" (
  "id"                    text PRIMARY KEY NOT NULL,
  "accountId"             text NOT NULL,
  "providerId"            text NOT NULL,
  "userId"                text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "accessToken"           text,
  "refreshToken"          text,
  "idToken"               text,
  "accessTokenExpiresAt"  timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  "scope"                 text,
  "password"              text,
  "createdAt"             timestamptz NOT NULL,
  "updatedAt"             timestamptz NOT NULL
);

-- Better Auth: verification
CREATE TABLE IF NOT EXISTS "verification" (
  "id"         text PRIMARY KEY NOT NULL,
  "identifier" text NOT NULL,
  "value"      text NOT NULL,
  "expiresAt"  timestamptz NOT NULL,
  "createdAt"  timestamptz,
  "updatedAt"  timestamptz
);

-- Groups (a trip group owned by its creator)
CREATE TABLE IF NOT EXISTS groups (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(150) NOT NULL,
  invite_code TEXT UNIQUE NOT NULL,
  created_by  text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_groups_created_by ON groups (created_by);
CREATE INDEX IF NOT EXISTS idx_groups_invite_code ON groups (invite_code);

-- Membership join table (roles: 'admin' | 'member')
CREATE TABLE IF NOT EXISTS group_members (
  group_id  INTEGER NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
  user_id   text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  role      VARCHAR(20) NOT NULL DEFAULT 'member',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (group_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members (user_id);

-- Chat messages exchanged inside a group
CREATE TABLE IF NOT EXISTS messages (
  id         SERIAL PRIMARY KEY,
  group_id   INTEGER NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
  user_id    text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  message    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_group ON messages (group_id, created_at);

-- Trip expenses, split equally among group members
CREATE TABLE IF NOT EXISTS expenses (
  id          SERIAL PRIMARY KEY,
  group_id    INTEGER NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
  paid_by     text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  amount      NUMERIC(12, 2) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_expenses_group ON expenses (group_id, created_at);

-- Trip "stories": short-lived photos a member shares with their group.
-- `media` holds a data URL (image/jpeg;base64,...) so no object storage is
-- needed for this project; stories stop being active once `expires_at` passes.
CREATE TABLE IF NOT EXISTS stories (
  id         SERIAL PRIMARY KEY,
  user_id    text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  group_id   INTEGER REFERENCES groups (id) ON DELETE CASCADE,
  media      TEXT NOT NULL,
  caption    TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stories_user_active ON stories (user_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_stories_group ON stories (group_id, expires_at);

-- One-to-one ("direct") messages between two members.
CREATE TABLE IF NOT EXISTS direct_messages (
  id         SERIAL PRIMARY KEY,
  from_user  text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  to_user    text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  message    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_dm_conversation
  ON direct_messages (from_user, to_user, created_at);
CREATE INDEX IF NOT EXISTS idx_dm_inbox ON direct_messages (to_user, created_at);

-- ============================================================================
-- Migration 2 — advanced groups, media chat, voice calls, story privacy
-- All statements are idempotent (IF NOT EXISTS / DROP NOT NULL) and safe to
-- re-run via `npm run migrate`.
-- ============================================================================

-- ---------------------------------------------------------------- groups
-- A cryptographically unique token powers the invite link + QR code
-- (the short `invite_code` stays for manual entry).
ALTER TABLE groups ADD COLUMN IF NOT EXISTS invite_token TEXT;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS invite_enabled BOOLEAN NOT NULL DEFAULT TRUE;
CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_invite_token ON groups (invite_token);

-- --------------------------------------------------------------- messages
-- Image / voice-note attachments (data URL) on group chat messages.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_type VARCHAR(16);   -- 'image' | 'audio'
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_data TEXT;          -- data URL
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_mime TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_name TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS duration_seconds NUMERIC(7, 2); -- voice-note length

-- Same attachments on direct messages.
ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS attachment_type VARCHAR(16);
ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS attachment_data TEXT;
ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS attachment_mime TEXT;
ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS attachment_name TEXT;
ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS duration_seconds NUMERIC(7, 2);

-- ---------------------------------------------------------------- stories
-- Richer stories: text posts, videos, privacy tiers and view-once.
ALTER TABLE stories ADD COLUMN IF NOT EXISTS media_type VARCHAR(16) NOT NULL DEFAULT 'image'; -- image|video|text
ALTER TABLE stories ADD COLUMN IF NOT EXISTS text_content TEXT;
ALTER TABLE stories ADD COLUMN IF NOT EXISTS privacy VARCHAR(16) NOT NULL DEFAULT 'group';    -- group|global|selected
ALTER TABLE stories ADD COLUMN IF NOT EXISTS view_once BOOLEAN NOT NULL DEFAULT FALSE;
-- Text-only stories have no media.
ALTER TABLE stories ALTER COLUMN media DROP NOT NULL;

-- "Selected people" audience for a story.
CREATE TABLE IF NOT EXISTS story_audience (
  story_id INTEGER NOT NULL REFERENCES stories (id) ON DELETE CASCADE,
  user_id  TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  PRIMARY KEY (story_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_story_audience_user ON story_audience (user_id);

-- Who has viewed a story — drives the view-once rule.
CREATE TABLE IF NOT EXISTS story_views (
  story_id  INTEGER NOT NULL REFERENCES stories (id) ON DELETE CASCADE,
  viewer_id TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (story_id, viewer_id)
);
CREATE INDEX IF NOT EXISTS idx_story_views_story ON story_views (story_id);

-- ============================================================================
-- Migration 3 — safety features
-- ============================================================================

-- Dynamic geofenced safe zone (one per group). The centre follows the admin
-- who set it; all members get boundary-breach alerts.
CREATE TABLE IF NOT EXISTS group_safe_zones (
  group_id      INTEGER PRIMARY KEY REFERENCES groups (id) ON DELETE CASCADE,
  radius_m      NUMERIC(10, 2) NOT NULL DEFAULT 500,
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  owner_user_id text REFERENCES "user" (id) ON DELETE SET NULL,
  center_lat    DOUBLE PRECISION,
  center_lng    DOUBLE PRECISION,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- Migration 4 — member profiles + real-world expenses
-- ============================================================================

-- Profile extras on the Better Auth user table.
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS social TEXT;

-- Richer expenses: category, split strategy, currency and a note.
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS category VARCHAR(32) NOT NULL DEFAULT 'other';
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS split_type VARCHAR(16) NOT NULL DEFAULT 'equal';
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS currency VARCHAR(8) NOT NULL DEFAULT 'USD';
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS note TEXT;

-- Per-person share of an expense (enables custom / payer-only splitting).
CREATE TABLE IF NOT EXISTS expense_shares (
  expense_id   INTEGER NOT NULL REFERENCES expenses (id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  share_amount NUMERIC(12, 2) NOT NULL,
  PRIMARY KEY (expense_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_expense_shares_user ON expense_shares (user_id);