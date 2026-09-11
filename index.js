/**
 * OpenCode Go conversation identity, as a profile plugin.
 *
 * OpenCode Go answers a request that carries no conversation id with HTTP 400
 * `MissingSessionID`, and the id travels in `x-opencode-session`. The harness
 * already forwards its Session id to pi-ai (`GenerateOptions.sessionId`), but
 * pi-ai emits a session header only when a model declares
 * `compat.sendSessionAffinityHeaders`, and its `SessionAffinityFormat` union
 * (`openai` | `openai-nosession` | `openrouter`) emits `x-session-id`,
 * `session_id`, `x-client-request-id` or `x-session-affinity` — never
 * `x-opencode-session`. `dsh-llm-pi-ai` withholds both compat switches from
 * configuration, so a route configuration cannot produce this header.
 *
 * This plugin therefore owns the route itself and shares the adapter's work
 * instead of duplicating it:
 *
 *  1. it mounts the upstream `apply()` — the exported plugin contract of
 *     `@deepseek-ai/dsh-llm-pi-ai` — on a shim context, so profile resolution,
 *     model/compat materialization, provider construction, credential
 *     resolution and the harness/pi-ai conversion all stay upstream's;
 *  2. the shim swaps the adapter at its one registration point for a subclass
 *     whose `current()` hands the base class a `Models` proxy whose
 *     `streamSimple` adds pi-ai's Models-only `transformHeaders` option.
 *
 * `transformHeaders` runs inside pi-ai's `applyAuth` after provider auth and
 * explicit headers merge and before dispatch, so the header lands on exactly
 * this plugin's routes and is taken from that request's own Session id; it is a
 * supported pi-ai option, not an internal of this deployment.
 *
 * Two services are withheld from the shim: `settings`, because the upstream
 * adapter would claim the `llm-pi-ai` namespace its own plugin already owns,
 * and `authorization`, because its sign-in flows are not this plugin's. Routes
 * this plugin owns are configured by its composition entry alone, so they do
 * not appear in the Models settings page (they do appear in the model picker,
 * which lists registered providers).
 *
 * The one internal it reads is the adapter instance's `config` field, which the
 * upstream constructor assigns and every one of its methods closes over. A
 * change there fails loudly at plugin load rather than at request time.
 *
 * @module dsh-plugin-opencode-session
 */

import { Config as PiAiConfig, apply as applyPiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'

/** The plugin id Cordis reports for this row. */
export const name = 'opencode-session'

/**
 * The upstream adapter registers routes through `ctx.llm`; the plugin only
 * reaches that service through the shim, so it must exist before mounting.
 */
export const inject = ['llm']

/**
 * The upstream configuration schema, so this plugin's entry accepts the same
 * `providers` dict — endpoint, protocol, credential reference and model list —
 * as a `llm-pi-ai` profile and resolves it with the same rules.
 */
export const Config = PiAiConfig

/** The header OpenCode Go requires on every request. */
const SESSION_HEADER = 'x-opencode-session'

/**
 * Services the upstream `apply()` must not see on the shim: `settings` would
 * collide with the `llm-pi-ai` namespace its own plugin already registered, and
 * `authorization` belongs to that plugin's sign-in flows.
 */
const WITHHELD_SERVICES = new Set(['settings', 'authorization'])

/**
 * Add this request's conversation id to one pi-ai call's headers.
 *
 * The base adapter already passes `sessionId`; this only teaches pi-ai's header
 * pipeline what to do with it, and it runs per request because
 * `transformHeaders` closes over the options of exactly one call.
 *
 * @param options - the pi-ai stream options the base adapter built.
 * @returns those options with a header transform, or them unchanged.
 */
function withSessionHeader(options) {
  const sessionId = options === undefined ? undefined : options.sessionId
  if (sessionId === undefined || sessionId === null || sessionId === '') return options
  const previous = typeof options.transformHeaders === 'function' ? options.transformHeaders : undefined
  return {
    ...options,
    transformHeaders: async (headers) => {
      const merged = previous === undefined ? headers : await previous(headers)
      return { ...(merged ?? {}), [SESSION_HEADER]: String(sessionId) }
    },
  }
}

/**
 * Wrap one upstream adapter so its pi-ai dispatch carries the session header.
 *
 * `current()` is the adapter's single snapshot accessor — every streaming,
 * listing and lookup path goes through it — so overriding it reaches dispatch
 * without touching conversion, replay, retry or error handling. The wrapper is
 * cached per upstream snapshot, so an unchanged configuration still resolves to
 * one identity.
 *
 * @param base - the adapter the upstream `apply()` built.
 * @returns an adapter serving the same routes with the header added.
 */
function withOpenCodeSession(base) {
  const config = base === undefined || base === null ? undefined : base.config
  if (config === undefined || typeof config.profiles !== 'function') {
    throw new Error(
      'opencode-session: the installed @deepseek-ai/dsh-llm-pi-ai adapter no longer exposes the `config` this plugin wraps; re-verify the wrapper against the installed version',
    )
  }
  const AdapterClass = base.constructor
  const wrapped = new WeakMap()

  class OpenCodeSessionAdapter extends AdapterClass {
    current() {
      const snapshot = super.current()
      const cached = wrapped.get(snapshot)
      if (cached !== undefined) return cached
      const { models } = snapshot
      const next = {
        profiles: snapshot.profiles,
        // A proxy rather than a hand-written delegate: every other Models
        // method the base class may reach for keeps working, bound to the real
        // collection, and only dispatch is reshaped.
        models: new Proxy(models, {
          get(target, property) {
            if (property === 'streamSimple') {
              return (model, context, options) => target.streamSimple(model, context, withSessionHeader(options))
            }
            const value = Reflect.get(target, property, target)
            return typeof value === 'function' ? value.bind(target) : value
          },
        }),
      }
      wrapped.set(snapshot, next)
      return next
    }
  }

  return new OpenCodeSessionAdapter(config)
}

/**
 * Mount the OpenCode Go routes this plugin's entry configures.
 *
 * @param ctx - the plugin context; `ctx.llm` receives the wrapped adapter.
 * @param config - the upstream `{ providers }` configuration.
 */
export function apply(ctx, config) {
  const llm = ctx.llm
  const shim = {
    get: (service) => (WITHHELD_SERVICES.has(service) ? undefined : ctx.get(service)),
    inject: () => () => {},
    logger: ctx.logger,
    llm: {
      registerAdapter: (routes, adapter) => llm.registerAdapter(routes, withOpenCodeSession(adapter)),
      // The configurable-provider directory belongs to the `llm-pi-ai` settings
      // namespace this plugin does not own, and model discovery is that
      // plugin's registration; both are left alone.
      registerConfigurableProviders: () => ({ replace() {} }),
      registerModelDiscovery: () => () => {},
    },
  }
  applyPiAiAdapter(shim, config)
  const routes = Object.keys((config ?? {}).providers ?? {})
  ctx.logger?.info?.(`opencode-session: serving ${routes.join(', ')} with ${SESSION_HEADER}`)
}
