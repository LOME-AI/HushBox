# Product

## Register

product

## Users

People who use many AI models and want one private place for all of it. They are privacy-conscious and a little skeptical: they have watched their history scatter across ChatGPT, Claude, Gemini, and whatever launched last week, each with its own lock on their data. They range from technical (developers, researchers) to thoughtful non-technical users who simply want their conversations to stay theirs. They reach for HushBox to think out loud, ask the wrong question, switch models mid-conversation, and trust that the words stay encrypted. The primary surface is the product app (chat, settings, account, billing); marketing and `/welcome` are the brand-register surfaces.

## Product Purpose

HushBox puts GPT, Claude, Gemini, Llama, DeepSeek, and a hundred-plus other models behind a single interface, encrypted in the browser before anything is stored. Switch models mid-conversation, fork a thread to compare takes, and pick the next model from a dropdown instead of migrating. The business model is public to the basis point: a percentage on model usage and a flat rate per unit of storage, no subscriptions and no data monetization. Success is a person trusting HushBox with the question they would not type anywhere else, and finding it faster and calmer than the tool they left.

## Brand Personality

Calm, transparent, exacting. The voice is direct and technical-but-human: confident without hype, precise about privacy and cost, never selling. It earns trust by showing its work rather than reassuring. It should feel like a quiet, well-made instrument, not a growth-hacked SaaS funnel.

## Anti-references

- Generic AI-chat clones: gray symmetrical message bubbles, a sparkle icon, a centered "How can I help you today?" empty state, a purple-blue gradient, an assistant-avatar blob. HushBox fronts these models; it must not look like a reskin of one.
- Surveillance-SaaS dashboards: cold, data-hungry, metric-walled admin UIs.
- Hype-y crypto and AI marketing: neon, "revolutionize", fake scarcity, breathless launch copy.
- Dark-pattern growth UI: manufactured urgency, hidden costs, confirmshaming, anything that manages trust instead of earning it.

## Design Principles

- **Show trust, don't claim it.** Privacy and transparency are the product. The interface proves them plainly (encryption state, real cost, which model is answering) and never uses a dark pattern, fake urgency, or hidden mechanic.
- **The content is the interface.** In conversation the words are the design; chrome recedes. Legibility, measure, and rhythm beat ornament.
- **Never a clone.** HushBox fronts many models but is none of them. Resist the generic AI-app look; it must read as HushBox.
- **Expressive by default, calm on demand.** Lean into motion and composition, with reduced or no motion always one toggle away. Confidence, not restraint for its own sake.
- **Accessible by construction.** The UI is re-painted at runtime for accessibility; a design that breaks under contrast, inversion, scaling, or stopped motion is not finished. Inclusion is the floor, not a feature.

## Accessibility & Inclusion

WCAG 2.1 AA as the floor across every surface, with the in-app accessibility widget as a first-class constraint: contrast tiers, saturation and color-blind simulation, color inversion, font scaling well past default, loosened spacing, a dyslexia-friendly face, and a full stop-animations toggle. Every design must survive all of those. Reduced motion and stopped motion are honored by construction (motion is gated through the motion-aware helper). Semantic HTML over ARIA roles, visible keyboard focus, and meaning never carried by color alone.
