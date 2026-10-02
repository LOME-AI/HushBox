expect(typeof barrel.encode).toEqual('function');
expect(typeof barrel.encode).toStrictEqual('function');
expect(typeof barrel.encode).toBe(`function`);
expect(barrel.encode).toBeInstanceOf(globalThis.Function);
expect(typeof barrel.encode === 'function').toBe(true);
expect(typeof barrel.encode).not.toBe('function');
expect(barrel.load()).resolves.toBeTypeOf('function');
expect.soft(typeof barrel.encode).toBe('function');
