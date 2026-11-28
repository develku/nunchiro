# Agents Nunchiro lists

Generated from `crates/nunchiro-core/src/acp/known.toml` by `scripts/gen-agents-doc.py`; do not edit by hand.
Settings > Accounts offers these in its add tiles. Nunchiro types an install command into a terminal tab and
never runs it. Costs were read on each vendor's page on the date shown; prices change, so the link is the reference.

| Agent | ACP command | Install | Sign in | Cost | Checked |
|---|---|---|---|---|---|
| Gemini CLI | `gemini --acp` | `npm install -g @google/gemini-cli` |  | Paid key: Needs a paid API key. Free Google sign-in ended in June 2026. ([plans](https://ai.google.dev/gemini-api/docs/pricing)) | 2026-11-27 |
| OpenCode | `opencode acp` | `curl -fsSL https://opencode.ai/install \| bash` | `opencode auth login` | Free models: Free models are offered for a limited time. Other models are paid per use. ([plans](https://opencode.ai/docs/zen/)) | 2026-11-27 |
| goose | `goose acp` | `brew install block-goose-cli` | `goose configure` | Your own model: Runs on a model you connect. What it costs depends on that provider. ([plans](https://goose-docs.ai/docs/getting-started/installation)) | 2026-11-27 |
| Aider | terminal only |  |  | Cost not checked |  |
| Cursor | `agent acp` | `curl https://cursor.com/install -fsS \| bash` | `agent login` | Free plan, limited: The Free plan has limited agent requests. Whether it covers the CLI is not confirmed. ([plans](https://cursor.com/pricing)) | 2026-11-27 |
| Grok | `grok agent stdio` |  |  | Cost not checked |  |
| Antigravity | `agy acp` | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` |  | Free plan, limited: The Free tier has a weekly agent quota. Pro and Ultra come with Google AI plans. ([plans](https://antigravity.google/pricing)) | 2026-11-27 |
| GitHub Copilot | `copilot --acp` | `npm install -g @github/copilot` | `copilot login` | Free plan works: Copilot Free includes the CLI, with limited monthly AI credits. Pro is $10 a month. ([plans](https://github.com/features/copilot/plans)) | 2026-11-27 |
| Kiro | `kiro-cli acp` | `curl -fsSL https://cli.kiro.dev/install \| bash` | `kiro-cli login` | Free plan, limited: The Free plan gives 50 credits a month. Pro is $20 a month. ([plans](https://kiro.dev/pricing/)) | 2026-11-27 |
| Kilo Code | `kilo acp` | `npm install -g @kilocode/cli` | `kilo auth login` | Free models: Free for individuals, with free models through Kilo Gateway or your own key. ([plans](https://kilo.ai/pricing)) | 2026-11-27 |
| Mistral Vibe | `vibe-acp` | `curl -LsSf https://mistral.ai/vibe/install.sh \| bash` | `vibe --setup` | Free plan, limited: The Free plan includes limited Vibe coding sessions. Pro is $14.99 a month. ([plans](https://mistral.ai/pricing)) | 2026-11-27 |
| Cline | `cline --acp` | `npm install -g cline` | `cline auth` | Your own model: The CLI is free for individuals. Bring your own key or pay Cline per use. ([plans](https://cline.bot/pricing)) | 2026-11-27 |
| Hermes | `hermes acp` | `curl -fsSL https://hermes-agent.nousresearch.com/install.sh \| bash` | `hermes model` | Your own model: Runs on a model you connect. What it costs depends on that provider. ([plans](https://portal.nousresearch.com)) | 2026-11-27 |
| Qwen Code | `qwen --acp` | `npm install -g @qwen-code/qwen-code` |  | Paid plan: Sign-in needs a paid Qwen plan or your own API key. ([plans](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/)) | 2026-11-27 |
| Factory Droid | `droid exec --output-format acp` | `curl -fsSL https://app.factory.ai/cli \| sh` |  | Paid key: The Free plan works with your own API keys. Pro is $20 a month. ([plans](https://factory.com/pricing)) | 2026-11-27 |
| Auggie | `auggie --acp` | `npm install -g @augmentcode/auggie` | `auggie login` | Paid plan: There is no free plan, only a trial. Standard is $20 a month. ([plans](https://www.augmentcode.com/pricing)) | 2026-11-27 |

API key services that run through OpenCode: OpenRouter, GLM, Kimi.
