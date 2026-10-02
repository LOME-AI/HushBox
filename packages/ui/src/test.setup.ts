import '@testing-library/jest-dom/vitest';
import '@hushbox/shared/test-polyfills';

// This setup loads no stylesheet and vitest's `css` option is left at its
// default `false`, so no Tailwind utility ever reaches a component test's DOM
// and `toBeVisible()` reads a computed style no Tailwind class has touched. (A
// test that needs a real cascade injects its own stylesheet into
// `document.head`; that is deliberate and local to those tests.) A visibility
// class (`sr-only`, `hidden`, `md:flex`, `opacity-0`) is therefore the only
// observable signal a component test has for it, which is why those stay
// written as class assertions while attribute-backed states are asserted
// through the attribute.
