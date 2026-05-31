const path = require('path');
const { Octokit } = require('@octokit/rest');

function githubUploadConfigured() {
  return !!(
    process.env.GITHUB_TOKEN &&
    process.env.GITHUB_REPO &&
    process.env.GITHUB_BRANCH
  );
}

/**
 * Upload a file buffer to the repo under public/uploads/ (same pattern as products/categories).
 */
async function uploadBufferToGitHub(buffer, repoRelativePath) {
  if (!githubUploadConfigured()) {
    throw new Error('GitHub upload is not configured (GITHUB_TOKEN, GITHUB_REPO, GITHUB_BRANCH)');
  }

  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  const [owner, repo] = process.env.GITHUB_REPO.split('/');
  const branch = process.env.GITHUB_BRANCH;
  const filePath = repoRelativePath.replace(/^\/+/, '');

  const { data } = await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: filePath,
    message: `Upload ${path.basename(filePath)}`,
    content: buffer.toString('base64'),
    branch,
  });

  if (data?.content?.download_url) {
    return data.content.download_url;
  }

  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`;
}

module.exports = {
  githubUploadConfigured,
  uploadBufferToGitHub,
};
