# dsh-plugin-opencode-session

Puts a per-conversation conversation id on every **OpenCode Go** request from
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), by owning the
route and reusing the shipped `@deepseek-ai/dsh-llm-pi-ai` adapter.

## The problem

OpenCode's gateway expects a stable session id per conversation in the
`x-opencode-session` header. The [Go docs](https://opencode.ai/docs/go/) say it is used
"so we can optimize routing and prompt caching" — and the effect is large, because the
documented request shape for `deepseek-flash` is 410 input tokens against **71,300 cached**
tokens, billed at `$0.003` instead of `$0.15` per million.

A request without it is answered with `HTTP 400 MissingSessionID`.

Harness already knows the id and forwards it — `GenerateOptions.sessionId`, documented as
*"Session identity stamped by the loop for request routing … adapters may map it to
model-hidden transport metadata"* — but nothing maps it to that header:

- pi-ai's `SessionAffinityFormat` union is `"openai" | "openai-nosession" | "openrouter"`,
  which emit `session_id`, `x-client-request-id`, `x-session-affinity`, or `x-session-id`.
  **Never `x-opencode-session`.**
- `dsh-llm-pi-ai` lists `sendSessionAffinityHeaders` and `sessionAffinityFormat` as
  `"withhold"` in all three protocol compat gates, so a route configuration cannot select
  one either.

## How it works

1. It mounts the upstream `apply()` — the exported plugin contract of
   `@deepseek-ai/dsh-llm-pi-ai` — on a shim context, so profile resolution, model and
   compat materialization, provider construction, credential resolution, and the
   harness/pi-ai conversion all stay upstream's code.
2. The shim swaps the adapter at its **one registration point** for a subclass whose
   `current()` hands the base class a `Models` proxy whose `streamSimple` adds pi-ai's
   `Models`-only `transformHeaders` option.

`transformHeaders` runs inside pi-ai's `applyAuth`, after provider auth and explicit
headers merge and before dispatch, so the header lands on exactly this plugin's routes and
carries that request's own session id. It is a supported pi-ai option, not an internal.

No file in the DSH install is modified.

## Install

Requires DSH with `@deepseek-ai/dsh-llm-pi-ai` (verified against `0.1.5-rc.1` / packages
`0.1.5-rc.2`, pi-ai `0.85.1`).

Point a profile patch row at this directory and configure a route on it. The plugin's
config is the upstream schema, so a route takes the same fields a `llm-pi-ai` profile does:

```yaml
# $DSH_HOME/profiles/<profile>/cordis.patch.yml
- insert:
    - id: opencode-session
      name: /path/to/dsh-plugin-opencode-session/index.js
      config:
        providers:
          opencode-go-chat:
            displayName: OpenCode Go · Chat
            apiKeyEnv: OPENCODE_GO_API_KEY
            api: openai-completions
            baseURL: https://opencode.ai/zen/go/v1
            models:
              - id: deepseek-flash
                name: DeepSeek V4.1 Flash
                contextWindow: 1000000
                maxTokens: 256000
                input: [text]
                compat:
                  supportsStore: false
                  supportsDeveloperRole: false
                  maxTokensField: max_tokens
                  requiresReasoningContentOnAssistantMessages: true
                  thinkingFormat: deepseek
```

`apiKeyEnv` is a credential **reference**, not a value — the key itself stays in the
harness credential store.

### One protocol per route

A route names a single `api`, and OpenCode Go serves three, so it needs three routes:
`/chat/completions` (`openai-completions`), `/messages` (`anthropic-messages`), and
`/responses` (`openai-responses`). This is the documented answer, not a local workaround —
the Models page says *"A provider speaks one protocol, so a gateway that serves two needs
two providers."*

## Limitations

- **The one internal it reads is a TypeScript-private field.** `PiAiAdapter.config` is
  declared `private readonly config`; the plugin reads it to hand the base class its own
  configuration. It is not `#private`, so it survives in the published build, and the
  plugin throws a named error at load if it ever disappears — but it is outside the public
  type surface. The durable fix is upstream: teach pi-ai an `opencode` session-affinity
  format, or `dsh-llm-pi-ai` a per-route session-header option.
- **Routes owned by this plugin are not editable on Settings → Models.** That page edits
  the `llm-pi-ai` namespace, which the shipped adapter owns. The routes do appear in the
  model picker.
- **`settings` and `authorization` are withheld** from the shim, because the upstream
  adapter would otherwise claim the `llm-pi-ai` settings namespace a second time.

## Verify

The header is observable without any credential: run a local echo server, point a route at
it with `apiKeyEnv` set to a dummy value, and confirm the request carries
`x-opencode-session`, and that a request without a session id does not.

## Rollback

Remove the `insert` entry from the profile patch (or set `disabled: true` on it) and delete
this directory. Nothing outside it changed.

## License

Not yet chosen.
