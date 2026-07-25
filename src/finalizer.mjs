import { parsePullRequest } from './pr-context.mjs';
import { verifyManifest } from './artifact-manifest.mjs';

export function canFinalize({ manifest, currentPullRequest, artifacts, binding }) {
  const current = parsePullRequest(currentPullRequest);
  verifyManifest(manifest, current, artifacts, binding);
  return { repository: current.repository, pullNumber: current.pullNumber, headOid: current.headOid };
}

export async function finalize({ fetchPullRequest, postComment, manifest, artifacts, binding }) {
  const current = parsePullRequest(await fetchPullRequest());
  const target = canFinalize({ manifest, currentPullRequest: current, artifacts, binding });
  await postComment(target, artifacts['review.md']);
  return target;
}
