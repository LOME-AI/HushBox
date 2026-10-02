/**
 * The showcase's plain-JavaScript document: no framework, it builds its own DOM
 * and races four sorting algorithms.
 */

export const JS_SORTING_LAB = `const algorithms = {
  'Bubble sort': function* bubbleSort(values) {
    for (let end = values.length - 1; end > 0; end -= 1) {
      let swapped = false;
      for (let i = 0; i < end; i += 1) {
        yield ['compare', i, i + 1];
        if (values[i] > values[i + 1]) {
          [values[i], values[i + 1]] = [values[i + 1], values[i]];
          yield ['swap', i, i + 1];
          swapped = true;
        }
      }
      if (!swapped) return;
    }
  },
  'Insertion sort': function* insertionSort(values) {
    for (let i = 1; i < values.length; i += 1) {
      for (let j = i; j > 0; j -= 1) {
        yield ['compare', j - 1, j];
        if (values[j - 1] <= values[j]) break;
        [values[j - 1], values[j]] = [values[j], values[j - 1]];
        yield ['swap', j - 1, j];
      }
    }
  },
  'Selection sort': function* selectionSort(values) {
    for (let i = 0; i < values.length - 1; i += 1) {
      let low = i;
      for (let j = i + 1; j < values.length; j += 1) {
        yield ['compare', low, j];
        if (values[j] < values[low]) low = j;
      }
      if (low !== i) {
        [values[i], values[low]] = [values[low], values[i]];
        yield ['swap', i, low];
      }
    }
  },
  Quicksort: function* quicksort(values, low = 0, high = values.length - 1) {
    if (low >= high) return;
    const pivot = values[high];
    let cut = low;
    for (let i = low; i < high; i += 1) {
      yield ['compare', i, high];
      if (values[i] < pivot) {
        [values[i], values[cut]] = [values[cut], values[i]];
        yield ['swap', i, cut];
        cut += 1;
      }
    }
    [values[cut], values[high]] = [values[high], values[cut]];
    yield ['swap', cut, high];
    yield* quicksort(values, low, cut - 1);
    yield* quicksort(values, cut + 1, high);
  },
};

const BAR_COUNT = 48;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const style = el('style');
style.textContent = \`
  /* height, not min-height: the bars below are sized as a percentage of .track,
     and a percentage height only resolves against a definite containing block.
     With min-height the chain stays indefinite, every bar computes to 0px, and
     the track renders as an empty box. */
  .lab { box-sizing: border-box; height: 100vh; padding: 24px; display: flex;
    flex-direction: column; gap: 14px; color: #e6ecff; font-family: ui-sans-serif, system-ui, sans-serif;
    background: radial-gradient(circle at 15% 0%, #22305c 0%, #0b1020 62%); }
  .lab h1 { margin: 0; font-size: 1.2rem; letter-spacing: 0.01em; }
  .lab p { margin: 0; font-size: 0.85rem; color: #93a4cc; }
  .lab .track { flex: 1; min-height: 200px; display: flex; align-items: flex-end; gap: 2px;
    padding: 10px; border-radius: 14px; background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.09); }
  .lab .bar { flex: 1; border-radius: 3px 3px 0 0; transition: height 90ms linear;
    background: linear-gradient(180deg, #7aa7ff, #3b6fd4); }
  .lab .bar.compare { background: #ffd166; }
  .lab .bar.swap { background: #ef476f; }
  .lab .bar.done { background: #06d6a0; }
  .lab .row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
  .lab button, .lab select, .lab input { font: inherit; color: inherit; cursor: pointer;
    background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.18); }
  .lab button, .lab select { border-radius: 999px; padding: 6px 14px; }
  .lab input[type='range'] { padding: 0; border: 0; background: none; }
  .lab button:hover, .lab select:hover { background: rgba(255, 255, 255, 0.16); }
  .lab .stats { display: flex; flex-wrap: wrap; gap: 18px; font-size: 0.85rem;
    color: #93a4cc; font-variant-numeric: tabular-nums; }
  .lab .stats b { color: #e6ecff; font-weight: 600; }
\`;

const shell = el('div', 'lab');
const track = el('div', 'track');
const controls = el('div', 'row');
const readout = el('div', 'stats');

const choice = el('select');
for (const name of Object.keys(algorithms)) choice.append(new Option(name, name));
const playButton = el('button', undefined, 'Pause');
const shuffleButton = el('button', undefined, 'Shuffle');
const speed = el('input');
speed.type = 'range';
speed.min = '1';
speed.max = '24';
speed.value = '6';

controls.append(choice, playButton, shuffleButton, el('span', undefined, 'speed'), speed);
shell.append(
  el('h1', undefined, 'Sorting visualiser'),
  el('p', undefined, 'Four algorithms written as generators, stepped one comparison at a time.'),
  track,
  controls,
  readout
);
document.querySelector('#document-root').replaceChildren(style, shell);

let values = [];
let bars = [];
let steps = null;
let marks = new Map();
let comparisons = 0;
let swaps = 0;
let sorted = false;
let timer = 0;

function stat(label, value) {
  const wrap = el('span', undefined, label + ' ');
  wrap.append(el('b', undefined, value));
  return wrap;
}

function report(state) {
  readout.replaceChildren(
    stat('algorithm', choice.value),
    stat('comparisons', String(comparisons)),
    stat('swaps', String(swaps)),
    stat('status', state)
  );
}

function paint() {
  bars.forEach((bar, index) => {
    bar.style.height = String((values[index] / BAR_COUNT) * 100) + '%';
    const mark = sorted ? 'done' : marks.get(index);
    bar.className = mark === undefined ? 'bar' : 'bar ' + mark;
  });
}

function advance() {
  const step = steps.next();
  if (step.done) {
    sorted = true;
    marks = new Map();
    return false;
  }
  const [kind, a, b] = step.value;
  marks = new Map([
    [a, kind],
    [b, kind],
  ]);
  if (kind === 'compare') comparisons += 1;
  else swaps += 1;
  return true;
}

function tick() {
  for (let i = 0; i < Number(speed.value); i += 1) {
    if (!advance()) {
      paint();
      pause();
      report('sorted');
      return;
    }
  }
  paint();
  report('sorting');
  timer = setTimeout(tick, 16);
}

function pause() {
  clearTimeout(timer);
  timer = 0;
  playButton.textContent = 'Play';
}

function play() {
  // Playing a finished run starts a fresh one, so the button is never dead.
  if (sorted) shuffle();
  if (steps === null) steps = algorithms[choice.value](values);
  if (timer !== 0) return;
  playButton.textContent = 'Pause';
  tick();
}

function shuffle() {
  pause();
  values = Array.from({ length: BAR_COUNT }, (unused, index) => index + 1);
  for (let i = values.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [values[i], values[j]] = [values[j], values[i]];
  }
  bars = values.map(() => el('div', 'bar'));
  track.replaceChildren(...bars);
  steps = null;
  marks = new Map();
  comparisons = 0;
  swaps = 0;
  sorted = false;
  paint();
  report('ready');
}

playButton.addEventListener('click', () => {
  if (timer === 0) play();
  else pause();
});
shuffleButton.addEventListener('click', () => {
  shuffle();
  play();
});
choice.addEventListener('change', () => {
  shuffle();
  play();
});

shuffle();
play();`;
