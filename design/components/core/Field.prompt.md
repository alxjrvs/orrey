One-line: the console is where form-shaped work lives (campaigns, cadence, rosters) — every input gets a Field.

```jsx
<Field label="Interval (weeks)" hint="Anchor may sit in the past.">
  <Input defaultValue="2" />
</Field>
<Field label="Quorum" error="Must be at least the game's minimum.">
  <Input invalid defaultValue="1" />
</Field>
```

Labels are mono caps and terse — the noun, plus a unit in parentheses. Hints are one plain sentence, full stop.
