# HushBox

**One interface. Every AI model. Private.**

HushBox is a unified AI chat interface that lets you access GPT, Claude, Gemini, Grok, and dozens of other models from a single application. Switch models mid-conversation. Keep your history forever. Never manage another AI subscription.

🌐 [hushbox.ai](https://hushbox.ai)

---

## The Problem

Every few months, a new "best AI model" launches. The cycle is exhausting:

```
1. New model releases, everyone says it's the best
         ↓
2. Sign up for new service, enter payment info
         ↓
3. Learn new interface, find the features
         ↓
4. Conversations stuck in old platform
         ↓
5. Managing multiple subscriptions
         ↓
6. Another new model releases...
         ↓
   (repeat forever)
```

Your AI history is fragmented across ChatGPT, Claude, Gemini, Perplexity, and whatever launched last week. Each has different features, different interfaces, different billing. You're locked into ecosystems that don't talk to each other.

---

## The Solution

HushBox ends the cycle. One interface, every model, forever.

When a new model launches, you don't migrate—you just select it from the dropdown. Your conversations, your projects, your workflow stay exactly where they are. The AI industry moves fast. Your tools shouldn't force you to move with it.

---

## Encrypted By Default

When you send a message, it's encrypted in transit to the AI model and stored with an encryption key only you hold. We never store plaintext. Our servers cannot read your conversations — even if we wanted to.

**Your password never leaves your device.** We use OPAQUE, the state-of-the-art password protocol, so your password is never transmitted to our servers.

**Your messages are encrypted with your password.** Every message is encrypted in your browser before it's stored. The encryption key is derived from your password — which only you know. Without your password or recovery phrase, your data is inaccessible to everyone, including us.

|                                | ChatGPT | Claude | Gemini | HushBox |
| ------------------------------ | :-----: | :----: | :----: | :-----: |
| Stored messages encrypted      |   No    |   No   |   No   | **Yes** |
| Provider can read stored chats |   Yes   |  Yes   |  Yes   | **No**  |

---

## Our Principles

### Privacy First

We believe your conversations with AI are deeply personal. They contain your ideas, your questions, your work.

**What we control (and guarantee):**

- We never sell your data
- We never train on your conversations
- We never share your information with data brokers

**Pseudo-anonymity:**
When your messages reach AI providers, they see HushBox's credentials—not yours. Providers cannot link messages to your identity. However, avoid including personal information in messages (names, addresses, financial details) as message content is visible to model providers.

**What we cannot control:**

- Model providers (OpenAI, Anthropic, Google) have their own data policies
- We cannot guarantee providers don't log or train on message content
- Message content must be sent to AI providers for inference — this is inherent to how AI models work

**For maximum privacy:**

- Avoid including personal information in messages (names, addresses, financial details)
- Review provider data policies for models you use

### Radical Transparency

We charge a **{{TOTAL_FEE_PERCENT}} fee** on AI model usage plus a **storage fee** of {{STORAGE_COST_PER_1K}} per 1,000 characters.

**Fee breakdown ({{TOTAL_FEE_PERCENT}} total on model usage):**

- **{{HUSHBOX_FEE_PERCENT}}** — HushBox profit margin
- **{{CC_FEE_PERCENT}}** — Credit card processing
- **{{PROVIDER_FEE_PERCENT}}** — AI provider overhead

**Why a separate storage fee?**

The {{TOTAL_FEE_PERCENT}} covers operations—servers, development, support. The storage fee covers storing your conversations.

**The storage fee is tiny:**

$1 in storage fees buys you over **{{MESSAGES_PER_DOLLAR}} messages** at 200 characters each. Most users will spend less than $1/year on storage while spending far more on AI model usage.

No hidden fees. No premium tiers that unlock basic features. No "free" tier subsidized by selling your data.

Other services bury additional charges in credit purchases and claim "no fees". We don't.

You pay for what you use. We take a small cut to keep the lights on. The math is simple and public.

### No Data Monetization

We will never:

- Sell your conversations to third parties
- Use your data for advertising
- Train AI models on your chats
- Share your information with data brokers

This isn't a marketing promise—it's our business model. We make money from the {{TOTAL_FEE_PERCENT}} fee. We have no incentive to monetize your data because we've built a sustainable business without it.

---

## Features

- **Multi-Model Chat** — GPT, Claude, Gemini, Grok, and more from one interface
- **Model Switching** — Change models mid-conversation, compare outputs
- **Unified Document Panel** — Code editing, rendering, and word processing in one place
- **Code Execution** — Run Python and JavaScript in secure sandboxes
- **Project Organization** — Group conversations, files, and context together

See [docs/FEATURES.md](./docs/FEATURES.md) for the complete feature list and development phases.

---

## Contributing

See [docs/CONTRIBUTING.md](./docs/CONTRIBUTING.md) for development setup and contribution guidelines.

All contributors must agree to our [Contributor Assignment Agreement](https://gist.github.com/ctf05/24b91cac419a904919d1ad30eb14b9cd).

---

## License & Legal

This software is proprietary. The source code is visible for transparency, but usage rights require explicit permission from LOME-AI LLC. See [LICENSE](./LICENSE) for details.

All code in this repository, including all contributions, is the sole property of **LOME-AI LLC**.

---

## Contact

- **Website:** [hushbox.ai](https://hushbox.ai)
- **Email:** hello@hushbox.ai
- **Security Issues:** security@hushbox.ai

---

_Built with privacy in mind by LOME-AI LLC._
