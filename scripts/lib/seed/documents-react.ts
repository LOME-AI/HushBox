/**
 * The showcase's React documents: one that renders, and the two written to fail
 * — the first at transpile, the second while mounting — so the panel's two
 * failure cards both have a source.
 */

export const REACT_BUDGET = `import { useEffect, useMemo, useReducer, useState } from 'react';
import confetti from 'canvas-confetti';

const CATEGORIES = [
  { id: 'infra', label: 'Infrastructure', colour: '#7aa7ff' },
  { id: 'tools', label: 'Tooling', colour: '#ffd166' },
  { id: 'people', label: 'Contractors', colour: '#ef476f' },
  { id: 'growth', label: 'Growth', colour: '#06d6a0' },
];

const STARTING_ENTRIES = [
  { id: 1, label: 'Workers + Durable Objects', category: 'infra', amount: 320 },
  { id: 2, label: 'Postgres', category: 'infra', amount: 210 },
  { id: 3, label: 'Design tooling', category: 'tools', amount: 140 },
  { id: 4, label: 'Illustrator, part-time', category: 'people', amount: 900 },
  { id: 5, label: 'Conference booth', category: 'growth', amount: 480 },
];

const STYLES = \`
  .budget { box-sizing: border-box; min-height: 100vh; padding: 24px; display: flex;
    flex-direction: column; gap: 16px; color: #eef2ff; font-family: ui-sans-serif, system-ui, sans-serif;
    background: linear-gradient(160deg, #101728 0%, #0a0d17 70%); }
  .budget h1 { margin: 0; font-size: 1.2rem; }
  .budget .lead { margin: 0; font-size: 0.85rem; color: #94a3c4; }
  .budget .top { display: flex; flex-wrap: wrap; align-items: center; gap: 20px; }
  .budget .donut { width: 150px; height: 150px; }
  .budget .donut-track { fill: none; stroke: rgba(255, 255, 255, 0.07); stroke-width: 14; }
  .budget .donut-slice { fill: none; stroke-width: 14; transition: stroke-dasharray 240ms ease; }
  .budget .donut-value { fill: #eef2ff; font-size: 17px; text-anchor: middle; font-weight: 600; }
  .budget .donut-label { fill: #94a3c4; font-size: 9px; text-anchor: middle; letter-spacing: 0.08em; }
  .budget .tiles { display: flex; flex-wrap: wrap; gap: 12px; }
  .budget .tile { min-width: 120px; padding: 12px 16px; border-radius: 14px;
    border: 1px solid rgba(255, 255, 255, 0.09); background: rgba(255, 255, 255, 0.04);
    display: flex; flex-direction: column; gap: 4px; }
  .budget .tile-label { font-size: 0.7rem; letter-spacing: 0.09em; text-transform: uppercase; color: #94a3c4; }
  .budget .tile-value { font-size: 1.35rem; font-variant-numeric: tabular-nums; }
  .budget .good .tile-value { color: #06d6a0; }
  .budget .bad .tile-value { color: #ef476f; }
  .budget .bars { display: flex; flex-direction: column; gap: 8px; }
  .budget .bar-row { display: grid; grid-template-columns: 130px 1fr 74px; align-items: center;
    gap: 12px; font-size: 0.85rem; }
  .budget .bar-track { height: 8px; border-radius: 99px; background: rgba(255, 255, 255, 0.07); }
  .budget .bar-fill { height: 100%; border-radius: 99px; transition: width 240ms ease; }
  .budget .amount { text-align: right; font-variant-numeric: tabular-nums; color: #94a3c4; }
  .budget form, .budget .slider { display: flex; flex-wrap: wrap; align-items: center; gap: 10px;
    font-size: 0.85rem; color: #94a3c4; }
  .budget input, .budget select, .budget button { font: inherit; color: #eef2ff;
    background: rgba(255, 255, 255, 0.07); border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 10px; padding: 7px 12px; }
  .budget input[type='range'] { padding: 0; border: 0; background: none; flex: 1; min-width: 140px; }
  .budget button { cursor: pointer; border-radius: 999px; }
  .budget button:disabled { opacity: 0.45; cursor: not-allowed; }
  .budget ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .budget li { display: grid; grid-template-columns: 10px 1fr auto auto 28px; align-items: center;
    gap: 12px; padding: 9px 12px; border-radius: 12px; background: rgba(255, 255, 255, 0.04);
    font-size: 0.85rem; }
  .budget .dot { width: 10px; height: 10px; border-radius: 99px; }
  .budget .muted { color: #94a3c4; font-size: 0.78rem; }
  .budget .ghost { padding: 2px 8px; background: none; border: 0; color: #94a3c4; font-size: 1rem; }
  .budget .ghost:hover { color: #ef476f; }
\`;

function money(value) {
  return '$' + Math.round(value).toLocaleString('en-US');
}

function categoryOf(id) {
  return CATEGORIES.find((category) => category.id === id) ?? CATEGORIES[0];
}

function entriesReducer(entries, action) {
  if (action.type === 'add') return [...entries, { ...action.entry, id: Date.now() }];
  if (action.type === 'remove') return entries.filter((entry) => entry.id !== action.id);
  return entries;
}

function Donut({ slices, total }) {
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  let travelled = 0;
  return (
    <svg viewBox="0 0 140 140" className="donut" role="img" aria-label="Spend by category">
      <circle className="donut-track" cx="70" cy="70" r={radius} />
      <g transform="rotate(-90 70 70)">
        {slices.map((slice) => {
          const length = total === 0 ? 0 : (slice.amount / total) * circumference;
          const offset = travelled;
          travelled += length;
          return (
            <circle
              key={slice.id}
              className="donut-slice"
              cx="70"
              cy="70"
              r={radius}
              stroke={slice.colour}
              strokeDasharray={length + ' ' + (circumference - length)}
              strokeDashoffset={-offset}
            />
          );
        })}
      </g>
      <text className="donut-value" x="70" y="70">
        {money(total)}
      </text>
      <text className="donut-label" x="70" y="86">
        PER MONTH
      </text>
    </svg>
  );
}

function Tile({ label, value, tone }) {
  return (
    <div className={'tile ' + tone}>
      <span className="tile-label">{label}</span>
      <strong className="tile-value">{value}</strong>
    </div>
  );
}

function EntryForm({ onAdd }) {
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState(CATEGORIES[0].id);
  const ready = label.trim().length > 0 && Number(amount) > 0;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        onAdd({ label: label.trim(), amount: Number(amount), category });
        setLabel('');
        setAmount('');
      }}
    >
      <input
        value={label}
        placeholder="New line item"
        onChange={(event) => setLabel(event.target.value)}
      />
      <input
        value={amount}
        type="number"
        min="1"
        placeholder="0"
        onChange={(event) => setAmount(event.target.value)}
      />
      <select value={category} onChange={(event) => setCategory(event.target.value)}>
        {CATEGORIES.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
      <button type="submit" disabled={!ready}>
        Add
      </button>
    </form>
  );
}

export default function Runway() {
  const [entries, dispatch] = useReducer(entriesReducer, STARTING_ENTRIES);
  const [budget, setBudget] = useState(1800);

  const total = useMemo(
    () => entries.reduce((sum, entry) => sum + entry.amount, 0),
    [entries]
  );
  const slices = useMemo(
    () =>
      CATEGORIES.map((category) => ({
        ...category,
        amount: entries
          .filter((entry) => entry.category === category.id)
          .reduce((sum, entry) => sum + entry.amount, 0),
      })).filter((slice) => slice.amount > 0),
    [entries]
  );

  const remaining = budget - total;
  const withinBudget = remaining >= 0;

  // Fires only on the crossing, and the seeded month starts over budget — so the
  // celebration belongs to something the reader did, never to the first paint.
  useEffect(() => {
    if (!withinBudget) return;
    confetti({ particleCount: 130, spread: 72, origin: { y: 0.65 } });
  }, [withinBudget]);

  return (
    <main className="budget">
      <style>{STYLES}</style>
      <h1>Monthly run-rate</h1>
      <p className="lead">
        Drop a line item, move the budget, and the whole board recomputes. Land under budget for a
        small celebration.
      </p>

      <div className="top">
        <Donut slices={slices} total={total} />
        <div className="tiles">
          <Tile label="spending" value={money(total)} tone="calm" />
          <Tile label="budget" value={money(budget)} tone="calm" />
          <Tile
            label={withinBudget ? 'left over' : 'over budget'}
            value={money(Math.abs(remaining))}
            tone={withinBudget ? 'good' : 'bad'}
          />
        </div>
      </div>

      <div className="bars">
        {slices.map((slice) => (
          <div className="bar-row" key={slice.id}>
            <span>{slice.label}</span>
            <div className="bar-track">
              <div
                className="bar-fill"
                style={{
                  width: (total === 0 ? 0 : (slice.amount / total) * 100) + '%',
                  background: slice.colour,
                }}
              />
            </div>
            <span className="amount">{money(slice.amount)}</span>
          </div>
        ))}
      </div>

      <label className="slider">
        budget
        <input
          type="range"
          min="800"
          max="3200"
          step="50"
          value={budget}
          onChange={(event) => setBudget(Number(event.target.value))}
        />
        <span className="amount">{money(budget)}</span>
      </label>

      <EntryForm onAdd={(entry) => dispatch({ type: 'add', entry })} />

      <ul>
        {entries.map((entry) => (
          <li key={entry.id}>
            <span className="dot" style={{ background: categoryOf(entry.category).colour }} />
            <span>{entry.label}</span>
            <span className="muted">{categoryOf(entry.category).label}</span>
            <span className="amount">{money(entry.amount)}</span>
            <button
              type="button"
              className="ghost"
              aria-label={'Remove ' + entry.label}
              onClick={() => dispatch({ type: 'remove', id: entry.id })}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}`;

export const REACT_COMPILE_ERROR = `const failsToCompileOnPurpose =
  'Broken on purpose: this file is written so the transpiler rejects it.';

const stages = ['parse', 'transpile', 'render'];

export default function Pipeline() {
  return (
    <section>
      <h1>Compile failure, on purpose</h1>
      <p>{failsToCompileOnPurpose}</p>
      <p>Nothing is wrong with the panel: this is the card a bad document should produce.</p>
      <ul>
        {stages.map((stage) => (
          <li key={stage}>{stage}</li>
        ))}
      </ul>
      <footer>
        <small>The element below is never closed, so the file never reaches the renderer.</small>
      <div>
    </section>
  );
}`;

export const REACT_RUNTIME_ERROR = `const failsToMountOnPurpose =
  'Broken on purpose: this file compiles cleanly and throws while mounting.';

const config = {
  title: 'Runtime failure, on purpose',
  theme: { name: 'dawn' },
};

function ThemeBadge() {
  // \`config.palette\` was never defined, so reading \`.accent\` throws on mount.
  return <span style={{ color: config.palette.accent }}>{config.theme.name}</span>;
}

export default function Themed() {
  return (
    <section>
      <h1>{config.title}</h1>
      <p>{failsToMountOnPurpose}</p>
      <p>Nothing is wrong with the panel: this is the card a throwing document should produce.</p>
      <ThemeBadge />
    </section>
  );
}`;
