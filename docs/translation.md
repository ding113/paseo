# Translation

Runtime machine translation of dynamic content, through a user-supplied OpenAI-compatible
endpoint. Agent output is rendered in the language you read; composer input is translated
into the agent's language before it goes on the wire.

This is not [i18n.md](i18n.md). That system translates static UI copy shipped in locale
resources and is explicitly barred from touching agent output. The two never share a key.

## Why it is not a plugin

`PluginContext` (`packages/plugin/src/contracts.ts`) has seven methods: `handle`,
`addSurface`, `addSidebarItem`, `addWorkspacePanel`, `addCommandCenterItem`,
`addAttachmentSource`, `addTheme`. None of them intercept an outgoing prompt, decorate the
chat renderer, or contribute a settings page — and there is no plugin storage API. A plugin
can add a screen next to the chat; it cannot change what the chat says. See
[plugins.md](plugins.md).

## Client-side, on purpose

Everything lives in `packages/app`. Nothing touches `packages/protocol` or
`packages/server`, so there is no protocol contract to keep and no `COMPAT(...)` to retire.
The cost is that the API key is per-device and the config does not sync between clients. If
that becomes the wrong trade, the daemon already has the shape to copy — see the
`openai.apiKey`/`baseUrl` block in `packages/server/src/server/persisted-config.ts`.

## Direction is decided by the author, not by the text

There is no language detector. Whoever produced the text determines the target: agent
output goes to `myLanguage`, composer input goes to `agentLanguage`. Two settings, no
sniffing, no confidence thresholds. "Already in the target language" is left to the model,
which is asked to repeat such a segment unchanged.

## Code is excluded structurally, not by prompt

`splitMarkdownBlocks` keeps a fenced block whole — the blank lines inside a fence are
structural. So a message splits into blocks, and excluding code is a check on the block
(`translation/segments.ts`) rather than a masking pass over prose.

That check parses the block instead of reading its first characters. A fence nested under a
list item or a blockquote starts with `-`, `*`, or `>`, so a prefix test hands that code to
the model. A block holding code anywhere is skipped whole, which can leave a list's prose
untranslated: preserving code verbatim is the contract, translating prose is not.

Inline code, paths, URLs, and command names inside prose are covered by the prompt only. In
practice the model does honour it — identifiers like `reducer` come back untouched — but if
one starts rewriting them, that is when a mask/restore pass earns its keep.

## Only settled text is translated

While a turn streams, an assistant message is a growing prefix and `useRevealedText` paces
a slice of it every frame. Translating there would re-request on every coalescing flush and
paint text that keeps being rewritten. `AssistantMessage` only asks for a translation once
`phase` is `"complete"`.

Requests are collected for 300ms and dispatched together, so a message that arrives as six
blocks issues its calls in one concurrent burst rather than a trickle.

## The user's own words come back

The daemon echoes a canonical `user_message` containing the text it received — the
translation. Left alone, that replaces the optimistic row and shows the user a translation
of their own prompt. Sending a prompt therefore records the original under its
`clientMessageId`, which the daemon echoes back, and `UserMessage` renders that.

Keyed by identity, not by the wire text. Two different prompts can translate to the same
string, and a text-keyed map lets the second overwrite the first — one message would then
render another's words in its bubble, its copy payload, and its rewind text.

The lookup is not gated on whether translation is enabled: it is a local read of something
already recorded, with no request behind it. Gating it would make switching translation off
rewrite every existing user bubble into agent-language wire text.

## The prompt is the model card's, verbatim

`translation/client.ts` sends the "Default Translation" instruction from
[the Hy-MT2 model card](https://huggingface.co/tencent/Hy-MT2-30B-A3B) character-for-character,
in Chinese for a Chinese target and English otherwise. A translation model is tuned against
its documented instruction; paraphrasing is what makes one underperform. Do not reword it —
`client.test.ts` asserts both strings against the card.

Three consequences fall out of that instruction, and none of them are negotiable:

- **No system prompt.** The card states these models have no default one, so the whole
  instruction is a single `user` turn.
- **One request per segment.** The instruction asks for the translated result and nothing
  else, which leaves no envelope a batched reply could be split back out of. Segments go out
  concurrently, so a message still costs about one round trip of wall clock. It also deletes
  misalignment as a failure mode — a reply can only belong to the segment it was asked for.
- **Full language names, not codes.** The card's prompts take `中文` / `English`, not `zh` /
  `en`. `translation/languages.ts` holds the card's table and maps Paseo's BCP-47 tags
  (`zh-CN`, `pt-BR`) onto the abbreviations it lists.

A supported language is not automatically a working one. Hy-MT2 lists `繁体中文`, but the
Tencent provider on OpenRouter answers that target with `content: null` and counts its whole
output as reasoning tokens, while `中文` and `English` work — so Traditional Chinese falls back
to the original text there. Check a target end to end before assuming the card's table
matches your provider.

Sampling follows the card's 30B-A3B block. Its `top_k: -1` and `repetition_penalty: 1.0` are
"disabled" values, so they are omitted rather than sent: they change nothing, they are not
in the OpenAI schema, and some gateways reject a negative `top_k`.

## Failure is always a fallback, never a block

A failed translation renders the original. A failed _input_ translation sends the original
rather than throwing: a flaky endpoint must not stop someone from talking to their agent.

Every request carries a 30s deadline. Composer input is translated on the send path, so an
endpoint that connects and then goes quiet would otherwise pin the prompt open forever — the
bubble stays pending and the agent receives nothing, because the fallback is downstream of
that await.

A completion that stopped at the provider's output limit (`finish_reason: "length"`) is
rejected rather than cached. Partial prose looks like a finished translation and would
silently drop the rest of the message.

A failed job stays failed for the session, because retrying on every render turns a bad
endpoint into an unbounded request loop. Changing the endpoint, key, model, or either
language retires those failures — otherwise correcting a typo leaves everything it broke
untranslated until restart.

## Not covered

The interception point is the app composer (`composer/actions.ts`). Prompts entering an
agent from **MCP `send_agent_prompt`**, the **CLI**, a **new agent's first prompt**, or a
**schedule** are not translated. Covering those means moving to the daemon's universal
chokepoint, `startAgentRun` in `packages/server/src/server/agent/agent-prompt.ts`, which
also has to handle `AgentPromptContentBlock[]` and skip `<paseo-system>` envelopes.

Workspace names are translated in the sidebar and the workspace header, but not in the
Command Center: it is a search surface, and translating the label without also matching the
original would break lookup by the name the user knows. The sidebar only requests a name it
will actually show — under `workspaceTitleSource: "branch"` with a checked-out branch the
label is a git ref, and requesting a translation would be a paid round trip, and a
disclosure of the name to the endpoint, for a string never rendered.
