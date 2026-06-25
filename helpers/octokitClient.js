/** Lazy-load @octokit/rest (ESM-only v22+) from CommonJS callers. */
let octokitInstance = null;
let octokitLoadPromise = null;

async function getOctokit() {
  if (octokitInstance) return octokitInstance;

  if (!octokitLoadPromise) {
    octokitLoadPromise = import('@octokit/rest').then(({ Octokit }) => {
      octokitInstance = new Octokit({ auth: process.env.GITHUB_TOKEN });
      return octokitInstance;
    });
  }

  return octokitLoadPromise;
}

module.exports = { getOctokit };
