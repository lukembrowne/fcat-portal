/**
 * Quick diagnostic: test Google Drive API access for a specific folder.
 * Usage: node scripts/test-drive.mjs <folder-id>
 *
 * If no folder ID given, uses the first driveFolderLink from the schedule.
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { google } from "googleapis";

const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
if (!raw) {
  console.error("GOOGLE_SERVICE_ACCOUNT_KEY not set");
  process.exit(1);
}

const key = JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
console.log("Service account:", key.client_email);
console.log("Project:", key.project_id);

const auth = new google.auth.GoogleAuth({
  credentials: key,
  scopes: ["https://www.googleapis.com/auth/drive.readonly"],
});

const drive = google.drive({ version: "v3", auth });

const folderId = process.argv[2];
if (!folderId) {
  console.error("\nUsage: node scripts/test-drive.mjs <folder-id>");
  console.error("Grab a folder ID from the logs, e.g.: 107tSCbHE5TbDSJcMnkCLLHRBAsgGDD3u");
  process.exit(1);
}

console.log(`\n--- Testing folder: ${folderId} ---\n`);

// Test 1: Can we see the folder itself?
console.log("1. Getting folder metadata...");
try {
  const meta = await drive.files.get({
    fileId: folderId,
    fields: "id, name, mimeType, owners, shared, permissions",
    supportsAllDrives: true,
  });
  console.log("   Name:", meta.data.name);
  console.log("   Type:", meta.data.mimeType);
  console.log("   Shared:", meta.data.shared);
} catch (err) {
  console.error("   FAILED:", err.message);
  if (err.code === 404) {
    console.error("   → 404: The service account cannot see this folder at all.");
    console.error("   → Make sure the folder (or a parent) is shared with:", key.client_email);
  }
  process.exit(1);
}

// Test 2: List ALL children (not just folders)
console.log("\n2. Listing ALL children (no mimeType filter)...");
try {
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: "files(id, name, mimeType)",
    pageSize: 50,
  });
  const files = res.data.files ?? [];
  console.log(`   Found ${files.length} items:`);
  for (const f of files) {
    console.log(`   - ${f.name} (${f.mimeType})`);
  }
} catch (err) {
  console.error("   FAILED:", err.message);
}

// Test 3: List only folders (what the app does)
console.log("\n3. Listing folders only (what the app does)...");
try {
  const res = await drive.files.list({
    q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: "files(id, name)",
    pageSize: 20,
  });
  const folders = res.data.files ?? [];
  console.log(`   Found ${folders.length} folders:`);
  for (const f of folders) {
    console.log(`   - ${f.name} (${f.id})`);
  }
} catch (err) {
  console.error("   FAILED:", err.message);
}

// Test 4: Check if we need supportsAllDrives (Shared Drives)
console.log("\n4. Trying with supportsAllDrives=true (for Shared Drives)...");
try {
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: "files(id, name, mimeType)",
    pageSize: 50,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const files = res.data.files ?? [];
  console.log(`   Found ${files.length} items:`);
  for (const f of files) {
    console.log(`   - ${f.name} (${f.mimeType})`);
  }
} catch (err) {
  console.error("   FAILED:", err.message);
}
