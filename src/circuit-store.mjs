const EVENT_MARKER = 'central-review-circuit';
export const STATE_MARKER = '<!-- central-review-circuit-state:v1 -->';
export const STATE_TITLE = '[automation] Central review infrastructure circuit state';
const BOT_LOGIN = 'github-actions[bot]';

function canonicalTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function markerPayload(body, marker = EVENT_MARKER) {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<!--\\s*${escaped}\\s+([^]*?)-->`).exec(String(body ?? ''));
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

export function normalizeCircuitEvent(value) {
  const runId = String(value?.run_id ?? '');
  const runAttempt = Number(value?.run_attempt);
  if (value?.version !== 1 || value?.kind !== 'infra_failure' || !/^\d+$/.test(runId)
    || !Number.isSafeInteger(runAttempt) || runAttempt < 1 || !canonicalTimestamp(value.at)
    || typeof value.phase !== 'string' || value.phase.length < 1 || value.phase.length > 80) {
    return null;
  }
  return { ...value, run_id: runId, run_attempt: runAttempt };
}

export function parseTrustedCircuitEvents(comments) {
  const seen = new Set();
  const events = [];
  for (const comment of comments ?? []) {
    if (comment?.user?.login !== BOT_LOGIN || comment?.user?.type !== 'Bot') continue;
    const event = normalizeCircuitEvent(markerPayload(comment.body));
    if (!event) continue;
    const identity = `${event.run_id}:${event.run_attempt}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    events.push(event);
  }
  return events;
}

export function evaluateCircuit(events, now, { threshold = 3, windowMs = 3_600_000, durationMs = 3_600_000 } = {}) {
  if (!Number.isSafeInteger(threshold) || threshold < 1) throw new Error('circuit threshold must be positive');
  if (!Number.isSafeInteger(windowMs) || windowMs < 1) throw new Error('circuit window must be positive');
  if (!Number.isSafeInteger(durationMs) || durationMs < 1) throw new Error('circuit duration must be positive');
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs)) throw new Error('circuit time is invalid');
  const seen = new Set();
  const failures = [];
  for (const value of events ?? []) {
    const event = normalizeCircuitEvent(value);
    if (!event) continue;
    const identity = `${event.run_id}:${event.run_attempt}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const at = Date.parse(event.at);
    if (Number.isFinite(at) && at <= nowMs) failures.push(at);
  }
  failures.sort((left, right) => left - right);
  let openedAt = null;
  let openUntil = null;
  for (let index = threshold - 1; index < failures.length; index += 1) {
    if (failures[index] - failures[index - threshold + 1] <= windowMs) {
      const candidateUntil = failures[index] + durationMs;
      if (candidateUntil > (openUntil ?? Number.NEGATIVE_INFINITY)) {
        openedAt = failures[index];
        openUntil = candidateUntil;
      }
    }
  }
  return {
    open: openUntil !== null && nowMs < openUntil,
    openedAt: openedAt === null ? null : new Date(openedAt).toISOString(),
    openUntil: openUntil === null ? null : new Date(openUntil).toISOString(),
    recentFailureCount: failures.filter((at) => nowMs - at <= windowMs).length,
  };
}

export function circuitEvent({ runId, runAttempt, phase, at = new Date().toISOString() }) {
  const event = normalizeCircuitEvent({
    version: 1,
    kind: 'infra_failure',
    at,
    run_id: String(runId),
    run_attempt: Number(runAttempt),
    phase: String(phase ?? '').slice(0, 80),
  });
  if (!event) throw new Error('circuit event is invalid');
  return event;
}

export function renderEventComment(event, pullNumber) {
  const trusted = normalizeCircuitEvent(event);
  if (!trusted) throw new Error('circuit event is invalid');
  return `Central review infrastructure failure · PR #${Number(pullNumber)} · ${trusted.phase}\n\n<!-- ${EVENT_MARKER} ${JSON.stringify(trusted)} -->`;
}

export function renderSkipComment(state) {
  if (!state?.open || !canonicalTimestamp(state.openUntil)) throw new Error('open circuit state is required');
  return `## Central review skipped by infrastructure circuit\n\nThe automatic review circuit is open until **${state.openUntil}**. This is not a code verdict. A trusted member can comment the exact command \`/review\` to bypass the circuit and retry.`;
}

function authorizedHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function githubJson(fetchImpl, token, url, init = {}) {
  const response = await fetchImpl(url, { ...init, headers: { ...authorizedHeaders(token), ...(init.headers ?? {}) } });
  const text = await response.text();
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

export function createCircuitStore({ apiUrl, repository, token, fetchImpl = fetch }) {
  if (typeof apiUrl !== 'string' || !/^https:\/\//.test(apiUrl)) throw new Error('GitHub API URL must use HTTPS');
  if (typeof repository !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('repository is invalid');
  if (typeof token !== 'string' || token.length === 0) throw new Error('GitHub token is required');
  const repoUrl = `${apiUrl.replace(/\/$/, '')}/repos/${repository}`;

  async function listStateIssues() {
    const matches = [];
    for (let page = 1; page <= 10; page += 1) {
      const issues = await githubJson(fetchImpl, token, `${repoUrl}/issues?state=open&per_page=100&page=${page}`);
      for (const issue of issues) {
        if (!issue.pull_request && issue.title === STATE_TITLE && String(issue.body ?? '').includes(STATE_MARKER)
          && issue.user?.login === BOT_LOGIN && issue.user?.type === 'Bot') matches.push(issue);
      }
      if (issues.length < 100) break;
    }
    return matches.sort((left, right) => left.number - right.number);
  }

  async function ensureStateIssue() {
    let issues = await listStateIssues();
    if (issues.length === 0) {
      await githubJson(fetchImpl, token, `${repoUrl}/issues`, {
        method: 'POST',
        body: JSON.stringify({
          title: STATE_TITLE,
          body: `This issue is maintained by the central review workflow. Do not edit its hidden state marker.\n\n${STATE_MARKER}`,
        }),
      });
      issues = await listStateIssues();
    }
    if (issues.length === 0) throw new Error('circuit state issue could not be created');
    return issues[0];
  }

  async function comments(issueNumber) {
    const values = [];
    for (let page = 1; page <= 10; page += 1) {
      const pageValues = await githubJson(fetchImpl, token, `${repoUrl}/issues/${issueNumber}/comments?per_page=100&page=${page}`);
      values.push(...pageValues);
      if (pageValues.length < 100) break;
    }
    return values;
  }

  return {
    async loadEvents() {
      const issues = await listStateIssues();
      const allComments = await Promise.all(issues.map((issue) => comments(issue.number)));
      return parseTrustedCircuitEvents(allComments.flat());
    },
    async record(event, pullNumber) {
      const issue = await ensureStateIssue();
      const existing = parseTrustedCircuitEvents(await comments(issue.number));
      const identity = `${event.run_id}:${event.run_attempt}`;
      if (existing.some((value) => `${value.run_id}:${value.run_attempt}` === identity)) return false;
      await githubJson(fetchImpl, token, `${repoUrl}/issues/${issue.number}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body: renderEventComment(event, pullNumber) }),
      });
      return true;
    },
    async postPullRequestComment(pullNumber, body) {
      await githubJson(fetchImpl, token, `${repoUrl}/issues/${Number(pullNumber)}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      });
    },
  };
}
