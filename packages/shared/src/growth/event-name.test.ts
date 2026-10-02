// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import {
  deriveEventName,
  GROWTH_CLICK_SELECTOR,
  GROWTH_EVENT_TEXT_MAX_LENGTH,
} from './event-name.ts';
import { GROWTH_EVENT_NAME_MAX_LENGTH } from './patterns.ts';

import type { EventNameElement } from './event-name.ts';

/** Builds one element from HTML so the test states the markup the derivation reads, not a hand-built stub. */
function element(html: string): Element {
  const host = document.createElement('div');
  host.innerHTML = html;
  const first = host.firstElementChild;
  if (first === null) throw new Error('fixture produced no element');
  return first;
}

describe('deriveEventName priority order', () => {
  it('takes the data-track override ahead of every other source', () => {
    expect(
      deriveEventName(element('<a id="hero" data-track="hero-cta" href="/chat">Start now</a>'))
    ).toBe('hero-cta');
  });

  it('takes the element id when there is no override', () => {
    expect(deriveEventName(element('<a id="hero-link" href="/chat">Start now</a>'))).toBe(
      'hero-link'
    );
  });

  it('takes the same-origin path of a link when there is no override and no id', () => {
    expect(deriveEventName(element('<a href="/blog/a-post">Read it</a>'))).toBe(
      'link:/blog/a-post'
    );
  });

  it('takes the path of an absolute link to the site itself, not its hostname', () => {
    expect(deriveEventName(element('<a href="https://hushbox.ai/welcome">Home</a>'))).toBe(
      'link:/welcome'
    );
  });

  it('takes the hostname of an external link rather than its path', () => {
    expect(deriveEventName(element('<a href="https://example.com/a/b">Docs</a>'))).toBe(
      'link:example.com'
    );
  });

  it('takes the accessible label when the element is a button with no override or id', () => {
    expect(deriveEventName(element('<button aria-label="open-menu">☰</button>'))).toBe(
      'open-menu'
    );
  });

  it('takes the slugified visible text when nothing above it is present', () => {
    expect(deriveEventName(element('<button>Start Chatting Free</button>'))).toBe(
      'start-chatting-free'
    );
  });
});

describe('deriveEventName and form controls', () => {
  it.each([
    ['an input', '<input id="email" value="someone@example.com" />'],
    ['a textarea', '<textarea id="note">typed text</textarea>'],
    ['a select', '<select id="plan"><option>pro</option></select>'],
    ['an option', '<option id="plan-pro" value="pro">Pro</option>'],
  ])('derives no name from %s, so no typed value can ever become one', (_what, html) => {
    expect(deriveEventName(element(html))).toBeNull();
  });

  it('derives no name from an input even when it carries a data-track override', () => {
    expect(deriveEventName(element('<input data-track="newsletter-email" />'))).toBeNull();
  });
});

describe('deriveEventName fallbacks', () => {
  it('falls through a fragment href to the visible text', () => {
    expect(deriveEventName(element('<a href="#demo">See the demo</a>'))).toBe('see-the-demo');
  });

  it('falls through a mailto href to the visible text', () => {
    expect(deriveEventName(element('<a href="mailto:hello@hushbox.ai">Email us</a>'))).toBe(
      'email-us'
    );
  });

  it('names the site root link by its own path rather than trimming it away', () => {
    expect(deriveEventName(element('<a href="/">Home</a>'))).toBe('link:/');
  });

  it('falls through a protocol-relative href to the visible text', () => {
    expect(deriveEventName(element('<a href="//example.com/docs">Docs</a>'))).toBe('docs');
  });

  it('takes the hostname of an external link served over plain http', () => {
    expect(deriveEventName(element('<a href="http://example.com/a">Docs</a>'))).toBe(
      'link:example.com'
    );
  });

  it('normalises a trailing slash away so one link has one name', () => {
    expect(deriveEventName(element('<a href="/welcome/">Home</a>'))).toBe('link:/welcome');
  });

  it('drops the query and fragment of a same-origin href', () => {
    expect(deriveEventName(element('<a href="/welcome?c=launch#top">Home</a>'))).toBe(
      'link:/welcome'
    );
  });

  it('takes an id verbatim once lower-cased', () => {
    expect(deriveEventName(element('<button id="heroCTA">Go</button>'))).toBe('herocta');
  });

  it('slugifies an authored attribute that is illegal even lower-cased', () => {
    expect(deriveEventName(element('<button data-track="Hero CTA">Go</button>'))).toBe('hero-cta');
  });

  it('caps a name derived from visible text', () => {
    const text = 'word '.repeat(40);
    const name = deriveEventName(element(`<button>${text}</button>`));
    expect(name).not.toBeNull();
    expect((name ?? '').length).toBeLessThanOrEqual(GROWTH_EVENT_TEXT_MAX_LENGTH);
  });

  it('falls through an id that slugifies to nothing rather than yielding no name at all', () => {
    expect(deriveEventName(element('<button id="\u2192">Go</button>'))).toBe('go');
  });

  it('derives no name when every source is empty', () => {
    expect(deriveEventName(element('<button></button>'))).toBeNull();
  });

  it('derives no name when the visible text slugifies to nothing', () => {
    expect(deriveEventName(element('<button>→</button>'))).toBeNull();
  });

  it('derives no name from an element shape whose text content is absent', () => {
    const textless: EventNameElement = {
      tagName: 'span',
      textContent: null,
      getAttribute: () => null,
    };
    expect(deriveEventName(textless)).toBeNull();
  });

  it('derives no name from a link whose path is longer than the event-name bound', () => {
    const long = `/${'a'.repeat(GROWTH_EVENT_NAME_MAX_LENGTH)}`;
    expect(deriveEventName(element(`<a href="${long}"></a>`))).toBeNull();
  });
});

describe('GROWTH_CLICK_SELECTOR', () => {
  /** Every element the selector picks out of `html`, as its tag name and destination. */
  function selected(html: string): string[] {
    const host = document.createElement('div');
    host.innerHTML = html;
    return [...host.querySelectorAll(GROWTH_CLICK_SELECTOR)].map(
      (found) => `${found.tagName.toLowerCase()}:${found.getAttribute('href') ?? ''}`
    );
  }

  it('picks out every link carrying a destination and every button', () => {
    expect(
      selected('<a href="/signup">Start</a><button>Go</button><a href="#demo">Demo</a>')
    ).toEqual(['a:/signup', 'button:', 'a:#demo']);
  });

  it('passes over an anchor with no destination and over a form control', () => {
    expect(selected('<a>Not a link</a><input value="typed" /><textarea></textarea>')).toEqual([]);
  });
});
