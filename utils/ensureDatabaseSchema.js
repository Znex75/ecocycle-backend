const path = require('path');
const Database = require('better-sqlite3');

function resolveSqlitePath(databaseUrl) {
  const url = databaseUrl || 'file:./dev.db';
  if (!url.startsWith('file:')) {
    throw new Error(`Only SQLite file: DATABASE_URL values are supported, got: ${url}`);
  }

  const filePath = url.slice('file:'.length);
  return path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);
}

function hasColumn(db, tableName, columnName) {
  return db.prepare(`PRAGMA table_info("${tableName}")`)
    .all()
    .some((column) => column.name === columnName);
}

function addColumnIfMissing(db, tableName, columnName, definition) {
  if (!hasColumn(db, tableName, columnName)) {
    db.prepare(`ALTER TABLE "${tableName}" ADD COLUMN ${definition}`).run();
    console.log(`Added missing column ${tableName}.${columnName}`);
  }
}

function ensureDatabaseSchema() {
  const dbPath = resolveSqlitePath(process.env.DATABASE_URL);
  const db = new Database(dbPath);

  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS "User" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" TEXT NOT NULL,
      "email" TEXT NOT NULL,
      "xpPoints" INTEGER NOT NULL DEFAULT 0,
      "co2Saved" REAL NOT NULL DEFAULT 0.0,
      "ecoCoins" INTEGER NOT NULL DEFAULT 100,
      "scanCredits" INTEGER NOT NULL DEFAULT 25,
      "marketCredits" INTEGER NOT NULL DEFAULT 5,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE UNIQUE INDEX IF NOT EXISTS "User_email_key" ON "User"("email");

    CREATE TABLE IF NOT EXISTS "Scan" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "type" TEXT NOT NULL,
      "binCategory" TEXT NOT NULL,
      "xpReward" INTEGER NOT NULL,
      "co2Saved" REAL NOT NULL,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "userId" TEXT NOT NULL,
      CONSTRAINT "Scan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
    );

    CREATE TABLE IF NOT EXISTS "Listing" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "title" TEXT NOT NULL,
      "description" TEXT NOT NULL,
      "price" INTEGER NOT NULL DEFAULT 1,
      "category" TEXT NOT NULL DEFAULT 'Other',
      "image" TEXT NOT NULL DEFAULT '',
      "status" TEXT NOT NULL DEFAULT 'active',
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "sellerId" TEXT NOT NULL,
      "buyerId" TEXT,
      CONSTRAINT "Listing_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
      CONSTRAINT "Listing_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
    );

    CREATE TABLE IF NOT EXISTS "Transaction" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "type" TEXT NOT NULL,
      "amount" INTEGER NOT NULL,
      "description" TEXT NOT NULL,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "fromUserId" TEXT,
      "toUserId" TEXT,
      "listingId" TEXT,
      CONSTRAINT "Transaction_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
      CONSTRAINT "Transaction_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
    );
  `);

  addColumnIfMissing(db, 'User', 'ecoCoins', '"ecoCoins" INTEGER NOT NULL DEFAULT 100');
  addColumnIfMissing(db, 'User', 'scanCredits', '"scanCredits" INTEGER NOT NULL DEFAULT 25');
  addColumnIfMissing(db, 'User', 'marketCredits', '"marketCredits" INTEGER NOT NULL DEFAULT 5');
  addColumnIfMissing(db, 'Listing', 'status', '"status" TEXT NOT NULL DEFAULT \'active\'');
  addColumnIfMissing(db, 'Listing', 'buyerId', '"buyerId" TEXT');

  db.close();
}

module.exports = ensureDatabaseSchema;
