/**
 * The showcase's whole-HTML-page document: Conway's Game of Life on a canvas,
 * with seed patterns and live counters.
 */

export const HTML_LIFE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Game of Life</title>
    <style>
      body {
        margin: 0;
      }
      .life {
        box-sizing: border-box;
        min-height: 100vh;
        padding: 24px;
        display: flex;
        flex-direction: column;
        gap: 14px;
        font-family: ui-sans-serif, system-ui, sans-serif;
        color: #f2f5ff;
        background: radial-gradient(circle at 80% 0%, #123 0%, #08090f 65%);
      }
      .life h1 {
        margin: 0;
        font-size: 1.2rem;
      }
      .life p {
        margin: 0;
        font-size: 0.85rem;
        color: #93a4cc;
      }
      .life canvas {
        width: 100%;
        flex: 1;
        min-height: 220px;
        border-radius: 14px;
        border: 1px solid rgba(255, 255, 255, 0.1);
        background: #05060b;
        image-rendering: pixelated;
        cursor: crosshair;
        touch-action: none;
      }
      .life .row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 10px;
      }
      .life button,
      .life select {
        font: inherit;
        color: inherit;
        cursor: pointer;
        padding: 6px 14px;
        border-radius: 999px;
        border: 1px solid rgba(255, 255, 255, 0.18);
        background: rgba(255, 255, 255, 0.08);
      }
      .life button:hover,
      .life select:hover {
        background: rgba(255, 255, 255, 0.16);
      }
      .life .stats {
        display: flex;
        flex-wrap: wrap;
        gap: 18px;
        font-size: 0.85rem;
        color: #93a4cc;
        font-variant-numeric: tabular-nums;
      }
      .life .stats b {
        color: #f2f5ff;
        font-weight: 600;
      }
    </style>
  </head>
  <body>
    <main class="life">
      <h1>Conway's Game of Life</h1>
      <p>Draw on the grid, pick a seed pattern, and watch the colony run. Cells warm as they age.</p>
      <canvas id="board" width="600" height="360"></canvas>
      <div class="row">
        <button id="toggle" type="button">Pause</button>
        <button id="step" type="button">Step</button>
        <button id="clear" type="button">Clear</button>
        <select id="pattern">
          <option value="gun">Gosper glider gun</option>
          <option value="pulsar">Pulsar</option>
          <option value="pentomino">R-pentomino</option>
          <option value="soup">Random soup</option>
        </select>
      </div>
      <div class="stats">
        <span>generation <b id="generation">0</b></span>
        <span>alive <b id="alive">0</b></span>
        <span>born <b id="born">0</b></span>
        <span>died <b id="died">0</b></span>
      </div>
    </main>
    <script>
      const COLS = 100;
      const ROWS = 60;
      const CELL = 6;
      const canvas = document.getElementById('board');
      const context = canvas.getContext('2d');
      const readouts = {
        generation: document.getElementById('generation'),
        alive: document.getElementById('alive'),
        born: document.getElementById('born'),
        died: document.getElementById('died'),
      };

      // Cell values are ages: 0 is dead, 1 is newborn, higher is a survivor.
      let cells = new Uint16Array(COLS * ROWS);
      let generation = 0;
      let born = 0;
      let died = 0;
      let timer = 0;

      const PATTERNS = {
        gun: [
          [0, 4], [0, 5], [1, 4], [1, 5], [10, 4], [10, 5], [10, 6], [11, 3], [11, 7],
          [12, 2], [12, 8], [13, 2], [13, 8], [14, 5], [15, 3], [15, 7], [16, 4], [16, 5],
          [16, 6], [17, 5], [20, 2], [20, 3], [20, 4], [21, 2], [21, 3], [21, 4], [22, 1],
          [22, 5], [24, 0], [24, 1], [24, 5], [24, 6], [34, 2], [34, 3], [35, 2], [35, 3],
        ],
        pulsar: [
          [2, 0], [3, 0], [4, 0], [8, 0], [9, 0], [10, 0], [0, 2], [5, 2], [7, 2], [12, 2],
          [0, 3], [5, 3], [7, 3], [12, 3], [0, 4], [5, 4], [7, 4], [12, 4], [2, 5], [3, 5],
          [4, 5], [8, 5], [9, 5], [10, 5], [2, 7], [3, 7], [4, 7], [8, 7], [9, 7], [10, 7],
          [0, 8], [5, 8], [7, 8], [12, 8], [0, 9], [5, 9], [7, 9], [12, 9], [0, 10],
          [5, 10], [7, 10], [12, 10], [2, 12], [3, 12], [4, 12], [8, 12], [9, 12], [10, 12],
        ],
        pentomino: [[1, 0], [2, 0], [0, 1], [1, 1], [1, 2]],
      };

      function index(x, y) {
        return ((y + ROWS) % ROWS) * COLS + ((x + COLS) % COLS);
      }

      function seed(name) {
        cells = new Uint16Array(COLS * ROWS);
        generation = 0;
        born = 0;
        died = 0;
        if (name === 'soup') {
          for (let i = 0; i < cells.length; i += 1) cells[i] = Math.random() < 0.3 ? 1 : 0;
        } else {
          // An unknown name (the Clear button) seeds nothing, leaving an empty grid.
          const shape = PATTERNS[name] ?? [];
          const offsetX = Math.floor((COLS - Math.max(1, ...shape.map(([x]) => x + 1))) / 2);
          const offsetY = Math.floor((ROWS - Math.max(1, ...shape.map(([, y]) => y + 1))) / 2);
          for (const [x, y] of shape) cells[index(x + offsetX, y + offsetY)] = 1;
        }
        draw();
      }

      function neighbours(x, y) {
        let count = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0) continue;
            if (cells[index(x + dx, y + dy)] > 0) count += 1;
          }
        }
        return count;
      }

      function advance() {
        const next = new Uint16Array(cells.length);
        for (let y = 0; y < ROWS; y += 1) {
          for (let x = 0; x < COLS; x += 1) {
            const at = index(x, y);
            const age = cells[at];
            const live = neighbours(x, y);
            if (age > 0 && (live === 2 || live === 3)) next[at] = Math.min(age + 1, 400);
            else if (age === 0 && live === 3) {
              next[at] = 1;
              born += 1;
            } else if (age > 0) died += 1;
          }
        }
        cells = next;
        generation += 1;
        draw();
      }

      function draw() {
        context.fillStyle = '#05060b';
        context.fillRect(0, 0, canvas.width, canvas.height);
        let alive = 0;
        for (let y = 0; y < ROWS; y += 1) {
          for (let x = 0; x < COLS; x += 1) {
            const age = cells[index(x, y)];
            if (age === 0) continue;
            alive += 1;
            const heat = Math.min(age, 24) / 24;
            const hue = 190 - heat * 150;
            context.fillStyle = 'hsl(' + hue + ' 90% ' + (54 + heat * 12) + '%)';
            context.fillRect(x * CELL, y * CELL, CELL - 1, CELL - 1);
          }
        }
        readouts.generation.textContent = String(generation);
        readouts.alive.textContent = String(alive);
        readouts.born.textContent = String(born);
        readouts.died.textContent = String(died);
      }

      function stop() {
        clearInterval(timer);
        timer = 0;
        document.getElementById('toggle').textContent = 'Play';
      }

      function start() {
        if (timer !== 0) return;
        timer = setInterval(advance, 90);
        document.getElementById('toggle').textContent = 'Pause';
      }

      function paintAt(event) {
        const bounds = canvas.getBoundingClientRect();
        const x = Math.floor(((event.clientX - bounds.left) / bounds.width) * COLS);
        const y = Math.floor(((event.clientY - bounds.top) / bounds.height) * ROWS);
        cells[index(x, y)] = 1;
        draw();
      }

      canvas.addEventListener('pointerdown', (event) => {
        canvas.setPointerCapture(event.pointerId);
        paintAt(event);
      });
      canvas.addEventListener('pointermove', (event) => {
        if (event.buttons === 1) paintAt(event);
      });
      document.getElementById('toggle').addEventListener('click', () => {
        if (timer === 0) start();
        else stop();
      });
      document.getElementById('step').addEventListener('click', () => {
        stop();
        advance();
      });
      document.getElementById('clear').addEventListener('click', () => {
        stop();
        seed('clear');
      });
      document.getElementById('pattern').addEventListener('change', (event) => {
        seed(event.target.value);
        start();
      });

      seed('gun');
      start();
    </script>
  </body>
</html>`;
