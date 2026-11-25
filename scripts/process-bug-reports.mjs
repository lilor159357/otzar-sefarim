#!/usr/bin/env node
/**
 * Otzar Sefarim - Autonomous Bug Reports Processor
 * Runs inside GitHub Actions on schedule / workflow_dispatch.
 * 
 * 1. Checks FIREBASE_SERVICE_ACCOUNT_JSON and GITHUB_TOKEN.
 * 2. Connects to Firestore REST API via Google OAuth2 service account JWT.
 * 3. Pulls open reports from 'bug_reports' collection.
 * 4. Creates GitHub Issues in lilor159357/otzar-sefarim with labels ['bug', 'user-report'].
 * 5. Marks documents in Firestore as status: 'processed' with github_issue_url.
 */

import crypto from 'node:crypto';

const rawSaJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
const githubToken = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
const repoOwner = process.env.GITHUB_REPOSITORY_OWNER || 'lilor159357';
const repoName = process.env.GITHUB_REPOSITORY?.split('/')[1] || 'otzar-sefarim';

if (!rawSaJson) {
  console.log('[process-bug-reports] Notice: FIREBASE_SERVICE_ACCOUNT_JSON is not configured.');
  process.exit(0);
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(rawSaJson);
  if (!serviceAccount.client_email || !serviceAccount.private_key || !serviceAccount.project_id) {
    throw new Error('Service account JSON must contain client_email, private_key, and project_id');
  }
} catch (err) {
  console.warn('[process-bug-reports] Warning: Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON:', err.message);
  process.exit(0);
}

function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function getGoogleAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const dataToSign = `${encodedHeader}.${encodedPayload}`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(dataToSign);
  const signature = signer.sign(sa.private_key);
  const jwt = `${dataToSign}.${base64url(signature)}`;

  const fence = '```';
  const body = [
    '## 🐞 דיווח תקלה חדש מאפליקציית אוצר ספרים',
    '',
    `**פלטפורמה:** ${report.platform}`,
    `**גרסת אפליקציה:** ${report.app_version}`,
    `**קטגוריה:** ${report.category}`,
    `**משתמש מדווח:** ${report.user_email}`,
    `**זמן דיווח:** ${report.created_at}`,
    '',
    '---',
    '',
    '### 📝 פירוט התקלה:',
    report.description || 'לא סופק תיאור',
    '',
    '---',
    '',
    '### 💻 פרטי מערכת ואבחון:',
    `${fence}json`,
    report.diagnostics || 'לא צורפו נתוני אבחון',
    fence,
    '',
    '> *הודעה זו נוצרה אוטומטית ממערכת דיווח התקלות של אוצר ספרים.*',
  ].join('\n');

  const url = `https://api.github.com/repos/${repoOwner}/${repoName}/issues`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'OtzarSefarim-BugBot',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: issueTitle,
      body,
      labels: ['bug', 'user-report'],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub create issue failed (${res.status}): ${text}`);
  }

  return await res.json();
}

async function main() {
  console.log('[process-bug-reports] Starting bug reports processor...');
  const accessToken = await getGoogleAccessToken(serviceAccount);
  const reports = await fetchOpenBugReports(serviceAccount.project_id, accessToken);

  console.log(`[process-bug-reports] Found ${reports.length} open bug reports.`);
  if (reports.length === 0) {
    console.log('[process-bug-reports] No open reports to process.');
    return;
  }

  for (const report of reports) {
    console.log(`[process-bug-reports] Processing report ${report.docId}: ${report.title}`);
    try {
      const issue = await createGitHubIssue(report);
      if (issue && issue.html_url) {
        console.log(`[process-bug-reports] Issue #${issue.number} created: ${issue.html_url}`);
        await markBugReportProcessed(
          serviceAccount.project_id,
          accessToken,
          report.docId,
          issue.html_url,
          issue.number
        );
      }
    } catch (err) {
      console.error(`[process-bug-reports] Error creating issue for ${report.docId}:`, err.message);
    }
  }

  console.log('[process-bug-reports] Finished processing bug reports.');
}

main().catch((err) => {
  console.error('[process-bug-reports] Fatal error:', err);
  process.exit(1);
});
