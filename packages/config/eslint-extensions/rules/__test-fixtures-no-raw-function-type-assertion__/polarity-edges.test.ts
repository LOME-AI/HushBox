expect(left === right).toBe(true);
expect(typeof barrel.encode === 'function').toContain(true);
expect(typeof barrel.encode === 'function').toBe(expectedTruth);
