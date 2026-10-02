expect(barrel.encode).toEqual(expect.any(Function));
expect(barrel.encode).toStrictEqual(expect.any(Function));
expect(barrel).toEqual({ handler: expect.any(Function) });
expect(handler).toHaveBeenCalledWith(expect.any(Function));
expect(barrel.encode).not.toEqual(expect.any(Function));
expect(barrel.encode).toEqual(expect.any(String));
