import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

// Test factory: mirrors production schema in server/index.mjs (Task 1).
// Reused by Task 2+ tests and T3/T4.
export function makeAuthzDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE platform_users (id TEXT PRIMARY KEY, username TEXT UNIQUE, role TEXT DEFAULT 'user', disabled INTEGER DEFAULT 0, createdAt INTEGER)`)
  db.exec(`CREATE TABLE clusters (id TEXT PRIMARY KEY, name TEXT UNIQUE, apiServer TEXT NOT NULL, nsAuthMode TEXT DEFAULT 'open')`)
  db.exec(`CREATE TABLE user_clusters (userId TEXT, clusterId TEXT, PRIMARY KEY(userId,clusterId))`)
  db.exec(`CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, createdAt INTEGER NOT NULL, createdBy TEXT)`)
  db.exec(`CREATE TABLE group_members (groupId TEXT NOT NULL, userId TEXT NOT NULL, addedBy TEXT, createdAt INTEGER NOT NULL, PRIMARY KEY(groupId,userId))`)
  db.exec(`CREATE TABLE ns_grants (id TEXT PRIMARY KEY, subjectType TEXT NOT NULL, subjectId TEXT NOT NULL, clusterId TEXT NOT NULL, namespace TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'view', grantedBy TEXT, grantedAt INTEGER NOT NULL, UNIQUE(subjectType,subjectId,clusterId,namespace))`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(userId)`)
  return db
}

test('schema:唯一约束生效(重复成员/重复授权均抛)', () => {
  const db = makeAuthzDb()
  db.prepare("INSERT INTO groups VALUES ('g1','grp-a',1,'root')").run()
  db.prepare("INSERT INTO group_members VALUES ('g1','u1',null,1)").run()
  assert.throws(() => db.prepare("INSERT INTO group_members VALUES ('g1','u1',null,2)").run())
  db.prepare("INSERT INTO ns_grants VALUES ('n1','group','g1','c1','team-a','view',null,1)").run()
  assert.throws(() => db.prepare("INSERT INTO ns_grants VALUES ('n2','group','g1','c1','team-a','operate',null,2)").run())
})
