expect(typeof barrel.encode).toBe();
expect(barrel.encode).toBeInstanceOf();
expect(typeof barrel.encode > 'function').toBe(true);
expect('function' === typeof barrel.encode).toBe(true);

class Probe {
  #run() {}
  go() {
    this.#run();
  }
}

expect(typeof barrel.encode === 'function').toBe();
