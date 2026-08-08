/**
 * Dynamic model discovery for an AxonHub gateway, vendored for the v2 runner
 * harness. On startup it fetches <AXONHUB_BASE_URL>/v1/models and registers
 * every entry as a pi model under the "axonhub" provider.
 *
 * Why this exists on a runner at all: pi's built-in "anthropic" provider does
 * NOT honor ANTHROPIC_BASE_URL - it always dials api.anthropic.com (probed
 * 2026-08-08: a mock relay received zero requests while pi returned a real
 * Anthropic 401). Routing pi workers through the review relay therefore needs
 * an explicit provider pointing at the relay's openai-completions surface, and
 * the plugin is how the relay's model list reaches pi without hand-editing
 * models.json.
 *
 * Env vars (injected by the workflow from inputs + secrets):
 *   AXONHUB_BASE_URL   - gateway base URL, e.g. https://relay.example/v1 base
 *   PI_AXONHUB_API_KEY - key the relay accepts (Bearer)
 *
 * The provider deliberately under-declares the context window (128k): pi
 * auto-compacts early and merely wastes headroom, while over-declaring would
 * let pi fill a window the relay cannot carry. Over-declaring the output cap is
 * the opposite trap (maxTokens left modest; the gateway decides the real cap).
 */

interface AxonHubModel {
	id: string;
	object?: string;
	created?: number;
	owned_by?: string;
}

export default async function (pi: import("@mariozechner/pi-coding-agent").ExtensionAPI) {
	const baseUrl = process.env.AXONHUB_BASE_URL;
	const apiKey = process.env.PI_AXONHUB_API_KEY;

	if (!baseUrl || !apiKey) {
		return;
	}

	let models: AxonHubModel[] = [];
	try {
		const res = await fetch(`${baseUrl}/v1/models`, {
			headers: { Authorization: `Bearer ${apiKey}` },
		});
		if (!res.ok) {
			return;
		}
		const body = await res.json();
		models = Array.isArray(body?.data) ? body.data : [];
	} catch {
		// Gateway unreachable - start pi without this provider rather than
		// failing, mirroring the local fleet behavior.
		return;
	}

	if (models.length === 0) {
		return;
	}

	pi.registerProvider("axonhub", {
		baseUrl: `${baseUrl}/v1`,
		apiKey,
		api: "openai-completions",
		models: models.map((m) => ({
			id: m.id,
			name: m.id,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192,
		})),
	});
}
