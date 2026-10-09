/*
 * Publish commit: writes allowlisted content files to the GitHub Pages repo in
 * a single commit via the Git Data API (blobs → tree → commit → ref). The
 * single-file Contents API cannot make one commit across several paths, so the
 * Git Database endpoints are used instead — same fine-grained token scope
 * (contents: write on d6ewasupervisor-netizen/district6).
 *
 * Allowlist (enforced here):
 *   frontend/content/<pageKey>.json
 *   frontend/content/<pageKey>.css
 *   frontend/docs/<file>
 *   frontend/assets/uploads/<file>
 *
 * backend/** is intentionally never written here: Railway's watch path is
 * /backend/** so content-only commits must not rebuild the API image.
 */

const API = 'https://api.github.com';
const BRANCH = 'main';
const COMMIT_MESSAGE = 'Publish District 6 page content';

const ALLOWED_PREFIXES = [
  /^frontend\/content\/[a-z0-9-]+\.(json|css)$/,
  /^frontend\/content\/docs\/[a-z0-9-]+\.html$/,
  /^frontend\/docs\/[^/]+$/,
  /^frontend\/assets\/uploads\/[^/]+$/,
];

export function isGithubConfigured() {
  return Boolean(process.env.GITHUB_TOKEN && process.env.GITHUB_REPO);
}

function assertAllowlisted(path) {
  const normalized = String(path || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!ALLOWED_PREFIXES.some((re) => re.test(normalized))) {
    const err = new Error(`Path not allowed in content commits: ${path}`);
    err.status = 400;
    throw err;
  }
  return normalized;
}

async function githubApi(token, method, path, body, fetchImpl = fetch) {
  const res = await fetchImpl(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err = new Error(`GitHub API ${method} ${path} failed (${res.status}): ${detail.slice(0, 300)}`);
    err.status = 502;
    throw err;
  }
  return res.json();
}

/**
 * Commit content files in one commit.
 *
 * @param {Array<{ path: string, bytes: Buffer|string }>} files
 * @returns {Promise<{ committed: boolean, sha?: string, reason?: string }>}
 */
export async function commitContentFiles(files, { fetchImpl = fetch } = {}) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  if (!token || !repo) {
    return { committed: false, reason: 'GitHub token or repo not configured on the server.' };
  }
  const entries = (files || [])
    .filter((f) => f && f.path && f.bytes != null)
    .map((f) => ({ path: assertAllowlisted(f.path), bytes: f.bytes }));
  if (entries.length === 0) {
    return { committed: false, reason: 'No files to commit.' };
  }

  const repoPath = `/repos/${repo}`;

  // 1. Current branch head.
  const ref = await githubApi(token, 'GET', `${repoPath}/git/ref/heads/${BRANCH}`, null, fetchImpl);
  const baseSha = ref.object.sha;

  // 2. Base commit (for its tree).
  const baseCommit = await githubApi(token, 'GET', `${repoPath}/git/commits/${baseSha}`, null, fetchImpl);

  // 3. Blobs (base64 handles both text and binary payloads).
  const tree = [];
  for (const entry of entries) {
    const buf = Buffer.isBuffer(entry.bytes) ? entry.bytes : Buffer.from(String(entry.bytes), 'utf8');
    const blob = await githubApi(
      token,
      'POST',
      `${repoPath}/git/blobs`,
      { content: buf.toString('base64'), encoding: 'base64' },
      fetchImpl,
    );
    tree.push({ path: entry.path, mode: '100644', type: 'blob', sha: blob.sha });
  }

  // 4. Tree, 5. Commit, 6. Move the branch ref — exactly one commit lands.
  const newTree = await githubApi(
    token,
    'POST',
    `${repoPath}/git/trees`,
    { base_tree: baseCommit.tree.sha, tree },
    fetchImpl,
  );
  const commit = await githubApi(
    token,
    'POST',
    `${repoPath}/git/commits`,
    { message: COMMIT_MESSAGE, tree: newTree.sha, parents: [baseSha] },
    fetchImpl,
  );
  await githubApi(
    token,
    'PATCH',
    `${repoPath}/git/refs/heads/${BRANCH}`,
    { sha: commit.sha },
    fetchImpl,
  );
  return { committed: true, sha: commit.sha };
}