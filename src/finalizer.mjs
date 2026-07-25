import { parsePullRequest } from './pr-context.mjs';
import { verifyManifest } from './artifact-manifest.mjs';

export function canFinalize({ manifest, currentPullRequest, artifacts }) {
  const current = parsePullRequest(currentPullRequest);
  verifyManifest(manifest, current, artifacts);
  return { repository: current.repository, pullNumber: current.pullNumber, headOid: current.headOid };
}

export async function finalize({ fetchPullRequest, postComment, manifest, artifacts }) {
  const current = parsePullRequest(await fetchPullRequest());
  const target = canFinalize({ manifest, currentPullRequest: current, artifacts });
  await postComment(target, artifacts['review.md']);
  return target;
}
