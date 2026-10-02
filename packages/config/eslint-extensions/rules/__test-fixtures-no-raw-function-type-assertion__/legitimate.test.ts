expect(reachable.filter((value) => typeof value === 'function')).toStrictEqual([]);
expect(handler).toHaveBeenCalledWith(expect.any(Function));
expect(typeof rule.name).toBe('string');
expect(caught).toBeInstanceOf(TypeError);
