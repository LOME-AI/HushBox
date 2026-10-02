// The brand stylesheets `BrandRoot` imports for their side effects. Both resolve
// to `.css` files the bundler compiles; TypeScript checks that a side-effect
// import names a module, so each specifier is declared here.
declare module '@hushbox/config/tailwind';
declare module '@hushbox/ui/fonts';
