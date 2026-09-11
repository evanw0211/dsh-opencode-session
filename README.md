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
`0.1.5-rc.2`, pi-ai `0.85.1`) and `pnpm` on `PATH` — the `dsh plugin` command forwards to it.

```sh
dsh plugin --profile <profile> add github:evanw0211/dsh-opencode-session
```

That is the whole install. `dsh plugin` runs `pnpm add` in the profile directory and then
reconciles `dsh.profile.bundles`: a dependency whose manifest declares `dsh.bundle` joins
the layer stack automatically, so the profile manifest gains the entry by itself and the
next boot loads this package's patch layer.

Because the package is installed into the profile, its `import` of
`@deepseek-ai/dsh-llm-pi-ai` resolves to the harness's own copy — hoisted at
`$DSH_HOME/profiles/node_modules` — so the plugin shares the host's adapter instance rather
than bundling a second one. That dependency is declared as an optional peer for exactly
that reason.

Out of the box the bundle ships one route — `opencode-go-chat`, carrying `deepseek-flash`
on `https://opencode.ai/zen/go/v1` — and names a credential reference for it:

```yaml
# this package's cordis.patch.yml, loaded as a base layer
- insert:
    - id: opencode-session
      name: dsh-opencode-session
      config:
        providers:
          opencode-go-chat:
            apiKeyEnv: OPENCODE_GO_API_KEY
            api: openai-completions
            baseURL: https://opencode.ai/zen/go/v1
            models:
              - id: deepseek-flash
                # …capabilities and compat switches
```

`apiKeyEnv` is a credential **reference**, not a value: the key lives in the harness
credential store (`$DSH_HOME/.credentials.yaml`) under that name and is resolved per
request. If you already configured OpenCode — through the Models page, or from the shipped
`opencode-go` route, which uses the same reference — nothing further is needed.

> **These routes are not editable on Settings → Models.** That page edits the `llm-pi-ai`
> settings namespace, and the plugin withholds the `settings` service from the upstream
> adapter so it cannot claim that namespace a second time. Configure routes with a profile
> patch row instead — see `cordis.patch.yml` for the shape. They do appear in the model
> picker, which lists registered providers.

### Adding a second protocol

A route names one `api` — see below — so a second protocol needs a second row. Add it to
your own profile patch, which sits above the bundle layer:

```yaml
# $DSH_HOME/profiles/<profile>/cordis.patch.yml
- insert:
    - id: opencode-session-messages
      name: dsh-opencode-session
      config:
        providers:
          opencode-go-messages:
            displayName: OpenCode Go · Messages
            apiKeyEnv: OPENCODE_GO_API_KEY
            api: anthropic-messages
            baseURL: https://opencode.ai/zen/go
            models:
              - id: minimax-m3
              - id: qwen3.8-flash
```

The `baseURL` carries no `/v1` for Anthropic because pi-ai's Anthropic implementation
appends `/v1/messages` itself.

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
- **`settings` and `authorization` are withheld** from the shim, because the upstream
  adapter would otherwise claim the `llm-pi-ai` settings namespace a second time. The
  consequence is above: routes are configured by patch row, not by the Models page.

## Verified

End to end, against `dsh 0.1.5-rc.1` (packages `0.1.5-rc.2`, pi-ai `0.85.1`):

```sh
dsh --profile oplite --from-default-profile headless --dump-config
dsh plugin --profile oplite add github:evanw0211/dsh-opencode-session
dsh --profile oplite headless "reply with exactly: pong"      # → pong, exit 0
```

and the control, with `- id: opencode-session` + `disabled: true` in the profile patch,
fails — so the route really is this package's:

```
dsh: NO_ADAPTER: no adapter registered for provider "opencode-go-chat"
```

A successful call is itself evidence for the header: OpenCode Go answers a request without
it with `HTTP 400 MissingSessionID`.

The header is also observable without any credential: run a local echo server, point a route
at it with `apiKeyEnv` set to a dummy value, and confirm the request carries
`x-opencode-session`, and that a request without a session id does not.

## Uninstall

```sh
dsh plugin --profile <profile> remove dsh-opencode-session
```

The reconciler drops it from `dsh.profile.bundles` by itself. To keep the package but stop
its routes, disable the row in your profile patch:

```yaml
- id: opencode-session
  disabled: true
```

Nothing outside the profile was modified — no file in the DSH install changes.

## License

Not yet chosen.
