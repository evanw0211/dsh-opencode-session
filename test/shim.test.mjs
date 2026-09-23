/**
 * Regression test for the shim context and the dispatch wrapper.
 *
 * The shim used to be a hand-written object, and pi-ai 0.1.7-alpha.2 grew two
 * reads it did not list — `ctx.fiber.entry?.options.id` and `ctx.on` — so the
 * whole profile entry failed at load with
 * `Cannot read properties of undefined (reading 'entry')`. These tests mount the
 * plugin on a real Cordis context against the real installed
 * `@deepseek-ai/dsh-llm-pi-ai`, which is what caught it.
 *
 * Run with the harness install providing the dependencies (the repository's
 * `node_modules` is a symlink into it, see .gitignore):
 *
 *     npm test
 */

import assert from 'node:assert/strict'

import { Context } from '@deepseek-ai/cordis'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'

import * as plugin from '../index.js'

/** The single route the package's own `cordis.patch.yml` mounts. */
const ROUTE_CONFIG = {
  providers: {
    'opencode-go-chat': {
      displayName: 'OpenCode Go · Chat',
      apiKeyEnv: 'OPENCODE_GO_API_KEY',
      api: 'openai-completions',
      baseURL: 'https://opencode.ai/zen/go/v1',
      models: [
        {
          id: 'deepseek-flash',
          name: 'DeepSeek V4.1 Flash',
          contextWindow: 1000000,
          maxTokens: 256000,
          input: ['text'],
        },
      ],
    },
  },
}

/**
 * Mount the plugin the way the profile loader does: a real Cordis root that
 * provides `llm` and `settings`, then the plugin fiber, awaited to settlement.
 *
 * @returns the recording stubs and the plugin fiber.
 */
async function mount() {
  const root = new Context()
  const registrations = []
  const settingsCalls = []

  root.plugin({
    name: 'shim-test-services',
    apply(ctx) {
      ctx.provide('llm', {
        registerAdapter(routes, adapter) {
          const handle = { routes: [...routes] }
          handle.replace = (next) => {
            handle.routes = [...next]
          }
          registrations.push({ handle, adapter })
          return handle
        },
        registerConfigurableProviders() {
          return { replace() {} }
        },
        registerModelDiscovery() {
          return () => {}
        },
      })
      ctx.provide('settings', {
        configure() {
          settingsCalls.push('configure')
          throw new Error('the shim must withhold the `settings` service')
        },
      })
    },
  })

  const fiber = root.plugin(plugin, structuredClone(ROUTE_CONFIG))
  await fiber
  return { root, fiber, registrations, settingsCalls }
}

const { root, fiber, registrations, settingsCalls } = await mount()

// `Fiber.state` 2 is active; 3 is failed and 4 disposed (the values the harness
// boot uses). An `apply()` that throws leaves the fiber failed, and the failure
// this test guards against is only visible here — awaiting the fiber does not
// reject for it.
assert.equal(fiber.state, 2, 'the plugin fiber must reach the active state')
assert.equal(registrations.length, 1, 'the upstream adapter must register exactly once')
assert.deepEqual(
  registrations[0].handle.routes,
  ['opencode-go-chat'],
  'the configured route must reach `llm.registerAdapter`',
)
assert.equal(settingsCalls.length, 0, 'the upstream adapter must not reach the withheld `settings` service')

// The `loader/volatile-update` listener the upstream adapter registers through
// the shim must be real: dispatching it re-checks the registration facts.
root.emit('loader/volatile-update')
assert.deepEqual(registrations[0].handle.routes, ['opencode-go-chat'])

const adapter = registrations[0].adapter
assert.ok(adapter instanceof PiAiAdapter, 'the registered adapter must extend the upstream adapter')

// Pin the base snapshot so the wrapper is exercised without any provider I/O.
const baseCurrent = PiAiAdapter.prototype.current
const dispatches = []
const baseSnapshot = {
  profiles: new Map(),
  models: {
    streamSimple(model, context, options) {
      dispatches.push({ model, context, options })
      return 'streamed'
    },
    getModels() {
      return []
    },
  },
}
PiAiAdapter.prototype.current = () => baseSnapshot

try {
  const first = adapter.current()
  const second = adapter.current()
  assert.equal(first, second, 'one upstream snapshot must wrap to one identity')
  assert.equal(first.profiles, baseSnapshot.profiles, 'the wrapped snapshot must keep the upstream profiles')
  assert.notEqual(first.models, baseSnapshot.models, 'the models collection must be proxied')
  assert.deepEqual(first.models.getModels(), [], 'other Models methods must stay bound to the real collection')

  const model = { provider: 'opencode-go-chat', id: 'deepseek-flash' }
  const context = { messages: [] }

  assert.equal(first.models.streamSimple(model, context, { sessionId: 'session-abc' }), 'streamed')
  const [call] = dispatches
  assert.equal(call.model, model)
  assert.equal(call.context, context)
  assert.equal(typeof call.options.transformHeaders, 'function', 'dispatch must carry a header transform')
  assert.deepEqual(await call.options.transformHeaders({ existing: 'kept' }), {
    existing: 'kept',
    'x-opencode-session': 'session-abc',
  })
  assert.deepEqual(await call.options.transformHeaders(undefined), { 'x-opencode-session': 'session-abc' })

  dispatches.length = 0
  await first.models.streamSimple(model, context, {
    sessionId: 'session-def',
    transformHeaders: async (headers) => ({ ...headers, prior: 'kept' }),
  })
  assert.deepEqual(await dispatches[0].options.transformHeaders({ base: 'kept' }), {
    base: 'kept',
    prior: 'kept',
    'x-opencode-session': 'session-def',
  })

  dispatches.length = 0
  first.models.streamSimple(model, context, {})
  assert.equal(dispatches[0].options.transformHeaders, undefined, 'without a session id nothing is added')

  dispatches.length = 0
  first.models.streamSimple(model, context, undefined)
  assert.equal(dispatches[0].options, undefined, 'an absent options object stays absent')
} finally {
  PiAiAdapter.prototype.current = baseCurrent
}

console.log('shim.test.mjs: ok')
